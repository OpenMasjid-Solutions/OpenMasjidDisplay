// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Adhan and Iqamah each have a sound of their own, and the panel can play either one back.
 *
 * They used to share ONE clip. A timetable stored then names that clip once, and the move gives
 * it to both slots — the same file, so replacing one slot must not delete what the other still
 * plays. That is the failure worth pinning: it would be silent, the screen simply going back to
 * the beep at Iqamah the day someone uploaded a new Adhan.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config reads DATA_DIR at import time, so it is set before anything that reads it loads.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-sound-'));
process.env.DATA_DIR = DIR;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setSoundClip, soundPcmFor, soundWav, beepPcm, SOUND_RATE } = require('./sound') as typeof import('./sound');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normTimetable } = require('../validate') as typeof import('../validate');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Store } = require('../store') as typeof import('../store');
import type { Timetable, TimetableSound } from '../types';

const SOUNDS = path.join(DIR, 'sounds');
fs.mkdirSync(SOUNDS, { recursive: true });

/** A stored clip: one second of a constant sample, so each is recognisable by its bytes. */
function clip(name: string, sample: number): Buffer {
  const pcm = Buffer.alloc(SOUND_RATE * 2);
  for (let i = 0; i < SOUND_RATE; i++) pcm.writeInt16LE(sample, i * 2);
  fs.writeFileSync(path.join(SOUNDS, name), pcm);
  return pcm;
}
const exists = (name: string) => fs.existsSync(path.join(SOUNDS, name));
function timetable(sound: Partial<TimetableSound>): Timetable {
  const t = normTimetable({});
  t.sound = { adhan: true, iqamah: true, adhanClip: '', iqamahClip: '', ...sound };
  return t;
}

test('each slot plays its own clip, and one with none plays the beep', () => {
  const a = clip('t1.adhan.aa.pcm', 1000);
  const t = timetable({ adhanClip: 't1.adhan.aa.pcm' });
  assert.ok(soundPcmFor(t, 'adhan').equals(a));
  assert.equal(soundPcmFor(t, 'iqamah'), beepPcm());
  // A file that has gone is the beep too, never silence.
  assert.equal(soundPcmFor(timetable({ iqamahClip: 'gone.pcm' }), 'iqamah'), beepPcm());
});

test('replacing one slot keeps a file the other still plays, and frees it once neither does', () => {
  clip('shared.pcm', 2000);
  clip('new-adhan.pcm', 3000);
  const s = timetable({ adhanClip: 'shared.pcm', iqamahClip: 'shared.pcm' }).sound;
  setSoundClip(s, 'adhan', 'new-adhan.pcm');
  assert.equal(s.adhanClip, 'new-adhan.pcm');
  assert.ok(exists('shared.pcm'), 'Iqamah still plays it');
  setSoundClip(s, 'iqamah', '');
  assert.equal(s.iqamahClip, '');
  assert.ok(!exists('shared.pcm'), 'nothing names it now');
  assert.ok(exists('new-adhan.pcm'), 'and the Adhan clip is untouched');
});

test('a clip from before the split plays at both Adhan and Iqamah', () => {
  // The one stored shape that predates the two slots: a single `clip`.
  const old = { ...normTimetable({}), sound: { adhan: true, iqamah: true, clip: 'old.pcm' } };
  fs.writeFileSync(path.join(DIR, 'db.json'), JSON.stringify({ version: 1, timetables: [old] }));
  const sound = new Store().db.timetables[0].sound;
  assert.equal(sound.adhanClip, 'old.pcm');
  assert.equal(sound.iqamahClip, 'old.pcm');
  assert.ok(!('clip' in sound), 'and the old field is gone');
});

test('the preview is a WAV of exactly what the stream plays', () => {
  const a = clip('t2.adhan.bb.pcm', 4000);
  for (const [t, slot, pcm] of [
    [timetable({ adhanClip: 't2.adhan.bb.pcm' }), 'adhan', a],
    [timetable({}), 'iqamah', beepPcm()],
  ] as const) {
    const wav = soundWav(t, slot);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ');
    assert.equal(wav.readUInt32LE(4), wav.length - 8, 'RIFF size');
    assert.equal(wav.readUInt16LE(22), 1, 'mono');
    assert.equal(wav.readUInt32LE(24), SOUND_RATE);
    assert.equal(wav.readUInt16LE(34), 16, '16-bit');
    assert.equal(wav.toString('ascii', 36, 40), 'data');
    assert.equal(wav.readUInt32LE(40), pcm.length);
    assert.ok(wav.subarray(44).equals(pcm), `${slot}: the samples themselves`);
  }
});
