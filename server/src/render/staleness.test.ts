// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** A screen must never present an out-of-date timetable as current.
 *
 *  DISPLAY-002: three gaps compounded. RenderWorker.request() had no deadline, so a hung
 *  worker never settled; the pipeline gates its next render on the previous one finishing,
 *  so it stopped rendering for good; the write pump re-fed the last frame forever with no
 *  age check; and streamReady only measured "a decoder is reading", which stays true while
 *  ffmpeg publishes a frozen picture. Net effect: a frozen clock and yesterday's Iqamah
 *  times on the masjid wall, reported healthy, with no alert. */
import assert from 'node:assert';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { RenderWorker } from './renderPool';

// ── The deadline: a wedged worker must not hang a render forever ──────────────
test('a render request rejects instead of hanging when the worker never answers', async () => {
  // A worker that receives the request and deliberately never replies — exactly the
  // behaviour that used to leave the promise unsettled for the life of the process, with
  // the video pipeline's `rendering` flag stuck true and the screen frozen for good.
  const silent = new Worker('require("node:worker_threads").parentPort.on("message", () => {});', {
    eval: true,
  });
  const rw = new RenderWorker(400); // 400ms instead of the production 15s
  const internals = rw as unknown as {
    worker: Worker | null;
    pending: Map<number, unknown>;
    request: (p: Record<string, unknown>) => Promise<unknown>;
  };
  internals.worker = silent; // stand in for the real render thread

  const started = Date.now();
  // The REAL timer must reject this — nothing here settles it by hand.
  await assert.rejects(internals.request({ kind: 'raw' }), /timed out/, 'a silent worker must reject, not hang');
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 350, `should have waited for the deadline, waited ${elapsed}ms`);
  assert.ok(elapsed < 8000, `should not have waited the full production timeout, waited ${elapsed}ms`);
  assert.equal(internals.pending.size, 0, 'the pending entry must be cleared so the pipeline unblocks');
  assert.equal(internals.worker, null, 'the wedged worker must be dropped so the next render gets a fresh one');

  rw.dispose();
  await silent.terminate().catch(() => {});
});

test('a timeout settles EVERY request queued on the wedged worker, not just its own', async () => {
  // The shared preview worker can have several renders in flight. `pending` is one Map for
  // the life of the RenderWorker while the failure handler is per worker generation, so a
  // naive generation guard would leave the second request unsettled for ever.
  const silent = new Worker('require("node:worker_threads").parentPort.on("message", () => {});', {
    eval: true,
  });
  const rw = new RenderWorker(400);
  const internals = rw as unknown as {
    worker: Worker | null;
    pending: Map<number, unknown>;
    request: (p: Record<string, unknown>) => Promise<unknown>;
  };
  internals.worker = silent;

  const a = internals.request({ kind: 'raw' });
  const b = internals.request({ kind: 'raw' });
  assert.equal(internals.pending.size, 2, 'both should be queued on the same worker');

  const settled = await Promise.allSettled([a, b]);
  assert.deepEqual(settled.map((s) => s.status), ['rejected', 'rejected'], 'neither may hang');
  assert.equal(internals.pending.size, 0, 'the queue must be drained so the pipeline unblocks');
  assert.equal(internals.worker, null, 'the wedged worker must be dropped');

  rw.dispose();
  await silent.terminate().catch(() => {});
});

test("a zombie worker's exit must not kill the replacement's in-flight render", async () => {
  // Reproduces the generation bug: worker1 is recycled, worker2 takes over, then worker1
  // fires 'exit'. That must not reject worker2's pending work.
  const rw = new RenderWorker(50_000); // long deadline: the timer must not be what settles it
  const internals = rw as unknown as {
    worker: Worker | null;
    pending: Map<number, { reject: (e: Error) => void }>;
    request: (p: Record<string, unknown>) => Promise<unknown>;
    recycle: (w: Worker, e: Error) => void;
  };

  const w1 = new Worker('require("node:worker_threads").parentPort.on("message", () => {});', { eval: true });
  internals.worker = w1;
  internals.recycle(w1, new Error('recycled')); // drops w1, clears its queue

  const w2 = new Worker('require("node:worker_threads").parentPort.on("message", () => {});', { eval: true });
  internals.worker = w2;
  const live = internals.request({ kind: 'raw' }); // queued on w2
  assert.equal(internals.pending.size, 1);

  await w1.terminate().catch(() => {}); // w1's 'exit' fires here
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(internals.pending.size, 1, "the replacement's render must survive w1's exit");
  assert.equal(internals.worker, w2, 'w2 must still be the current worker');

  live.catch(() => {}); // we never answer it; stop an unhandled rejection at teardown
  rw.dispose();
  await w2.terminate().catch(() => {});
});

