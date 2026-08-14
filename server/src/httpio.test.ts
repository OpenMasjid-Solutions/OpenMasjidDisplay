// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { readJsonBody, SECURITY_HEADERS } from './httpio';

/** A fake request that emits exactly the chunks given — the point of every test here is
 *  WHERE the chunk boundaries fall, so they must be controlled, not left to the socket. */
function reqOf(chunks: Buffer[]): IncomingMessage {
  const r = Readable.from(chunks) as unknown as IncomingMessage;
  // readJsonBody calls req.destroy() on an over-size body; Readable has it already.
  return r;
}

test('a body arriving in one chunk parses', async () => {
  const body = await readJsonBody(reqOf([Buffer.from('{"a":1}')]), 1000);
  assert.deepEqual(body, { a: 1 });
});

test('an empty body is an empty object, not a parse error', async () => {
  assert.deepEqual(await readJsonBody(reqOf([]), 1000), {});
});

test('invalid JSON rejects', async () => {
  await assert.rejects(() => readJsonBody(reqOf([Buffer.from('{nope')]), 1000), /invalid JSON/);
});

test('a body over the cap rejects', async () => {
  await assert.rejects(() => readJsonBody(reqOf([Buffer.from('x'.repeat(200))]), 100), /too large/);
});

// The bug this file exists for.
//
// Chunks used to be decoded independently and concatenated as strings, so a multi-byte
// UTF-8 sequence split across a chunk boundary was decoded as two invalid halves and became
// U+FFFD in both — one character silently corrupted, permanently, in the stored data.
// Node's default read buffer is 64 KB and a timetable body carrying Arabic hadith text or
// Urdu labels goes well past that, so it took nothing exotic to hit.
test('a multi-byte character split across chunks survives intact', async () => {
  const json = JSON.stringify({ masjidName: 'مسجد المدينة', note: 'ﷺ' });
  const bytes = Buffer.from(json, 'utf8');

  // Split at EVERY byte offset: whichever seam the socket happens to land on, the decoded
  // body must be byte-identical to what was sent.
  for (let cut = 1; cut < bytes.length; cut++) {
    const body = await readJsonBody(reqOf([bytes.subarray(0, cut), bytes.subarray(cut)]), 10_000);
    assert.equal(body.masjidName, 'مسجد المدينة', `split at byte ${cut} mangled the masjid name`);
    assert.equal(body.note, 'ﷺ', `split at byte ${cut} mangled the ligature`);
  }
});

test('the cap counts BYTES received, not decoded characters', async () => {
  // 10 Arabic characters = 20 bytes. A cap of 15 must reject, so the guard still bounds
  // memory ahead of decoding rather than after it.
  const arabic = Buffer.from('ا'.repeat(10), 'utf8');
  assert.equal(arabic.length, 20);
  await assert.rejects(() => readJsonBody(reqOf([arabic]), 15), /too large/);
});

test('the baseline headers are the three the panel relies on', () => {
  assert.equal(SECURITY_HEADERS['x-content-type-options'], 'nosniff');
  assert.equal(SECURITY_HEADERS['referrer-policy'], 'no-referrer');
  // 'self' only — the PUBLIC widget sets its own `frame-ancestors *` and must never be
  // given this one, or a masjid's website could no longer embed it.
  assert.equal(SECURITY_HEADERS['content-security-policy'], "frame-ancestors 'self'");
});
