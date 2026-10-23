// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A sound at Adhan and Iqāmah, carried on the timetable's own RTSP stream.
 *
 * Why it is built this way, because the obvious way does not work: the stream is ONE ffmpeg
 * that has run since the screen came up, and its arguments are fixed for its lifetime. Mixing a
 * sound in at the moment it is wanted would mean restarting ffmpeg — which drops the RTSP
 * stream, at exactly the Adhan. (The scrolling ticker already pays that price, deliberately and
 * rarely; a daily black screen at Maghrib is not the same bargain.)
 *
 * So the stream carries a PERMANENT audio track, fed on a second pipe (`pipe:3`) that this
 * module writes silence into, continuously, and writes the sound into at the right sample. The
 * sample is the point: audio timestamps come from the sample COUNT, so placing a clip at sample
 * `n` places it at `n / 48000` seconds of stream time, to the sample — no seeking, no restart,
 * and the video is never touched. Measured end to end over a real RTSP hop: a clip asked for at
 * t=3.000s arrived at t=3.022s, the 22ms being the receiver's own start offset.
 *
 * The track exists only when a masjid has asked for a sound. With both switches off the ffmpeg
 * arguments are exactly what they have always been, `-an` and all, so no existing screen gains
 * an audio track it has to cope with.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { config } from '../config';
import { buildModel } from './svg';
import { zonedNoon } from '../prayer/engine';
import type { Timetable, TimetableSound } from '../types';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

/** Mono 16-bit at 48 kHz: what the track carries and what a clip is decoded to. 48 kHz
 *  because it is the rate every television's AAC decoder is happiest with. */
export const SOUND_RATE = 48_000;

/**
 * The longest clip we will keep, decoded.
 *
 * shortcut: 180s at 48 kHz mono s16 is ~17 MB, held in memory while it plays and buffered whole
 * into ffmpeg's pipe in one write. Raise this and that buffer grows with it — split the clip
 * across pump() calls first.
 */
export const SOUND_MAX_SECONDS = 180;

/** Upload ceiling for the file a masjid chooses — three minutes of speech at any sane bitrate. */
export const SOUND_MAX_UPLOAD_BYTES = 5_000_000;

const soundsDir = (): string => path.join(config.dataDir, 'sounds');

/** Reject anything that isn't a plain filename (no traversal, no separators). */
function safeName(name: string): string | null {
  const base = path.basename(String(name || ''));
  return base && base !== '.' && base !== '..' && /^[A-Za-z0-9._-]+$/.test(base) ? base : null;
}

/** Does this timetable want a sound at all? This is what decides whether the stream carries an
 *  audio track, so it is also what must be watched for a change that needs ffmpeg respawned. */
export function soundOn(tt: Timetable): boolean {
  return !!tt.sound && (tt.sound.adhan || tt.sound.iqamah);
}

// ── the built-in beep ────────────────────────────────────────────────────────

let chime: Buffer | null = null;

/** How long the built-in beep lasts. */
export const BEEP_SECONDS = 1.5;

/** The sound used when a masjid has not uploaded one: one long beep at 880 Hz, faded in and out
 *  so it does not click. It was two short tones, which a masjid found too easy to miss across a
 *  hall. Generated rather than shipped as a file — a few lines of arithmetic, and no asset we
 *  would have to licence. */
export function beepPcm(): Buffer {
  if (chime) return chime;
  const n = Math.round(SOUND_RATE * BEEP_SECONDS);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const s = i / SOUND_RATE;
    const env = Math.max(0, Math.min(1, s / 0.01, (BEEP_SECONDS - s) / 0.08));
    buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 880 * s) * 11000 * env), i * 2);
  }
  chime = buf;
  return buf;
}

// ── a clip the masjid uploaded ───────────────────────────────────────────────

const clipCache = new Map<string, { pcm: Buffer; mtimeMs: number }>();

/** The decoded clip for a stored filename, or null if it is missing or unreadable. Cached by
 *  modification time — this is read on the path that feeds ffmpeg, not on an upload. */
export function soundClipPcm(file: string): Buffer | null {
  const name = safeName(file);
  if (!name) return null;
  const full = path.join(soundsDir(), name);
  let st: fs.Stats;
  try {
    st = fs.statSync(full);
  } catch {
    return null;
  }
  const hit = clipCache.get(name);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.pcm;
  try {
    const pcm = fs.readFileSync(full);
    clipCache.set(name, { pcm, mtimeMs: st.mtimeMs });
    return pcm;
  } catch {
    return null;
  }
}

