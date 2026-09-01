// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Drawing the timetable on a Pi: how often, and with what.
 *
 * Both halves here exist because of the same measurement. Rasterising a 1080p timetable takes
 * about 110 ms on a development machine with the bundled fonts loaded, and a 1.4 GHz Cortex-A53
 * is most of an order of magnitude slower — so a Pi 3 may not be able to draw once a second,
 * which is the rate the clock's blinking colon and the mm:ss Iqāmah countdown are designed
 * around. Rather than guess at a rate, the agent measures itself; and rather than fetch a
 * four-megabyte wallpaper every frame, it keeps one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { intervalForRenderMs, RenderCadence, cadenceAdvice, MAX_DUTY, TARGET_INTERVAL_MS } from './cadence';
import { AssetCache, MAX_ASSET_BYTES, retryDelayMs } from './assetCache';

// ── how often to draw ────────────────────────────────────────────────────────

test('a device that can keep up draws at the design rate, and no faster', () => {
  // A Pi 4 or 5, or a 720p timetable on a Pi 3.
  assert.equal(intervalForRenderMs(50), TARGET_INTERVAL_MS);
  assert.equal(intervalForRenderMs(400), TARGET_INTERVAL_MS, '400ms is still inside the duty budget');
  // Faster hardware buys nothing: there is no content that changes more often than once a second.
  assert.equal(intervalForRenderMs(1), TARGET_INTERVAL_MS);
});

test('a device that cannot keep up slows down rather than pegging its processor', () => {
  // The measured worst case: a 1080p timetable on a Pi 3 B+.
  const slow = intervalForRenderMs(900);
  assert.ok(slow > TARGET_INTERVAL_MS, 'it must not try to draw every second');
  assert.ok(900 / slow <= MAX_DUTY + 0.001, `duty ${(900 / slow).toFixed(2)} exceeds the budget`);
});

test('the share of the machine drawing takes is what is actually held constant', () => {
  // The property that matters: whatever the hardware, there is headroom left for ffmpeg to
  // decode a camera and for the network to be answered.
  for (const ms of [100, 250, 500, 900, 1500, 3000]) {
    const duty = ms / intervalForRenderMs(ms);
    assert.ok(duty <= MAX_DUTY + 0.001, `${ms}ms -> duty ${duty.toFixed(2)}`);
  }
});

test('even a very slow device still updates', () => {
  // A frozen clock is worse than a slow one: it looks broken rather than sluggish.
  assert.ok(intervalForRenderMs(60_000) <= 10_000);
});

test('a nonsense measurement does not change the rate', () => {
  for (const bad of [0, -5, NaN, Infinity]) assert.equal(intervalForRenderMs(bad), TARGET_INTERVAL_MS);
});

test('the interval is rounded, so the colon blink does not jitter with every frame', () => {
  // An interval that wandered by a few milliseconds a frame would make the blink irregular,
  // which reads as a fault rather than as a slow device.
  for (const ms of [500, 501, 502, 503]) assert.equal(intervalForRenderMs(ms) % 250, 0);
});

test('one slow frame does not permanently slow the screen down', () => {
  // Garbage collection, or the SD card being read. Letting a hiccup halve the frame rate for
  // good would be a permanent penalty for a momentary problem.
  const c = new RenderCadence();
  for (let i = 0; i < 8; i++) c.record(100);
  c.record(4000);
  assert.equal(c.intervalMs(), TARGET_INTERVAL_MS, 'the median ignores the outlier');
});

test('a genuinely slower device does move the rate', () => {
  const c = new RenderCadence();
  for (let i = 0; i < 9; i++) c.record(900);
  assert.ok(c.intervalMs() > TARGET_INTERVAL_MS);
});

test('the rate follows the device when the timetable changes underneath it', () => {
  // Switching a screen from 1080p to 720p roughly halves the work; the agent should speed back
  // up on its own rather than staying slow until it is restarted.
  const c = new RenderCadence();
  for (let i = 0; i < 9; i++) c.record(1200);
  assert.ok(c.intervalMs() > TARGET_INTERVAL_MS);
  for (let i = 0; i < 9; i++) c.record(120);
  assert.equal(c.intervalMs(), TARGET_INTERVAL_MS);
});