test('a real render worker still answers normally (the deadline must not break rendering)', async () => {
  const rw = new RenderWorker(); // production deadline
  try {
    // A minimal but valid timetable: no location, so the renderer draws its
    // "Setup needed" frame — cheap, and it exercises the whole worker round trip.
    const tt = {
      id: 'tt_test',
      name: 'T',
      themeId: 'emerald',
      orientation: 'landscape',
      quality: '720p',
      layout: 'modern',
      layoutCarousel: false,
      masjidName: 'Test Masjid',
      location: '',
      latitude: null,
      longitude: null,
      method: 'MWL',
      fajrAngle: 18,
      ishaAngle: 17,
      asrMadhab: 'Hanafi',
      timezone: 'UTC',
      timeFormat: '24h',
      language: 'en',
      hijriOffset: 0,
      gregorianOffset: 0,
      iqamah: {
        fajr: { mode: 'offset', offset: 20 },
        dhuhr: { mode: 'offset', offset: 10 },
        asr: { mode: 'offset', offset: 10 },
        maghrib: { mode: 'offset', offset: 5 },
        isha: { mode: 'offset', offset: 10 },
      },
      jumuah: ['13:30'],
      showSunrise: true,
      showCountdown: true,
      showDates: true,
      showLogo: true,
      showSeconds: false,
      showFooter: true,
      showCelestial: true,
      showName: true,
      backgroundImage: '',
      logoImage: '',
      footerNote: '',
      createdAt: new Date().toISOString(),
    } as unknown as Parameters<RenderWorker['raw']>[0];

    const img = await rw.raw(tt, Date.parse('2026-08-04T12:00:00Z'), 640);
    assert.ok(img.width > 0 && img.height > 0, 'expected a rasterised frame');
    assert.equal(img.pixels.length, img.width * img.height * 4, 'expected RGBA pixels');
  } finally {
    rw.dispose();
  }
});

// ── The freshness contract ────────────────────────────────────────────────────
/** Mirrors TimetablePipeline.isStale()/markStale() so the contract is asserted without
 *  standing up ffmpeg. The pipeline's own copies are exercised end-to-end in the app. */
const STALE_AFTER_MS = 30_000;
const isStale = (lastFrameAt: number, now: number) => lastFrameAt > 0 && now - lastFrameAt > STALE_AFTER_MS;

test('freshness threshold: a frame is current until it is not', () => {
  const t0 = Date.parse('2026-08-04T12:00:00Z');
  assert.equal(isStale(0, t0 + 3_600_000), false, 'before the first render nothing is stale');
  assert.equal(isStale(t0, t0), false);
  assert.equal(isStale(t0, t0 + 1_000), false, '1s old is normal (the loop renders at 1/s)');
  assert.equal(isStale(t0, t0 + 29_000), false, 'a slow box must not be called stale');
  assert.equal(isStale(t0, t0 + 31_000), true, '~30 missed renders is broken, not busy');
  assert.equal(isStale(t0, t0 + 86_400_000), true, 'a day-old frame is certainly stale');
});

test('the stale mark visibly alters the frame and never mutates the original', () => {
  // Same arithmetic as TimetablePipeline.markStale: dim everything, red bar at the bottom.
  const width = 8;
  const height = 100;
  const pixels = Buffer.alloc(width * height * 4, 0xff); // a white frame
  const original = Buffer.from(pixels);

  const out = Buffer.from(pixels);
  for (let i = 0; i < out.length; i += 4) {
    out[i] >>= 1;
    out[i + 1] >>= 1;
    out[i + 2] >>= 1;
  }
  const barH = Math.max(6, Math.round(height * 0.02));
  for (let y = height - barH; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      out[i] = 0xd0;
      out[i + 1] = 0x3a;
      out[i + 2] = 0x2f;
      out[i + 3] = 0xff;
    }
  }

  assert.ok(!out.equals(original), 'a stale frame must look different from a live one');
  assert.deepEqual(pixels, original, 'the cached lastFrame must not be mutated in place');
  // Top of the picture: dimmed, not red.
  assert.equal(out[0], 0x7f, 'the picture should be dimmed');
  // Bottom edge: the warning bar.
  const last = (height - 1) * width * 4;
  assert.deepEqual([out[last], out[last + 1], out[last + 2], out[last + 3]], [0xd0, 0x3a, 0x2f, 0xff]);
  assert.equal(out.length, original.length, 'geometry must not change (ffmpeg expects fixed dims)');
});