/**
 * Decode an uploaded audio file to the raw PCM the track is written in, and store it.
 *
 * Decoding happens ONCE, here, rather than every time the sound plays: an mp3 decoder in the
 * path that has to hit a sample boundary is a decoder that can be slow on the wrong day.
 *
 * `-protocol_whitelist file,pipe` is not ceremony. The input is a file an admin chose, ffmpeg
 * probes it to decide what it is, and several container formats can name an external resource —
 * so the decode is penned in to the one file we handed it.
 */
export async function saveSoundClip(id: string, slot: SoundSlot, data: Buffer): Promise<{ file: string } | { error: string }> {
  const safeId = safeName(id);
  if (!safeId) return { error: 'Unknown timetable.' };
  fs.mkdirSync(soundsDir(), { recursive: true });
  const tmp = path.join(soundsDir(), `.in.${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, data);
    const pcm = await decodeToPcm(tmp);
    if ('error' in pcm) return pcm;
    if (pcm.pcm.length < SOUND_RATE) return { error: 'That file has no sound in it that we could read.' };
    // Nothing is removed here: the file this replaces may still be the OTHER slot's. `setSoundClip`
    // decides that once the new name is in the store.
    const name = `${safeId}.${slot}.${crypto.randomBytes(4).toString('hex')}.pcm`;
    fs.writeFileSync(path.join(soundsDir(), name), pcm.pcm);
    return { file: name };
  } catch (e) {
    return { error: `That file could not be read: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  }
}

