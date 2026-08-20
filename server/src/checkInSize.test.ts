// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The check-in route's size cap, and the store's own bounds, have to be reasoned about together.
 *
 * They were not, and the result was the worst kind of bug: entirely silent, on every device, for as
 * long as the feature had existed. `/pi/<token>/seen` accepted 2,000 bytes while `updateDeviceFacts`
 * was written to store eighty log lines of up to 300 characters each, plus thirty networks — so a
 * realistic check-in measured 9,250 bytes, was rejected, had its socket destroyed, and was answered
 * `200 {ok:true}` by a handler whose `.catch(() => null)` could not tell the difference.
 *
 * Everything the check-in carries went with it: the log, the network facts, the Wi-Fi join verdict,
 * and the agent version — which is what the dashboard uses to decide whether a screen is up to date.
 * It looked correct immediately after a restart, when the log was still short enough to fit, and
 * then quietly stopped. That is why nobody caught it by watching.
 *
 * So this file does not test a number. It tests that the two limits cannot drift apart again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { readJsonBody, BODY_TOO_LARGE } from './httpio';

/** The cap the /seen route actually uses, read from the source so the test cannot go stale. */
function seenCap(): number {
  const src = fs.readFileSync(path.resolve(__dirname, 'api.ts'), 'utf8');
  const m = /const SEEN_MAX_BYTES = ([0-9_]+);/.exec(src);
  assert.ok(m, 'could not find SEEN_MAX_BYTES in api.ts — has it been renamed?');
  return Number(m[1].replace(/_/g, ''));
}

/** The largest body `updateDeviceFacts` is willing to STORE, built from its own documented bounds. */
function maximalBody(): Record<string, unknown> {
  return {
    hostname: 'a'.repeat(64),
    ip: 'a'.repeat(64),
    model: 'a'.repeat(80),
    agentVersion: 'a'.repeat(40),
    // 80 lines, 300 characters each — exactly what updateDeviceFacts slices and truncates to.
    recentLog: Array.from({ length: 80 }, () => 'x'.repeat(300)),
    // 30 networks, each with a full-length SSID.
    networks: Array.from({ length: 30 }, (_, i) => ({
      ssid: 'n'.repeat(32),
      signal: i,
      secured: true,
      active: false,
    })),
    net: { link: 'wifi', ssid: 'n'.repeat(32), signal: 70, radio: true, hasWifi: true },
    wifiResult: { ok: true, detail: 'd'.repeat(200) },
  };
}

test('the check-in route can accept everything the store is willing to keep', () => {
  const size = Buffer.byteLength(JSON.stringify(maximalBody()), 'utf8');
  const cap = seenCap();
  assert.ok(
    size <= cap,
    `the store accepts a ${size}-byte check-in but the route caps at ${cap}. ` +
      'A route cap below the store bound does not protect anything — it silently discards facts the ' +
      'store was built to hold.',
  );
});

test('a realistic check-in is nowhere near the cap', () => {
  // Not the maximum — an ordinary one, of the shape a camera screen actually sends. This is the
  // body that was being dropped in production.
  const body = {
    hostname: 'raspberrypi',
    ip: '192.168.1.142',
    model: 'Raspberry Pi 4 Model B Rev 1.4',
    agentVersion: '0.70.0-dev.41',
    recentLog: Array.from(
      { length: 80 },
      (_, i) => `12:${String(i % 60).padStart(2, '0')}:00 camera: opening rtsps://10.0.0.9:7441/abcdefgh (hardware decoding)`,
    ),
    networks: Array.from({ length: 12 }, (_, i) => ({ ssid: `Masjid Guest ${i}`, signal: 70 - i, secured: true, active: i === 0 })),
    net: { link: 'ethernet', ssid: '', signal: 0, radio: true, hasWifi: true },
  };
  const size = Buffer.byteLength(JSON.stringify(body), 'utf8');
  assert.ok(size <= seenCap(), `an ordinary check-in is ${size} bytes against a cap of ${seenCap()}`);
});

// ── the mechanism that made it invisible ────────────────────────────────────

/** A fake request that emits `body` in one chunk. */
function fakeReq(body: string): IncomingMessage {
  const s = new PassThrough();
  process.nextTick(() => {
    s.write(body);
    s.end();
  });
  return s as unknown as IncomingMessage;
}

test('an oversize body is refused with a code, not just a message', () => {
  // String-matching the message is how this would go wrong next time; the caller needs to answer
  // 413 for "too big" and 400 for "not JSON", and those must be distinguishable.
  return readJsonBody(fakeReq('x'.repeat(500)), 100).then(
    () => assert.fail('an oversize body must be refused'),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, BODY_TOO_LARGE);
    },
  );
});

test('refusing an oversize body does not destroy the request, so a 413 can be sent', () => {
  // Asserted against the SOURCE rather than by observing a stream, and deliberately so: a
  // PassThrough reports `destroyed` after a normal end(), so watching the flag cannot tell our
  // destroy apart from the stream simply finishing. The bug was a specific call, so that call is
  // what this pins.
  //
  // Why it mattered: with the socket destroyed there was nothing left to write a response on, so
  // the caller's `.catch(() => null)` answered 200 to a body it had thrown away. The refusal has to
  // survive long enough to be reported, or it is not a refusal, it is a disappearance.
  // Line endings normalised first: this repo's files are CRLF on disk, and slicing on '\n}\n'
  // silently matched nothing, which made the slice the whole rest of the file.
  const src = fs.readFileSync(path.resolve(__dirname, 'httpio.ts'), 'utf8').split('\r\n').join('\n');
  const fn = src.slice(src.indexOf('export function readJsonBody'));
  const end = fn.indexOf('\n}\n');
  assert.ok(end > 0, 'could not find the end of readJsonBody');
  // Comments stripped before matching. The first version of this assertion failed on the comment
  // that EXPLAINS the removed call — a test that cannot tell code from prose about code is not
  // testing anything, and it would have blocked the very explanation worth keeping.
  const body = fn
    .slice(0, end)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  assert.ok(!/req\.destroy\(\)/.test(body), 'readJsonBody must not destroy the request it is refusing');
  // And it must stop accumulating, or dropping the destroy would have removed the memory bound.
  assert.match(body, /chunks\.length = 0|over = true/, 'it must stop retaining data once over the cap');
});

test('an oversize body stops being buffered, so the cap still bounds memory', async () => {
  // The point of the cap is memory, and removing the destroy must not have removed that. Feed far
  // more than the limit and confirm it is refused rather than accumulated.
  const req = fakeReq('z'.repeat(200_000));
  await readJsonBody(req, 1_000).then(
    () => assert.fail('should have been refused'),
    (e: unknown) => assert.equal((e as { code?: string }).code, BODY_TOO_LARGE),
  );
});

test('a body inside the cap still parses normally', () => {
  return readJsonBody(fakeReq(JSON.stringify({ a: 1 })), 1000).then((v) => assert.deepEqual(v, { a: 1 }));
});

test('a body that is not JSON is refused differently from one that is too big', () => {
  return readJsonBody(fakeReq('not json at all'), 1000).then(
    () => assert.fail('should have been refused'),
    (e: unknown) => {
      assert.notEqual((e as { code?: string }).code, BODY_TOO_LARGE, 'bad JSON is a 400, not a 413');
    },
  );
});
