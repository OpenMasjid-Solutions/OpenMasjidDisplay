// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The sound at Adhan and Iqāmah.
 *
 * Three things are worth pinning, and none of them is "does it make a noise":
 *
 *  - **A screen nobody asked this of must be untouched.** The argument list with the sound off
 *    has to be exactly what it was before this existed — `-an`, one input, no maps — because an
 *    audio track a television cannot cope with is a screen that stops working for a masjid that
 *    changed nothing.
 *  - **The sample arithmetic.** Audio timestamps come from the sample COUNT, so "plays at the
 *    Adhan" means "written at the right sample", and that is arithmetic rather than opinion. It
 *    also has to keep AHEAD of the wall clock: audio that runs dry stalls ffmpeg's muxer, which
 *    stalls the video with it.
 *  - **Which moments.** On a Friday the congregation lines up for Jumu'ah, not for the Dhuhr
 *    Iqāmah that the daily table still shows — a chime for a jamā'ah nobody holds is worse than
 *    no chime at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { SoundTrack, SOUND_RATE, beepPcm, soundEvents, soundOn } from './sound';
import { timetableArgs } from './renderer';
import { normTimetable } from '../validate';
import type { Timetable } from '../types';

const D = { width: 1280, height: 720 };
const TK = { text: 'x', textfile: 't.txt', fontfile: 'f.ttf', speed: 5, prohibited: false, color: '#ffffff' };

const BASE = {
  masjidName: 'Test Masjid',
  latitude: 40.2415,
  longitude: -75.2838,
  timezone: 'America/New_York',
  jumuah: ['13:30', '14:30'],
};
const tt = (over: Record<string, unknown> = {}): Timetable => normTimetable({ ...BASE, ...over }) as Timetable;

/** A sink that remembers how much was written and what the non-silent parts were. */
class Sink extends Writable {
  bytes = 0;
  /** sample offsets at which a non-zero sample was written */
  loud: number[] = [];
  override _write(chunk: Buffer, _enc: string, cb: () => void): void {
    for (let i = 0; i < chunk.length / 2; i++) {
      if (chunk.readInt16LE(i * 2) !== 0) {
        this.loud.push(this.bytes / 2 + i);
        break; // the START of the clip is what matters
      }
    }
    this.bytes += chunk.length;
    cb();
  }
}

// ── the argument list ────────────────────────────────────────────────────────

test('a screen with no sound gets exactly the arguments it always got', () => {
  for (const [ticker, scroll] of [[null, null], [TK, null], [TK, { x: 40, w: 300 }]] as const) {
    const a = timetableArgs(D, 'rtsp://x/y', ticker, D, 4000, scroll, false);
    assert.ok(a.includes('-an'), 'no audio');
    assert.ok(!a.includes('pipe:3'), 'and no second input');
    assert.ok(!a.includes('-map'), 'and nothing is explicitly mapped');
    assert.deepEqual(a, timetableArgs(D, 'rtsp://x/y', ticker, D, 4000, scroll), 'the default is off');
  }
});

test('with sound there is a second input, an encoder, and explicit maps', () => {
  const plain = timetableArgs(D, 'rtsp://x/y', null, D, 4000, null, true);
  assert.ok(!plain.includes('-an'));
  assert.equal(plain[plain.indexOf('pipe:3') - 1], '-i', 'the PCM arrives on fd 3');
  assert.ok(plain.includes(String(SOUND_RATE)), 'at the track rate');
  assert.equal(plain[plain.indexOf('-c:a') + 1], 'aac');
  // Two inputs: automatic stream selection stops being safe, so both are named.
  assert.ok(plain.includes('0:v:0') && plain.includes('1:a:0'));
});

test('the ticker filtergraph names its output so the audio can be mapped beside it', () => {
  // A labelled graph output is what makes the map possible at all — `[vout]` has no stream
  // index to name it by otherwise. ffmpeg 9 was measured to map this correctly WITHOUT the
  // label too; the point of pinning it is the older ffmpeg in the image, which cannot be tried
  // from here, and the ticker-and-reminder shape is the one masjid configuration that would
  // find out the hard way.
  const i = timetableArgs(D, 'rtsp://x/y', TK, D, 4000, { x: 40, w: 300 }, true);
  const graph = i[i.indexOf('-filter_complex') + 1];
  assert.ok(graph.endsWith('[vout]'), 'the graph output is labelled');
  assert.equal(i[i.indexOf('-map') + 1], '[vout]');
  assert.ok(i.includes('1:a:0'));
  // And the plain `-vf` chain must NOT grow a label — there is nothing there to name it to.
  const vf = timetableArgs(D, 'rtsp://x/y', TK, D, 4000, null, true);
  assert.ok(!vf[vf.indexOf('-vf') + 1].includes('[vout]'));
});

// ── the sample clock ─────────────────────────────────────────────────────────