function decodeToPcm(file: string): Promise<{ pcm: Buffer } | { error: string }> {
  return new Promise((resolve) => {
    const proc = spawn(
      FFMPEG,
      [
        '-hide_banner', '-loglevel', 'error',
        '-protocol_whitelist', 'file,pipe',
        '-i', file,
        '-vn', '-t', String(SOUND_MAX_SECONDS),
        '-f', 's16le', '-ar', String(SOUND_RATE), '-ac', '1', 'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let err = '';
    proc.stdout.on('data', (c: Buffer) => {
      bytes += c.length;
      if (bytes <= SOUND_MAX_SECONDS * SOUND_RATE * 2) chunks.push(c);
    });
    proc.stderr.on('data', (c: Buffer) => {
      err = (err + c.toString()).slice(-400);
    });
    proc.on('error', (e) => resolve({ error: `Could not start the audio decoder: ${e.message}` }));
    proc.on('close', (code) => {
      if (code !== 0 || !chunks.length) {
        return resolve({ error: err.trim().split('\n').pop() || 'That file is not an audio file we can play.' });
      }
      resolve({ pcm: Buffer.concat(chunks) });
    });
  });
}

/** Adhan and Iqāmah each have a sound of their own. */
export type SoundSlot = 'adhan' | 'iqamah';
const CLIP_KEY = { adhan: 'adhanClip', iqamah: 'iqamahClip' } as const;

/**
 * Point one slot at `file` ('' for the built-in beep), and delete the file it leaves behind —
 * unless the OTHER slot still plays it. They share one file after the move from a single clip
 * (see `migrateTimetable`), so deleting on replace alone would silence the other slot.
 */
export function setSoundClip(sound: TimetableSound, slot: SoundSlot, file: string): void {
  const old = sound[CLIP_KEY[slot]];
  sound[CLIP_KEY[slot]] = file;
  const other = sound[CLIP_KEY[slot === 'adhan' ? 'iqamah' : 'adhan']];
  if (old && old !== file && old !== other) removeSoundClip(old);
}

function removeSoundClip(file: string): void {
  const name = safeName(file);
  if (!name) return;
  try {
    fs.unlinkSync(path.join(soundsDir(), name));
  } catch {
    /* already gone */
  }
  clipCache.delete(name);
}

/** Delete every stored clip belonging to a timetable. */
export function removeSoundClipsFor(id: string): void {
  const safeId = safeName(id);
  if (!safeId) return;
  let files: string[];
  try {
    files = fs.readdirSync(soundsDir());
  } catch {
    return;
  }
  for (const f of files) {
    if (f.startsWith(`${safeId}.`) && f.endsWith('.pcm')) {
      try {
        fs.unlinkSync(path.join(soundsDir(), f));
      } catch {
        /* ignore */
      }
      clipCache.delete(f);
    }
  }
}

/** Copy a stored clip to a NEW timetable's id, so a duplicate owns its own file and deleting
 *  the original cannot silence it. Returns '' if the source has gone. */
export function copySoundClip(file: string, newId: string): string {
  const pcm = soundClipPcm(file);
  const safeId = safeName(newId);
  if (!pcm || !safeId) return '';
  try {
    fs.mkdirSync(soundsDir(), { recursive: true });
    const name = `${safeId}.${crypto.randomBytes(4).toString('hex')}.pcm`;
    fs.writeFileSync(path.join(soundsDir(), name), pcm);
    return name;
  } catch {
    return '';
  }
}

// ── when it plays ────────────────────────────────────────────────────────────

export interface SoundEvent {
  /** wall-clock ms */
  at: number;
  kind: 'adhan' | 'iqamah';
}

/**
 * Every moment today that this timetable wants a sound at, as wall-clock milliseconds.
 *
 * Adhan comes from the daily ROWS (the five calls, Dhuhr included on a Friday — the call is
 * still made). Iqāmah comes from `jamaah`, which is the list of moments a congregation actually
 * lines up: on a Friday that is the Jumu'ah times, one entry each, and NOT the Dhuhr row's
 * Iqāmah. Reading Iqāmah off `rows` instead would sound for a jamā'ah that nobody holds.
 */
export function soundEvents(tt: Timetable, now: Date): SoundEvent[] {
  if (!soundOn(tt)) return [];
  const m = buildModel(tt, now);
  const noon = zonedNoon(m.parts.year, m.parts.month, m.parts.day, tt.timezone || undefined).getTime();
  const at = (hours: number): number => noon + (hours - 12) * 3_600_000;
  const out: SoundEvent[] = [];
  if (tt.sound.adhan) {
    for (const r of m.rows) if (!r.minor && r.adhan != null) out.push({ at: at(r.adhan), kind: 'adhan' });
  }
  if (tt.sound.iqamah) {
    for (const j of m.jamaah) out.push({ at: at(j.at), kind: 'iqamah' });
  }
  return out;
}

/** The PCM a timetable plays at Adhan or at Iqāmah — that slot's uploaded clip, or the built-in
 *  beep if it has none (or its file has gone). */
export function soundPcmFor(tt: Timetable, slot: SoundSlot): Buffer {
  const clip = tt.sound?.[CLIP_KEY[slot]];
  return (clip && soundClipPcm(clip)) || beepPcm();
}

/**
 * What a slot plays, as a WAV file the panel can play back.
 *
 * Stored clips are bare PCM, which no browser will play, and a preview has to be the sound the
 * stream will actually carry — so it is that PCM behind a 44-byte header rather than the file
 * that was uploaded, which no longer exists.
 */
export function soundWav(tt: Timetable, slot: SoundSlot): Buffer {
  const pcm = soundPcmFor(tt, slot);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SOUND_RATE, 24);
  h.writeUInt32LE(SOUND_RATE * 2, 28); // bytes per second
  h.writeUInt16LE(2, 32); // bytes per frame
  h.writeUInt16LE(16, 34); // bits per sample
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// ── the track itself ─────────────────────────────────────────────────────────

/** One second of silence, written in slices — a fresh allocation per pump would be waste, and
 *  it is never mutated, so sharing it is safe. */
const SILENCE = Buffer.alloc(SOUND_RATE * 2);

/**
 * The writer for one stream's audio pipe: silence, continuously, with clips dropped in at
 * exact sample positions.
 */
export class SoundTrack {
  /**
   * How far ahead of the wall clock the audio is kept written.
   *
   * It has to cover a late tick with room to spare: if the audio input runs dry, ffmpeg stops
   * muxing until more arrives, which stalls the VIDEO too. The frame loop ticks four times a
   * second at its slowest, so two seconds is many ticks of slack, and the only cost of being
   * early is that a clip can be queued no later than two seconds before it plays.
   */
  static readonly LEAD_MS = 2000;

  private out: Writable | null = null;
  private startWall = 0;
  /** samples written so far — this, divided by the rate, IS the stream's audio clock */
  private written = 0;
  /** where the last clip written starts and ends, in samples — see `playing` */
  private clipStart = 0;
  private clipEnd = 0;
  /** Each entry's sound is resolved when it is WRITTEN, not when it was queued hours earlier: a
   *  clip replaced in the morning used to go on playing the old one until the next day. */
  private queue: { sample: number; at: number; pcm: () => Buffer }[] = [];
  private readonly queued = new Set<number>();

  /** Take over a freshly spawned ffmpeg's audio pipe. The sample clock restarts with it. */
  attach(stream: Writable, now = Date.now()): void {
    stream.on('error', () => {}); // EPIPE when ffmpeg goes; the pipeline's exit handler restarts it
    this.out = stream;
    this.startWall = now;
    this.written = 0;
    this.clipStart = this.clipEnd = 0;
    this.queue = [];
    this.queued.clear();
  }

  detach(): void {
    this.out = null;
    this.clipStart = this.clipEnd = 0;
    this.queue = [];
    this.queued.clear();
  }

  /**
   * Is a clip sounding at `now`? The caller holds back a respawn that can wait — a ticker change —
   * until it is not: a respawn ends this ffmpeg, and with it the Adhan it was carrying. The ticker
   * flips back from the red prohibited-time text a second after the Dhuhr Adhan, so that call was
   * being cut off a second in, every day.
   */
  playing(now = Date.now()): boolean {
    const at = ((now - this.startWall) / 1000) * SOUND_RATE;
    return !!this.out && at >= this.clipStart && at < this.clipEnd;
  }

  /**
   * Forget queued moments the timetable no longer has. Called with every scan's list: a moment is
   * queued hours ahead, and one that was turned off, or an Iqamah that was moved, otherwise went on
   * sounding at its old time for the rest of the day.
   */
  retain(moments: Set<number>): void {
    this.queue = this.queue.filter((q) => {
      if (moments.has(q.at)) return true;
      this.queued.delete(q.at);
      return false;
    });
  }

  /** Scheduled, in sample terms, for a wall-clock moment. Asking twice for the same moment is
   *  what the caller does every scan, so the second ask is ignored rather than stacked. */
  playAt(at: number, pcm: Buffer | (() => Buffer)): void {
    if (!this.out || this.queued.has(at) || (typeof pcm !== 'function' && !pcm.length)) return;
    const sample = Math.round(((at - this.startWall) / 1000) * SOUND_RATE);
    /**
     * Its START is behind the audio already written, so it cannot be put where it belongs:
     * drop it rather than play it late.
     *
     * This used to allow the clip's LENGTH as room — "it would still be playing now, so let it
     * through" — which is wrong, because a clip is written from its beginning. An ffmpeg
     * respawn (a ticker change, a crash) resets the sample clock, the day is re-scanned, and
     * the Adhan that played three minutes ago is offered again with its moment in the past: it
     * went to the back of the queue and the masjid heard the whole Adhan a second time.
     *
     * The cost is the other edge: a moment falling inside the lead that the pump has already
     * written past is now missed rather than played late. That window is two seconds, and it
     * only exists just after a respawn, because every other moment is queued hours ahead.
     */
    if (sample < this.written) return;
    this.queued.add(at);
    this.queue.push({ sample, at, pcm: typeof pcm === 'function' ? pcm : () => pcm });
    this.queue.sort((a, b) => a.sample - b.sample);
  }

  /** Bring the written audio up to `now + LEAD_MS`. Cheap and idempotent; call it every tick. */
  pump(now = Date.now()): void {
    const s = this.out;
    if (!s || s.destroyed || !s.writable) return;
    // If ffmpeg has stopped reading, stop writing rather than growing the queue for ever. Two
    // seconds of audio is already more than the lead, so this only trips on a real stall.
    if (s.writableLength > SOUND_RATE * 2 * 2) return;
    const want = Math.ceil(((now + SoundTrack.LEAD_MS - this.startWall) / 1000) * SOUND_RATE);
    while (this.written < want) {
      const q = this.queue[0];
      if (q && q.sample <= this.written) {
        const pcm = q.pcm();
        s.write(pcm);
        this.clipStart = this.written;
        this.written += pcm.length / 2;
        this.clipEnd = this.written;
        this.queue.shift();
        continue;
      }
      const until = q ? Math.min(want, q.sample) : want;
      const n = Math.min(until - this.written, SOUND_RATE);
      if (n <= 0) break;
      s.write(n === SOUND_RATE ? SILENCE : SILENCE.subarray(0, n * 2));
      this.written += n;
    }
  }

  /** For tests: the stream's audio clock, in samples. */
  get samplesWritten(): number {
    return this.written;
  }
}
