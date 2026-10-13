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
import type { Timetable } from '../types';

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

// ── the built-in chime ───────────────────────────────────────────────────────

let chime: Buffer | null = null;

/** The sound used when a masjid has not uploaded one: two short tones, a fifth apart, with
 *  fades at both ends so it does not click. Generated rather than shipped as a file — it is
 *  nine lines of arithmetic and an asset we would have to licence. */
export function beepPcm(): Buffer {
  if (chime) return chime;
  const tones = [
    { hz: 880, at: 0, len: 0.18 },
    { hz: 1318.5, at: 0.2, len: 0.32 },
  ];
  const total = Math.round(SOUND_RATE * 0.56);
  const buf = Buffer.alloc(total * 2);
  for (const t of tones) {
    const from = Math.round(t.at * SOUND_RATE);
    const n = Math.round(t.len * SOUND_RATE);
    for (let i = 0; i < n; i++) {
      const s = i / SOUND_RATE;
      const env = Math.max(0, Math.min(1, s / 0.008, (t.len - s) / 0.06));
      buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * t.hz * s) * 11000 * env), (from + i) * 2);
    }
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
export async function saveSoundClip(id: string, data: Buffer): Promise<{ file: string } | { error: string }> {
  const safeId = safeName(id);
  if (!safeId) return { error: 'Unknown timetable.' };
  fs.mkdirSync(soundsDir(), { recursive: true });
  const tmp = path.join(soundsDir(), `.in.${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, data);
    const pcm = await decodeToPcm(tmp);
    if ('error' in pcm) return pcm;
    if (pcm.pcm.length < SOUND_RATE) return { error: 'That file has no sound in it that we could read.' };
    const name = `${safeId}.${crypto.randomBytes(4).toString('hex')}.pcm`;
    removeSoundClipsFor(safeId);
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

/** Delete every stored clip belonging to a timetable (there is at most one). */
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
 * Iqāmah. Reading Iqāmah off `rows` instead would sound a chime for a jamā'ah that nobody holds.
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

/** The PCM a timetable plays — its uploaded clip, or the built-in chime if it has none. */
export function soundPcmFor(tt: Timetable): Buffer {
  return (tt.sound?.clip && soundClipPcm(tt.sound.clip)) || beepPcm();
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
  private queue: { sample: number; pcm: Buffer }[] = [];
  private readonly queued = new Set<number>();

  /** Take over a freshly spawned ffmpeg's audio pipe. The sample clock restarts with it. */
  attach(stream: Writable, now = Date.now()): void {
    stream.on('error', () => {}); // EPIPE when ffmpeg goes; the pipeline's exit handler restarts it
    this.out = stream;
    this.startWall = now;
    this.written = 0;
    this.queue = [];
    this.queued.clear();
  }

  detach(): void {
    this.out = null;
    this.queue = [];
    this.queued.clear();
  }

  /** Scheduled, in sample terms, for a wall-clock moment. Asking twice for the same moment is
   *  what the caller does every scan, so the second ask is ignored rather than stacked. */
  playAt(at: number, pcm: Buffer): void {
    if (!this.out || this.queued.has(at) || !pcm.length) return;
    const sample = Math.round(((at - this.startWall) / 1000) * SOUND_RATE);
    // Wholly behind the audio already written: it cannot be heard, so do not queue it — it
    // would otherwise play late, at full length, the moment the pump reached it.
    if (sample + pcm.length / 2 < this.written) return;
    this.queued.add(at);
    this.queue.push({ sample, pcm });
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
        s.write(q.pcm);
        this.written += q.pcm.length / 2;
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