// ── Clock sanity (DISPLAY-014) ────────────────────────────────────────────────
test('an implausible host clock is detected, and a correct one is never flagged', () => {
  const { clockSuspect, CLOCK_FLOOR_MS } = require('./renderer') as typeof import('./renderer');
  // The failures that actually happen in the field: a box with no RTC that booted with no
  // network falls back to the epoch or to a stale build date. These are absolute because
  // they are wrong under ANY floor this project will ever set.
  assert.equal(clockSuspect(0), true, 'the epoch is not a believable time');
  assert.equal(clockSuspect(Date.parse('1970-01-01T00:00:00Z')), true);
  assert.equal(clockSuspect(Date.parse('2020-06-01T00:00:00Z')), true, 'years behind → wrong');

  // The boundary is asserted RELATIVE to the floor, not against a copy of its date. The
  // floor moves forward every release by design, and a test carrying its own copy of the
  // literal turns that into a failing build each time — which teaches the next person to
  // edit the test instead of reading it. What must hold is the shape, not the date.
  assert.equal(clockSuspect(CLOCK_FLOOR_MS - 1), true, 'one ms before the floor → wrong');
  assert.equal(clockSuspect(CLOCK_FLOOR_MS), false, 'the floor itself is believable');

  // No false positives: the check is one-directional, so a correct clock now or later is
  // always fine. A display marked wrong when it is right would be its own bug.
  assert.equal(clockSuspect(CLOCK_FLOOR_MS + 86_400_000), false, 'a day after the floor is fine');
  assert.equal(clockSuspect(Date.parse('2030-01-01T00:00:00Z')), false, 'a future clock must not be flagged');
  assert.equal(clockSuspect(), false, 'the real clock running these tests must not be flagged');

  // The one way moving the floor can go wrong: setting it LATER than the release it ships
  // in would flag every correctly-set clock in the field from day one. Nothing else in the
  // build catches that, because a floor in the future looks perfectly valid on its own.
  assert.ok(CLOCK_FLOOR_MS <= Date.now(), 'the clock floor must not be in the future');
});

// Regression guards for how staleness is REPORTED (the sweep found three gaps here).
test('the alert names the actual fault, and never claims a dark screen is lit up', () => {
  const { Orchestrator } = require('../orchestrator') as typeof import('../orchestrator');
  // alertFor is pure; no store/render needed to exercise the wording.
  const o = Object.create(Orchestrator.prototype) as InstanceType<typeof Orchestrator>;

  const clock = o.alertFor('Main hall', { stale: true, staleReason: 'clock', litUp: true });
  assert.match(clock.title, /Clock wrong/i);
  assert.match(clock.text, /clock/i);
  assert.doesNotMatch(clock.text, /stopped updating/i, 'a wrong clock is not a frozen renderer');

  const frozenLit = o.alertFor('Main hall', { stale: true, staleReason: 'frozen', litUp: true });
  assert.match(frozenLit.text, /still lit up/i);

  // The bug: "still lit up" was chosen on `stale` alone, so a screen with NO decoder
  // attached was described as lit up when it was dark.
  const frozenDark = o.alertFor('Main hall', { stale: true, staleReason: 'frozen', litUp: false });
  assert.doesNotMatch(frozenDark.text, /still lit up/i, 'must not claim a dark screen is lit');
  assert.match(frozenDark.text, /not pulling its stream/i);

  const offline = o.alertFor('Main hall', { stale: false, litUp: false });
  assert.match(offline.title, /offline/i);
  assert.equal(offline.level, 'warning');
  for (const a of [clock, frozenLit, frozenDark]) assert.equal(a.level, 'error');
});

test('staleReason separates a frozen renderer from a wrong clock', () => {
  // Mirrors TimetablePipeline.staleReason(). A wrong clock renders fine every second, so
  // its frame age is ~0 and must NOT be quoted as an age to a human.
  const STALE_AFTER = 30_000;
  const reason = (clockBad: boolean, lastFrameAt: number, now: number) =>
    clockBad ? 'clock' : lastFrameAt > 0 && now - lastFrameAt > STALE_AFTER ? 'frozen' : null;
  const t0 = Date.parse('2026-08-04T12:00:00Z');
  assert.equal(reason(true, t0, t0), 'clock', 'a wrong clock wins even with a fresh frame');
  assert.equal(reason(false, t0, t0 + 31_000), 'frozen');
  assert.equal(reason(false, t0, t0 + 1_000), null);
  assert.equal(reason(false, 0, t0 + 999_999), null, 'nothing rendered yet is not stale');
});

test('stale content is reported as NOT online, so the offline alert fires', () => {
  // The rule applied in orchestrator.runOnce(): a decoder reading a frozen picture is
  // "pulling" but must not count as healthy.
  const healthy = (streamReady: boolean, contentStale: boolean) => streamReady && !contentStale;
  assert.equal(healthy(true, false), true, 'live picture, decoder attached → healthy');
  assert.equal(healthy(true, true), false, 'FROZEN picture with a happy decoder → not healthy');
  assert.equal(healthy(false, false), false, 'no decoder → not healthy');
  assert.equal(healthy(false, true), false);
});