test('the track keeps the audio ahead of the wall clock, and only ahead', () => {
  const s = new Sink();
  const t = new SoundTrack();
  const t0 = 1_000_000;
  t.attach(s, t0);
  for (let ms = 0; ms <= 4000; ms += 250) t.pump(t0 + ms);
  const seconds = t.samplesWritten / SOUND_RATE;
  // 4s of wall clock plus the lead, and nothing beyond it — a track that races ahead would
  // make a clip queued two seconds from now unplaceable.
  assert.ok(seconds >= 4 + SoundTrack.LEAD_MS / 1000 - 0.01, `only ${seconds.toFixed(2)}s written`);
  assert.ok(seconds <= 4 + SoundTrack.LEAD_MS / 1000 + 0.01, `${seconds.toFixed(2)}s is too far ahead`);
  assert.equal(s.bytes / 2, t.samplesWritten, 'every sample counted was actually written');
  assert.deepEqual(s.loud, [], 'and all of it is silence');
});

test('a clip lands at the sample its moment falls on', () => {
  const s = new Sink();
  const t = new SoundTrack();
  const t0 = 1_000_000;
  t.attach(s, t0);
  t.playAt(t0 + 3000, beepPcm());
  for (let ms = 0; ms <= 6000; ms += 250) t.pump(t0 + ms);
  assert.equal(s.loud.length, 1, 'played once');
  assert.ok(Math.abs(s.loud[0] - 3 * SOUND_RATE) <= 1, `at ${(s.loud[0] / SOUND_RATE).toFixed(4)}s, not 3s`);
});

test('the same moment asked for twice plays once', () => {
  // The renderer re-scans the day every ten seconds and offers every moment again each time.
  const s = new Sink();
  const t = new SoundTrack();
  const t0 = 1_000_000;
  t.attach(s, t0);
  for (let i = 0; i < 20; i++) t.playAt(t0 + 3000, beepPcm());
  for (let ms = 0; ms <= 6000; ms += 250) t.pump(t0 + ms);
  assert.equal(s.loud.length, 1);
});

test('a moment that has already gone by is dropped, not played late', () => {
  const s = new Sink();
  const t = new SoundTrack();
  const t0 = 1_000_000;
  t.attach(s, t0);
  for (let ms = 0; ms <= 20_000; ms += 250) t.pump(t0 + ms);
  t.playAt(t0 + 3000, beepPcm()); // seventeen seconds too late
  for (let ms = 20_000; ms <= 24_000; ms += 250) t.pump(t0 + ms);
  assert.deepEqual(s.loud, [], 'nothing played');
});

test('a detached track writes nothing', () => {
  const s = new Sink();
  const t = new SoundTrack();
  t.attach(s, 1_000_000);
  t.detach();
  t.playAt(1_003_000, beepPcm());
  t.pump(1_004_000);
  assert.equal(s.bytes, 0);
});

test('the built-in chime is short and is not silence', () => {
  const b = beepPcm();
  const secs = b.length / 2 / SOUND_RATE;
  assert.ok(secs > 0.2 && secs < 1.5, `${secs.toFixed(2)}s`);
  let peak = 0;
  for (let i = 0; i < b.length / 2; i++) peak = Math.max(peak, Math.abs(b.readInt16LE(i * 2)));
  assert.ok(peak > 5000, 'audible');
  assert.ok(peak < 32000, 'and not clipping');
  assert.equal(beepPcm(), b, 'generated once, then reused');
});

// ── which moments ────────────────────────────────────────────────────────────

const FRI = new Date('2026-09-11T12:00:00-04:00'); // a Friday
const THU = new Date('2026-09-10T12:00:00-04:00');

test('nothing is scheduled while both switches are off', () => {
  assert.equal(soundOn(tt()), false);
  assert.deepEqual(soundEvents(tt(), FRI), []);
});

test('Adhan plays for the five calls, and for none of the sun rows', () => {
  const evs = soundEvents(tt({ sound: { adhan: true, iqamah: false }, showSunrise: true, ishraqMinutes: 20 }), THU);
  assert.equal(evs.length, 5, `five calls, got ${evs.length}`);
  assert.ok(evs.every((e) => e.kind === 'adhan'));
  // Sunrise and Ishrāq are display rows: no call is made for either.
  const sorted = [...evs].sort((a, b) => a.at - b.at);
  assert.deepEqual(evs.map((e) => e.at), sorted.map((e) => e.at), 'in the order of the day');
});

test('on a Friday the Iqamah chime follows the Jumu\'ah times, not the Dhuhr row', () => {
  const t = tt({ sound: { adhan: false, iqamah: true } });
  const evs = soundEvents(t, FRI);
  const local = evs.map((e) => new Date(e.at).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false }).slice(0, 5));
  assert.ok(local.includes('13:30') && local.includes('14:30'), `both Jumu'ah: ${local.join(', ')}`);
  // Four daily jamā'āt (Dhuhr is replaced) plus the two Jumu'ah.
  assert.equal(evs.length, 6, local.join(', '));
  assert.ok(evs.every((e) => e.kind === 'iqamah'));
});

test('an Adhan moment is a real instant on the display\'s own day', () => {
  const t = tt({ sound: { adhan: true, iqamah: false } });
  const evs = soundEvents(t, THU);
  const day = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  for (const e of evs) assert.equal(day(e.at), '2026-09-10', `${new Date(e.at).toISOString()} is not on the day being drawn`);
});
