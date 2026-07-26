// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The node's asset cache. The hash check is the important one: it is both the cache key and
 * the integrity check that makes fetching a photo over plain http on a LAN acceptable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AssetCache, originFromWsUrl } from './assetCache';
import type { AssetRef } from '../../../packages/protocol/src/index';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // a PNG header is enough
const SHA = crypto.createHash('sha256').update(PNG).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'omd-assets-'));

const ref = (over: Partial<AssetRef> = {}): AssetRef => ({ id: 'bg', sha256: SHA, url: '/api/node/assets/' + SHA, ...over });

/** A fetch stand-in that records calls and serves fixed bytes. */
function fakeFetch(body: Buffer | null, status = 200) {
  const calls: Array<{ url: string; auth: string }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: headers.authorization ?? '' });
    if (!body) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const make = (dir: string, f: ReturnType<typeof fakeFetch>) =>
  new AssetCache({ dir, origin: 'http://ctl.local:7860', token: 'a'.repeat(64), serial: 'abc123', fetchImpl: f.impl });

test('an asset is fetched once, then served from disk', async () => {
  const dir = tmp();
  const f = fakeFetch(PNG);
  try {
    const cache = make(dir, f);
    const got = await cache.ensure([ref()]);
    assert.equal(got.get('bg'), SHA);
    assert.equal(f.calls.length, 1);
    assert.ok(cache.has(SHA));
    assert.deepEqual(cache.read(SHA), PNG);

    // A re-push of the same timetable must cost zero bytes.
    const again = await cache.ensure([ref()]);
    assert.equal(again.get('bg'), SHA);
    assert.equal(f.calls.length, 1, 'no second fetch for a hash already on disk');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the request carries the bearer token, the serial, and resolves a PATH against the origin', async () => {
  const dir = tmp();
  const f = fakeFetch(PNG);
  try {
    await make(dir, f).ensure([ref()]);
    const call = f.calls[0];
    assert.match(call.url, /^http:\/\/ctl\.local:7860\/api\/node\/assets\//, 'a path must resolve against the controller origin');
    assert.match(call.url, /serial=abc123/, 'the controller needs the serial to check one scrypt hash, not every node');
    assert.equal(call.auth, `Bearer ${'a'.repeat(64)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an absolute URL is used as-is (the protocol permits either)', async () => {
  const dir = tmp();
  const f = fakeFetch(PNG);
  try {
    await make(dir, f).ensure([ref({ url: 'https://elsewhere.example/a/b' })]);
    assert.match(f.calls[0].url, /^https:\/\/elsewhere\.example\/a\/b\?serial=/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bytes that do not match the hash are REJECTED, not cached', async () => {
  // The whole cache is keyed on the hash, so writing mismatched bytes would poison that slot
  // permanently — and on a read-only-rootfs box, clearing it needs a card reader.
  const dir = tmp();
  const f = fakeFetch(Buffer.from('not the right bytes'));
  try {
    const cache = make(dir, f);
    const got = await cache.ensure([ref()]);
    assert.equal(got.size, 0, 'the slot must be left empty');
    assert.equal(cache.has(SHA), false, 'nothing may be written under a hash it does not match');
    assert.deepEqual(fs.readdirSync(dir), [], 'and no temp file may be left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed fetch leaves the slot empty rather than throwing', async () => {
  const dir = tmp();
  try {
    const cache = make(dir, fakeFetch(null));
    const got = await cache.ensure([ref()]);
    assert.equal(got.size, 0);
    assert.equal(cache.read(SHA), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed hash in a ref is ignored', async () => {
  const dir = tmp();
  const f = fakeFetch(PNG);
  try {
    const got = await make(dir, f).ensure([ref({ sha256: 'nope' }), ref({ sha256: 'A'.repeat(64) })]);
    assert.equal(got.size, 0);
    assert.equal(f.calls.length, 0, 'a bad hash must not even be requested');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two slots sharing the same image download it once', async () => {
  const dir = tmp();
  const f = fakeFetch(PNG);
  try {
    const got = await make(dir, f).ensure([ref({ id: 'bg' }), ref({ id: 'logo' })]);
    assert.equal(got.get('bg'), SHA);
    assert.equal(got.get('logo'), SHA);
    assert.equal(f.calls.length, 1, 'the same content is one transfer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prune keeps what is in use and clears the rest, including temp files', async () => {
  // Without this, every wallpaper a masjid ever tried accumulates until the card is full.
  const dir = tmp();
  try {
    const cache = make(dir, fakeFetch(PNG));
    await cache.ensure([ref()]);
    const stale = 'b'.repeat(64);
    fs.writeFileSync(path.join(dir, stale), 'old');
    fs.writeFileSync(path.join(dir, `${'c'.repeat(64)}.tmp`), 'interrupted');
    fs.writeFileSync(path.join(dir, 'not-a-hash.txt'), 'leave me');

    cache.prune([SHA]);
    assert.ok(cache.has(SHA), 'the in-use asset stays');
    assert.equal(fs.existsSync(path.join(dir, stale)), false, 'an unreferenced asset goes');
    assert.equal(fs.existsSync(path.join(dir, `${'c'.repeat(64)}.tmp`)), false, 'a power-cut temp file goes');
    assert.equal(fs.existsSync(path.join(dir, 'not-a-hash.txt')), true, 'unrelated files are left alone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an oversized asset is refused (the board has 512 MB)', async () => {
  const dir = tmp();
  const huge = Buffer.alloc(9 * 1024 * 1024, 1);
  try {
    const cache = make(dir, fakeFetch(huge));
    const got = await cache.ensure([ref({ sha256: crypto.createHash('sha256').update(huge).digest('hex') })]);
    assert.equal(got.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with no controller origin nothing is attempted', async () => {
  const dir = tmp();
  const f = fakeFetch(PNG);
  try {
    const cache = new AssetCache({ dir, origin: '', token: 'a'.repeat(64), serial: 's', fetchImpl: f.impl });
    assert.equal((await cache.ensure([ref()])).size, 0);
    assert.equal(f.calls.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the controller origin is derived from the adoption wsUrl', () => {
  // The node already knows one address that reaches its controller — the one it dials — so
  // asset URLs need not depend on the controller guessing its own address.
  assert.equal(originFromWsUrl('ws://192.168.1.10:7860/ws/node'), 'http://192.168.1.10:7860');
  assert.equal(originFromWsUrl('wss://masjid.org/ws/node'), 'https://masjid.org');
  // A tunnel prefix in the ws path must NOT leak into the origin, or asset paths (which
  // carry their own prefix) would have it applied twice.
  assert.equal(originFromWsUrl('wss://masjid.org/display/ws/node'), 'https://masjid.org');
  assert.equal(originFromWsUrl('not a url'), '');
});