test('one frame is not a measurement', () => {
  const c = new RenderCadence();
  assert.equal(c.settled(), false);
  c.record(100);
  assert.equal(c.settled(), false);
  c.record(100);
  c.record(100);
  assert.equal(c.settled(), true);
});

test('a screen that has been slowed down says so, and says what to do about it', () => {
  // A screen quietly updating every three seconds looks BROKEN to whoever walks past it, and
  // the fix is one click in a place they would never think to look.
  assert.equal(cadenceAdvice(1000, '1080p'), null, 'nothing to say when it is keeping up');
  const advice = cadenceAdvice(2500, '1080p');
  assert.ok(advice?.includes('720p'), 'the advice has to name the fix');
  assert.ok(advice?.includes('2.5s'));
  // Already at 720p: there is no cheaper setting to suggest, so do not suggest one.
  assert.ok(!cadenceAdvice(2500, '720p')?.includes('720p would'));
});

// ── what it draws with ───────────────────────────────────────────────────────

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omd-pi-cache-'));
}

const PNG_1PX = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
  'hex',
);

const okFetch = (body: Buffer, headers: Record<string, string> = {}) =>
  (async () =>
    ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    }) as unknown as Response) as unknown as typeof fetch;

test('an image is fetched once and then kept', async () => {
  const dir = tmpdir();
  let calls = 0;
  const cache = new AssetCache(dir, (async (...args: unknown[]) => {
    calls++;
    return (await (okFetch(PNG_1PX) as (...a: unknown[]) => Promise<Response>)(...args)) as Response;
  }) as unknown as typeof fetch);

  const first = await cache.dataUri('http://s/pi/t/asset/bg.png');
  const second = await cache.dataUri('http://s/pi/t/asset/bg.png');
  assert.ok(first?.startsWith('data:image/png;base64,'));
  assert.equal(second, first);
  assert.equal(calls, 1, 'a wallpaper refetched every frame would cost more than the video stream does');
});

