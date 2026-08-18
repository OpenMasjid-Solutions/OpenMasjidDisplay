// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * render/encoder.ts — which H.264 encoder ffmpeg should use.
 *
 * The default is and stays **libx264**: it is always present, needs no device, and on the
 * content this app encodes (a mostly-static 1 fps SVG) it costs very little. Hardware
 * encoding matters in the case libx264 struggles with — a small box driving several screens
 * at 1080p, or re-encoding cameras in "most compatible" mode, where every stream is its own
 * ffmpeg and the CPU is the ceiling on how many screens a masjid can run.
 *
 * **Intel Quick Sync (`h264_qsv`) is opt-in and cannot be turned on under OpenMasjidOS
 * today.** QSV needs `/dev/dri` inside the container, which means a `devices:` entry in
 * docker-compose.yml — and the platform's compose risk-check treats `devices:` as BLOCKING,
 * so an image that asked for it would refuse to install for every masjid. Shipping it on by
 * default is therefore not a trade-off, it is a broken app. So:
 *
 *   • `VIDEO_ENCODER` unset / `x264`  → libx264, byte-for-byte the arguments as before.
 *   • `VIDEO_ENCODER=qsv`             → h264_qsv, IF ffmpeg has it and a render node exists;
 *                                       otherwise it logs why and falls back to libx264.
 *   • `VIDEO_ENCODER=auto`            → use QSV when both are present, else libx264.
 *
 * A standalone `docker compose up` (the README's own path) can enable it by adding the
 * device and the env var; an OpenMasjidOS install cannot until the platform grows a device
 * allowlist. Falling back rather than failing is deliberate: a masjid that sets the variable
 * on a box with no Intel GPU gets working screens and a log line, not a black wall.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { makeLog } from '../logger';

const log = makeLog('encoder');

export type EncoderKind = 'x264' | 'qsv';

/** The Linux DRM render node QSV opens. Present only when the host GPU is passed in. */
const RENDER_NODE_DIR = '/dev/dri';

function wantedKind(): 'auto' | EncoderKind {
  const v = (process.env.VIDEO_ENCODER ?? '').trim().toLowerCase();
  if (v === 'qsv') return 'qsv';
  if (v === 'auto') return 'auto';
  return 'x264';
}

/** Does this ffmpeg build carry the encoder at all? Asked once and cached — it shells out. */
let encodersCache: string | null = null;
function ffmpegHasEncoder(ffmpeg: string, name: string): boolean {
  if (encodersCache == null) {
    try {
      encodersCache = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-encoders'], {
        encoding: 'utf8',
        timeout: 10_000,
      });
    } catch (err) {
      log.debug(`could not list ffmpeg encoders: ${err instanceof Error ? err.message : err}`);
      encodersCache = '';
    }
  }
  return new RegExp(`\\b${name}\\b`).test(encodersCache);
}

/** Is a DRM render node actually present? Having the encoder compiled in is not enough —
 *  without the device, ffmpeg fails at session init and the stream never comes up. */
function hasRenderNode(): boolean {
  try {
    return fs.readdirSync(RENDER_NODE_DIR).some((f) => f.startsWith('renderD') || f.startsWith('card'));
  } catch {
    return false;
  }
}

let resolved: EncoderKind | null = null;

/**
 * The encoder to use, decided once per process and logged so the choice is never a mystery
 * in a support thread. Re-checking per pipeline would shell out repeatedly and could give
 * two screens different encoders on the same box.
 */
export function selectEncoder(ffmpeg: string): EncoderKind {
  if (resolved) return resolved;
  const want = wantedKind();
  if (want === 'x264') {
    resolved = 'x264';
    return resolved;
  }
  const hasEnc = ffmpegHasEncoder(ffmpeg, 'h264_qsv');
  const hasDev = hasRenderNode();
  if (hasEnc && hasDev) {
    log.info('using Intel Quick Sync (h264_qsv) for video encoding');
    resolved = 'qsv';
    return resolved;
  }
  // Only NAME the fault when QSV was asked for explicitly; on `auto` this is the expected
  // result on most hardware and does not deserve a warning every boot.
  const why = !hasEnc ? 'this ffmpeg build has no h264_qsv encoder' : `no render node in ${RENDER_NODE_DIR} (the container needs the GPU passed in)`;
  if (want === 'qsv') {
    log.warn(`VIDEO_ENCODER=qsv was requested but ${why}; falling back to libx264. Screens keep working.`);
  } else {
    log.debug(`Quick Sync not available (${why}); using libx264`);
  }
  resolved = 'x264';
  return resolved;
}

/**
 * The codec-specific half of the ffmpeg arguments — everything from `-c:v` up to (but not
 * including) the rate-control and output flags the two encoders share.
 *
 * The x264 branch is the arguments this app has always used, moved verbatim. That matters:
 * they were tuned against real decoder behaviour (baseline profile, in-band SPS/PPS, no
 * B-frames, CBR HRD) and a subtle change here shows up as a TV that will not play the
 * stream, on someone else's wall.
 *
 * The QSV branch keeps the same guarantees by different means: `-bf 0` and the same GOP for
 * the keyframe cadence, baseline profile for decoder reach, and `-low_power 1` to use the
 * fixed-function VDEnc path, which is what makes QSV cheap. It drops the x264-only flags
 * (`-tune zerolatency`, `-x264-params`) because they are not options on this encoder and
 * ffmpeg exits on an unknown one.
 */
export interface EncoderOpts {
  level: string;
  gop: number;
  /** baseline for the timetable (widest decoder reach), main for camera re-encodes */
  profile: 'baseline' | 'main';
  /** x264-only tuning; hardware encoders have no equivalent and reject the flag */
  x264Params: string;
}

export function encoderArgs(kind: EncoderKind, o: EncoderOpts): string[] {
  if (kind === 'qsv') {
    return [
      '-c:v', 'h264_qsv',
      '-preset', 'veryfast',
      '-profile:v', o.profile,
      '-level', o.level,
      '-g', `${o.gop}`, '-keyint_min', `${o.gop}`, '-bf', '0',
      // Fixed-function encode: far lower power and CPU than the shader path, which is the
      // entire reason to reach for QSV on a mini-PC driving several screens.
      '-low_power', '1',
    ];
  }
  return [
    '-c:v', 'libx264',
    '-preset', 'veryfast', '-tune', 'zerolatency',
    '-profile:v', o.profile, '-level', o.level,
    '-g', `${o.gop}`, '-keyint_min', `${o.gop}`, '-sc_threshold', '0', '-bf', '0',
    '-x264-params', o.x264Params,
  ];
}

/** The pixel format the encoder wants at the end of the filter chain. QSV uploads NV12;
 *  handing it yuv420p makes ffmpeg insert a conversion, or refuse. */
export function encoderPixFmt(kind: EncoderKind): string {
  return kind === 'qsv' ? 'nv12' : 'yuv420p';
}