test('a cached image survives a restart, which is how a screen comes back with no internet', async () => {
  const dir = tmpdir();
  const url = 'http://s/pi/t/asset/bg.png';
  await new AssetCache(dir, okFetch(PNG_1PX)).dataUri(url);

  // A fresh process, and a network that now refuses everything.
  const offline = new AssetCache(dir, (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch);
  assert.ok((await offline.dataUri(url))?.startsWith('data:image/png'), 'the last background it drew is on the card');
});

test('the type is sniffed from the bytes, not believed from the header', async () => {
  // resvg picks its decoder from the label, so a PNG announced as a JPEG renders as nothing at
  // all — silently, on a screen in a hall.
  const cache = new AssetCache(tmpdir(), okFetch(PNG_1PX, { 'content-type': 'image/jpeg' }));
  assert.ok((await cache.dataUri('http://s/a.png'))?.startsWith('data:image/png;base64,'));
});

test('something that is not a renderable image is refused', async () => {
  const cache = new AssetCache(tmpdir(), okFetch(Buffer.from('<html>not an image</html>')));
  assert.equal(await cache.dataUri('http://s/a'), null);
});

test('a WebP is refused, because the renderer cannot decode one', async () => {
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  const cache = new AssetCache(tmpdir(), okFetch(webp));
  assert.equal(await cache.dataUri('http://s/a.webp'), null);
});

test('an oversized asset cannot fill the SD card', async () => {
  const cache = new AssetCache(tmpdir(), okFetch(PNG_1PX, { 'content-length': String(MAX_ASSET_BYTES + 1) }));
  assert.equal(await cache.dataUri('http://s/huge.png'), null);
});

/**
 * How long a failure costs, which is the difference between a bug and a wallpaper.
 *
 * This was a flat five minutes, and the number had been chosen against the wrong failure. The one
 * that actually happens is not "this URL is wrong", it is "the first fetch after a restart lost a
 * race" — the network still settling, the server still coming up, a Wi-Fi association half made.
 *
 * The background is the FIRST asset the agent asks for, so it is the one that eats that race, and
 * a flat five minutes meant the most visible thing on the screen was missing for five minutes while
 * the logo and every announcement image — asked for afterwards, once the network was up — arrived
 * immediately. Measured on a real Pi 4: logo and three announcement images cached at 21:44, the
 * background at 21:49, and in between, a screen showing the themed scene while the dashboard
 * insisted a wallpaper was set. It read exactly as "the custom background does not work".
 */
test('a transient failure costs seconds, not minutes', () => {
  assert.ok(retryDelayMs(1) <= 10_000, `first retry after ${retryDelayMs(1)}ms is too long to wait for a wallpaper`);
  assert.ok(retryDelayMs(1) >= 1_000, 'and not so soon that it is a request per frame');
});

test('a URL that is genuinely wrong still settles down', () => {
  // The other half: doubling has to end somewhere, or a screen left running for a week would be
  // asking about a deleted image once an hour and then once a day.
  assert.equal(retryDelayMs(2), retryDelayMs(1) * 2, 'it doubles');
  assert.equal(retryDelayMs(20), retryDelayMs(21), 'and then it stops doubling');
  assert.ok(retryDelayMs(99) <= 5 * 60_000, 'capped at the old flat interval, which was fine as a CEILING');
});

test('a failure is reported, because a background that never arrives said nothing at all', () => {
  // The whole reason this took a framebuffer capture and a directory listing to diagnose: the
  // fetch failed silently, so the journal the dashboard collects had not one line about it.
  const said: string[] = [];
  const cache = new AssetCache(tmpdir(), (async () => {
    throw new Error('socket hang up');
  }) as unknown as typeof fetch, (m) => said.push(m));
  return cache.dataUri('http://s/pi/SECRETTOKEN/asset/bg.jpg').then(() => {
    assert.equal(said.length, 1);
    assert.match(said[0], /bg\.jpg/, 'it has to name which asset');
    assert.match(said[0], /socket hang up/, 'and why');
    assert.match(said[0], /retrying in/, 'and when it will try again');
    assert.ok(!said[0].includes('SECRETTOKEN'), 'the device token has no business in a log line');
  });
});

test('a failed fetch is not retried on every single frame', async () => {
  let calls = 0;
  const cache = new AssetCache(tmpdir(), (async () => {
    calls++;
    throw new Error('nope');
  }) as unknown as typeof fetch);
  for (let i = 0; i < 5; i++) await cache.dataUri('http://s/missing.png');
  assert.equal(calls, 1, 'a missing asset must not become a request per frame, forever');
});

test('the cache filename gives away nothing, because the URL carries the device token', async () => {
  const dir = tmpdir();
  const cache = new AssetCache(dir, okFetch(PNG_1PX));
  await cache.dataUri('http://s/pi/SUPERSECRETTOKEN/asset/bg.png');
  const names = fs.readdirSync(dir);
  assert.equal(names.length, 1);
  assert.ok(!names[0].includes('SUPERSECRETTOKEN'), 'the token has no business being a filename');
  assert.match(names[0], /^[0-9a-f]{32}$/);
});

test('assets the timetable no longer refers to are cleaned up', async () => {
  // Otherwise the card accumulates every wallpaper the masjid has ever used.
  const dir = tmpdir();
  const cache = new AssetCache(dir, okFetch(PNG_1PX));
  await cache.dataUri('http://s/old.png');
  await cache.dataUri('http://s/new.png');
  assert.equal(fs.readdirSync(dir).length, 2);

  cache.prune(['http://s/new.png']);
  assert.equal(fs.readdirSync(dir).length, 1);
  // And the surviving one is still usable without going back to the network.
  const offline = new AssetCache(dir, (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch);
  assert.ok(await offline.dataUri('http://s/new.png'));
  assert.equal(await offline.dataUri('http://s/old.png'), null);
});
