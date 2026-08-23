// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * render/renderer.ts — manages the ffmpeg pipelines.
 *
 *  • TimetablePipeline: rasterizes the display SVG once per second (resvg) and
 *    pipes raw RGBA frames to ffmpeg, which encodes a steady low-fps H.264 RTSP
 *    stream published into MediaMTX. One per *active* timetable.
 *  • TranscodePipeline: pulls a camera/HDMI RTSP source and re-encodes it to a
 *    fixed H.264 geometry ("normalize" mode) for maximum TV-decoder compatibility.
 *
 * Pipelines self-heal: if ffmpeg exits unexpectedly it is respawned with backoff.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { makeLog } from '../logger';
import { dimsFor, activeTicker, tickerTextColor, tickerLayout, bottomBandSplit, TICKER_RED, type Dims } from './svg';
import { primaryFontFile } from './fonts';
import { selectEncoder, encoderArgs, encoderPixFmt } from './encoder';
import { RenderWorker } from './renderPool';
import type { Timetable } from '../types';

const log = makeLog('render');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

/**
 * The only protocols ffmpeg may speak when it opens a source URL.
 *
 * Defence-in-depth behind validate.ts's ALLOWED_SOURCE_SCHEMES: even if a non-stream URL
 * ever slipped past validation, ffmpeg still cannot open `file:` (read a local file onto a
 * masjid screen), `http:`/`https:` (SSRF) or `concat:`. That property is what must not be
 * given up — the list may grow to cover a STREAM protocol, never a local-read or general
 * fetch one.
 *
 * `srtp`/`tls`/`crypto` are here so secure cameras work (e.g. UniFi's `rtsps://…?enableSrtp`).
 * `rtmp`/`rtmps` are here because validate.ts ACCEPTS and stores those URLs: without them an
 * admin could save an RTMP source that passed validation, and then both "Test link" and
 * "Most compatible (re-encode)" failed with a raw ffmpeg protocol error, while plain relay
 * of the same source worked — the two lists disagreeing is the bug, not the protocol.
 *
 * (We do NOT pass -tls_verify: ffmpeg doesn't verify rtsps certs by default, which is what
 * self-signed local cameras need, and the flag isn't accepted by every ffmpeg build —
 * passing it made some builds bail out, breaking rtsps.)
 */
const FF_PROTOCOLS = 'rtp,rtcp,udp,tcp,rtsp,rtsps,srtp,tls,crypto,rtmp,rtmps';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Is the host clock obviously wrong? See CLOCK_FLOOR_MS. Exported so the status feed and
 *  tests can ask the same question the renderer asks. */
export function clockSuspect(now = Date.now()): boolean {
  return now < CLOCK_FLOOR_MS;
}

function safeTicker(tt: Timetable): { text: string; prohibited: boolean } {
  try {
    return activeTicker(tt, new Date());
  } catch {
    return { text: '', prohibited: false };
  }
}

function levelFor(h: number): string {
  return h >= 1080 ? '4.0' : '3.1';
}

export interface TickerSpec {
  text: string;
  textfile: string;
  fontfile: string;
  /** scroll speed 1 (slow) … 10 (fast) */
  speed: number;
  /** a prohibited-time warning → drawn in red (overrides any normal ticker) */
  prohibited: boolean;
  /** "#rrggbb" text colour matching the themed band (dark on light theme, light on dark) */
  color: string;
}

// Ticker cadence: 20 fps (smooth, still light on a 2-core box — the heavy SVG render
// stays at 1 fps on the worker; ffmpeg just duplicates frames and animates the text).
// Quantising the scroll to a whole number of pixels PER FRAME is what removes judder.
const TICKER_FPS = 20;

/**
 * Output frame rate for a timetable with no ticker — i.e. nothing on screen that moves.
 *
 * This is the single biggest lever on this app's CPU, and it was set to 15 on the strength of the
 * comment in timetableArgs() that said the encoder "has ample headroom". Measured in the shipped
 * container, that was backwards: for one 1080p screen the encoder ran ~3.5x the renderer
 * (1429 ffmpeg ticks against 414 for node), so the output frame rate — not the SVG raster — is
 * what a masjid without a hardware encoder is actually paying for.
 *
 * Encoding the same 20s of static content: 15 fps took 4470ms, 8 fps took 2300ms, 5 fps 1773ms.
 * 8 keeps very nearly all of the saving (1.94x) and stays in the range commodity decoders and
 * browsers handle without complaint, which 5 starts to push. Nothing is lost visually: without a
 * ticker the picture changes once a second (the clock), so 8 frames per second is already 8x more
 * often than the content does anything.
 */
export const STATIC_FPS = 8;
/**
 * The fallback size for a box that cannot rasterise its own output resolution in time.
 *
 * ## This used to be unconditional, and it was the reason announcement images looked soft
 *
 * Every 1080p decoder screen rasterised at 1280 and let ffmpeg upscale, on the strength of a
 * comment that said "a 720p frame is ~2.25× cheaper than 1080p". That figure is the PIXEL COUNT
 * ratio, assumed to be the cost ratio. Measured on the real renderer, twelve frames each:
 *
 *   1080p design -> 1280 (capped)   p50 135ms
 *   1080p design -> 1920 (full)     p50 168ms   = 1.25x
 *
 * Not 2.25x. Most of resvg's time goes on parsing and tessellating the SVG — which this app's
 * timetable has a great deal of, and which does not care what size it is drawn at — so the fill is
 * a minority of the work. The same shape of mistake as the "the encoder has ample headroom" comment
 * that set STATIC_FPS to 15: a plausible ratio, never measured, load-bearing for years.
 *
 * A crisp photograph blown up 1.5x by ffmpeg is exactly what "I gave it high quality announcement
 * files, why is it so low res" looks like — and 25% more render CPU is a small price for not doing
 * that to it.
 *
 * So full resolution is now the default, and the cap is where a box that genuinely cannot keep up
 * ends up instead — decided from its OWN measured renders, not from a guess about its hardware. See
 * noteRenderCost.
 *
 * The upscale, when it is used, is a `scale` filter set ONCE at spawn, so the layout carousel
 * (which changes SVG content, not ffmpeg args) still never respawns ffmpeg and the decoder never
 * reconnects.
 */
const RENDER_CAP = 1280;

/**
 * A render slot is one second, and this is how much of it a render may take before the box is
 * declared unable to do its own resolution.
 *
 * Not 1000: the reconcile, the write pump and ffmpeg itself share the same core, and a render that
 * only just fits leaves the countdown skipping whenever anything else happens. 650 leaves a third of
 * the second spare and still keeps full resolution on anything that measured under it — which, on
 * the numbers above, is a very long way down the range of boxes this runs on.
 */
const RENDER_BUDGET_MS = 650;

/**
 * Has some renderer in this process found the box too slow for full resolution?
 *
 * Process-wide and ONE-WAY. Process-wide because it is a property of the hardware, not of one
 * screen, so the second screen should not have to rediscover it. One-way because going back would
 * respawn ffmpeg, and a box hovering at the threshold would then reconnect its decoders for ever —
 * a stuttering countdown is bad, a screen that drops out every thirty seconds is worse.
 */
let boxTooSlowForFullRes = false;

/** The last few full-resolution render times, for the median below. */
const renderCosts: number[] = [];

/**
 * Record what a render actually cost, and decide whether this box can keep doing them.
 *
 * Called for every frame. Ignored once the verdict is in, and ignored while already capped — a
 * capped render says nothing about whether an uncapped one would fit, and feeding those in would
 * make the median drift back down and mean nothing at all.
 */
export function noteRenderCost(ms: number, wasFullRes: boolean): boolean {
  if (boxTooSlowForFullRes || !wasFullRes) return false;
  renderCosts.push(ms);
  if (renderCosts.length > 10) renderCosts.shift();
  // Ten samples before judging, so a slow first render — fonts loading, the JIT still warming — is
  // not mistaken for a slow machine.
  if (renderCosts.length < 10) return false;
  const sorted = [...renderCosts].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  if (p50 <= RENDER_BUDGET_MS) return false;
  boxTooSlowForFullRes = true;
  log.warn(
    `this box takes ${Math.round(p50)}ms to draw a screen at full resolution, which does not fit in ` +
      `the one-second slot the live countdown needs — dropping to ${RENDER_CAP}px and letting ffmpeg ` +
      `scale up. Pictures will be slightly softer; the clock will keep time.`,
  );
  return true;
}

/** Test seam: the verdict is process-wide and one-way, which a test has to be able to undo. */
export function __resetRenderCostForTests(): void {
  boxTooSlowForFullRes = false;
  renderCosts.length = 0;
}
/** How old the published frame may get before we stop treating it as current. The loop
 *  renders once per second, so this is ~30 missed renders: comfortably past a slow frame
 *  or a reconcile stealing CPU, and far short of anyone reading a wrong Iqamah time off
 *  the wall. Beyond it the screen is marked and the status feed reports it. */
const STALE_AFTER_MS = 30_000;
/**
 * A floor on believable wall-clock time. Every prayer time on the screen derives from the
 * host clock and nothing ever questioned it, so a box whose clock is wrong renders a
 * beautiful, authoritative, WRONG timetable — a mini-PC that lost its CMOS battery, a Pi
 * with no RTC that booted with no network, a VM resumed from suspend. The display's own
 * confidence is the problem.
 *
 * The clock cannot legitimately read earlier than the release this code shipped in, so
 * anything before this is definitely wrong. One-directional on purpose: it can only catch
 * a clock that is BEHIND, which is the failure that actually happens (unset clocks fall
 * back to the epoch or to a build date, they don't jump forward). That also means it has
 * no false positives — a correct clock in 2030 is simply later than this.
 *
 * Move this forward when cutting a release — it is the one line in the file with an expiry
 * date, and a floor left behind stops catching the clocks that drifted since. It must never
 * be set LATER than the release it ships in, or a correct clock would read as suspect on
 * day one.
 */
export const CLOCK_FLOOR_MS = Date.parse('2026-08-13T00:00:00Z');
export function renderDimsFor(out: Dims): Dims {
  // Full resolution unless this box has proved it cannot manage it — see noteRenderCost.
  if (!boxTooSlowForFullRes) return out;
  const longest = Math.max(out.width, out.height);
  if (longest <= RENDER_CAP) return out;
  const k = RENDER_CAP / longest;
  return { width: Math.round((out.width * k) / 2) * 2, height: Math.round((out.height * k) / 2) * 2 };
}

/** Build the video filter. The scrolling ticker is drawn by ffmpeg with drawtext
 *  AFTER fps, so it animates at the output frame rate (smooth) even though the SVG
 *  frames only update once per second. The SVG paints just the strip. `inDims` is the
 *  rasterised (piped) size; when smaller than `d` ffmpeg upscales first so the ticker
 *  drawtext still lands on the full-resolution canvas. */
export function timetableVf(d: Dims, ticker: TickerSpec | null, inDims: Dims = d, pixFmt = 'yuv420p'): string {
  const up = inDims.width !== d.width || inDims.height !== d.height
    ? `scale=${d.width}:${d.height}:flags=lanczos,`
    : '';
  // Must stay equal to timetableArgs()'s `ofps` for the no-ticker case. If this filter emits more
  // frames than the encoder is configured for, ffmpeg rasterises and scales every one of them and
  // then throws the surplus away — paying the full cost of the higher rate for none of it.
  if (!ticker) return `${up}format=${pixFmt},fps=${STATIC_FPS}`;
  // NB: no `fps=` here. The pipeline now feeds genuine CFR frames at TICKER_FPS (the
  // last render, duplicated in real time between the 1 fps SVG renders), so drawtext
  // animates on real, evenly-paced frames. A hardware decoder gets a steady frame every
  // 1/TICKER_FPS s instead of a 1-second BURST of frames (which it renders then stalls
  // on — "move, stop, move"); software players hid the burst behind their jitter buffer.
  const { y, bandH, fs } = tickerLayout(d.width, d.height);
  const size = Math.round(fs);
  const speed = clamp(Math.round(ticker.speed || 5), 1, 10); // 1 (slow) … 10 (fast)
  const pxPerFrame = Math.max(1, Math.round((speed * 16) / TICKER_FPS)); // exact integer px/frame → no jitter
  const gap = Math.round(size * 4);
  const period = `tw+${gap}`; // tw = real text width at render time → seamless tiling
  const yExpr = `${Math.round(y + bandH / 2)}-th/2`;
  // Underestimate the text width so we emit ENOUGH copies to cover the screen
  // (extra copies just sit off-screen); the real spacing uses tw above.
  const periodEst = Math.max(100, ticker.text.length * size * 0.45);
  const copies = Math.min(20, Math.max(3, Math.ceil(d.width / periodEst) + 2));
  const dt: string[] = [];
  for (let k = 0; k < copies; k++) {
    // floor(t*fps) gives an integer frame index, so x steps by exactly pxPerFrame each
    // frame (no sub-pixel rounding wobble); the tiling copies hide the wrap.
    const x = `w-mod(floor(t*${TICKER_FPS})*${pxPerFrame}\\,${period})${k > 0 ? `-${k}*(${period})` : ''}`;
    // expansion=none: treat the message file as literal text (no %{...} / escape interpretation).
    const color = ticker.prohibited ? `0x${TICKER_RED.replace('#', '')}` : `0x${ticker.color.replace('#', '')}`;
    dt.push(`drawtext=fontfile='${ticker.fontfile}':textfile='${ticker.textfile}':expansion=none:fontsize=${size}:fontcolor=${color}:x=${x}:y=${yExpr}`);
  }
  return `${up}fps=${TICKER_FPS},${dt.join(',')},format=${pixFmt}`;
}

/**
 * The same filter, but with the scroll CONFINED to the right of the band because the red
 * Iqāmah-change reminder has taken the left of the band and the ticker now runs inside its
 * own well (see svg.ts bottomBandSplit); `scroll` is the strip inside that well.
 *
 * drawtext has no clip region, so a plain `x` offset would not do: a message wider than the
 * remaining space keeps moving left and would slide straight over the reminder. Instead the
 * band's right-hand slice is cropped out, the text is drawn on THAT (clipped to it by
 * construction, and `w` inside the crop is the slice width, so the existing wrap arithmetic
 * still tiles seamlessly), and the result is overlaid back.
 *
 * This is a filtergraph rather than a linear chain, so callers must pass it to
 * -filter_complex. It is only used while a reminder is actually up — a few days a year — so
 * the ordinary ticker keeps the exact, hard-won simple chain above.
 */
export function timetableVfReserved(d: Dims, ticker: TickerSpec, scroll: { x: number; w: number }, inDims: Dims = d, pixFmt = 'yuv420p'): string {
  const up = inDims.width !== d.width || inDims.height !== d.height
    ? `scale=${d.width}:${d.height}:flags=lanczos,`
    : '';
  const { y, bandH, fs } = tickerLayout(d.width, d.height);
  const size = Math.round(fs);
  const speed = clamp(Math.round(ticker.speed || 5), 1, 10);
  const pxPerFrame = Math.max(1, Math.round((speed * 16) / TICKER_FPS));
  const gap = Math.round(size * 4);
  const period = `tw+${gap}`;
  // The strip INSIDE the ticker's well. Clamped so a nonsense lane can never produce a
  // zero-width crop (which ffmpeg rejects outright, taking the whole stream down).
  const rx = Math.round(clamp(scroll.x, 0, Math.max(0, d.width - 16)));
  const rw = Math.round(clamp(scroll.w, 16, d.width - rx));
  const by = Math.round(y);
  const bh = Math.round(bandH);
  const periodEst = Math.max(100, ticker.text.length * size * 0.45);
  const copies = Math.min(20, Math.max(3, Math.ceil(rw / periodEst) + 2));
  const color = ticker.prohibited ? `0x${TICKER_RED.replace('#', '')}` : `0x${ticker.color.replace('#', '')}`;
  const dt: string[] = [];
  for (let k = 0; k < copies; k++) {
    const x = `w-mod(floor(t*${TICKER_FPS})*${pxPerFrame}\\,${period})${k > 0 ? `-${k}*(${period})` : ''}`;
    dt.push(`drawtext=fontfile='${ticker.fontfile}':textfile='${ticker.textfile}':expansion=none:fontsize=${size}:fontcolor=${color}:x=${x}:y=(h-th)/2`);
  }
  return (
    `[0:v]${up}fps=${TICKER_FPS},split=2[bg][sc];` +
    `[sc]crop=${rw}:${bh}:${rx}:${by},${dt.join(',')}[tk];` +
    `[bg][tk]overlay=${rx}:${by},format=${pixFmt}`
  );
}

/** @param d output (encoded) dims; @param inDims the rasterised frame piped on stdin
 *  (== d unless capped, in which case ffmpeg upscales d ← inDims). */
/** Bitrate cap (kbps) for a timetable's output size — the admin can override the
 *  defaults per resolution in the timetable settings. */
function brFor(tt: Timetable, d: Dims): number {
  return d.height >= 1080 ? tt.bitrate1080 ?? 8000 : tt.bitrate720 ?? 4000;
}

function timetableArgs(d: Dims, target: string, ticker: TickerSpec | null, inDims: Dims = d, bitrate = 0, scroll: { x: number; w: number } | null = null): string[] {
  // The display is mostly static high-detail (gradients, glass, crisp text), so a low
  // CBR starved it and it went blocky/banded. Give it a generous bitrate — the content
  // compresses well so this only spends bits where detail actually needs them — and use
  // a slightly better preset. GOP is one keyframe per second at the output fps.
  //
  // This comment used to justify the preset with "the heavy work is the 1 fps SVG render, so the
  // encoder has ample headroom". Measurement says the opposite — see STATIC_FPS above — so the
  // headroom claim is gone and the static frame rate is chosen on the numbers instead.
  const ofps = ticker ? TICKER_FPS : STATIC_FPS;
  // With a ticker we feed genuine CFR frames at TICKER_FPS (the pipeline duplicates the
  // last render in real time), so the input framerate IS the output framerate and there
  // is no `fps=` filter. Without a ticker the SVG-per-second feed (1 fps) is upsampled by the
  // `fps=${STATIC_FPS}` filter (static content, so there is no motion to stutter).
  const inFps = ticker ? TICKER_FPS : 1;
  const br = bitrate > 0 ? bitrate : d.height >= 1080 ? 8000 : 4000;
  const buf = br * 2;
  // A red Iqāmah-change reminder owns the left of the band, so the scroll has to be clipped
  // to what is left of it — which needs a filtergraph (-filter_complex), not a chain (-vf).
  // Only when both are on screen at once; otherwise the plain chain is used unchanged.
  // Which H.264 encoder — libx264 unless Quick Sync is both requested and actually usable.
  // The x264 branch produces exactly the arguments this pipeline has always used.
  const enc = selectEncoder(FFMPEG);
  const pixFmt = encoderPixFmt(enc);
  const filter: string[] =
    ticker && scroll
      ? ['-filter_complex', timetableVfReserved(d, ticker, scroll, inDims, pixFmt)]
      : ['-vf', timetableVf(d, ticker, inDims, pixFmt)];
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${inDims.width}x${inDims.height}`, '-framerate', `${inFps}`, '-i', 'pipe:0',
    ...filter, '-fps_mode', 'cfr',
    ...encoderArgs(enc, { level: levelFor(d.height), gop: ofps, profile: 'baseline', x264Params: 'repeat-headers=1:nal-hrd=cbr' }),
    '-b:v', `${br}k`, '-maxrate', `${br}k`, '-bufsize', `${buf}k`,
    '-an', '-f', 'rtsp', '-rtsp_transport', 'tcp', target,
  ];
}

function transcodeArgs(url: string, d: Dims, target: string): string[] {
  const br = d.height >= 1080 ? 4500 : 2500;
  // Camera re-encoding is where the CPU actually runs out on a small box — every
  // "most compatible" source is its own ffmpeg — so it honours the encoder choice too.
  const enc = selectEncoder(FFMPEG);
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-protocol_whitelist', FF_PROTOCOLS,
    '-rtsp_transport', 'tcp', '-i', url,
    '-map', '0:v:0',
    '-vf', `scale=${d.width}:${d.height}:force_original_aspect_ratio=decrease,pad=${d.width}:${d.height}:(ow-iw)/2:(oh-ih)/2,format=${encoderPixFmt(enc)},fps=15`,
    '-fps_mode', 'cfr',
    ...encoderArgs(enc, { level: levelFor(d.height), gop: 30, profile: 'main', x264Params: 'repeat-headers=1' }),
    '-b:v', `${br}k`, '-maxrate', `${br}k`, '-bufsize', `${br * 2}k`,
    '-an', '-f', 'rtsp', '-rtsp_transport', 'tcp', target,
  ];
}

/** Strip any user:pass@ credentials from URLs so they never reach the logs. */
function redactCreds(s: string): string {
  return s.replace(/(\w+:\/\/)[^@\s/]+@/g, '$1***@');
}

/** One ffmpeg connect-and-read-a-frame attempt over a given RTSP transport. */
function probeOnce(url: string, transport: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    // Only standard, widely-supported options here — the bundled ffmpeg is an older
    // build that rejects newer flags (e.g. -rw_timeout → "Option rw_timeout not found",
    // which made this very test fail). We bound the runtime with our own kill timer.
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-protocol_whitelist', FF_PROTOCOLS,
      '-rtsp_transport', transport,
      '-i', url,
      '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-',
    ];
    let err = '';
    let done = false;
    let proc: ChildProcess | null = null;
    const finish = (ok: boolean, message: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        proc?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve({ ok, message });
    };
    const timer = setTimeout(
      () => finish(false, `No response over ${transport.toUpperCase()} within 8s — check the address/port and that RTSP is turned on at the camera.`),
      8_000,
    );
    try {
      proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      return finish(false, `Could not start ffmpeg: ${e instanceof Error ? e.message : e}`);
    }
    proc.stderr?.on('data', (d) => {
      err += d.toString();
      if (err.length > 4000) err = err.slice(-4000);
    });
    proc.on('error', (e) => finish(false, `Could not start ffmpeg: ${e.message}`));
    proc.on('close', (code) => {
      if (code === 0) return finish(true, 'ok');
      const tail = redactCreds(err.trim().split('\n').filter(Boolean).slice(-3).join(' ')).slice(0, 400);
      finish(false, tail || `ffmpeg could not read the stream (exit ${code}).`);
    });
  });
}

/** Diagnostic: actually connect to a camera/source URL and try to read one frame, so
 *  the panel can show WHY it won't load (auth, TLS cert, transport, wrong port, SRTP).
 *  Tries TCP then — for rtsp/rtsps — UDP, since some cameras (e.g. UniFi with SRTP)
 *  only work over one transport. Reports which transport succeeded. */
export async function probeSource(rawUrl: string): Promise<{ ok: boolean; transport?: string; message: string }> {
  const url = rawUrl.trim();
  const transports = /^rtsps?:\/\//i.test(url) ? ['tcp', 'udp'] : ['tcp'];
  let lastErr = '';
  for (const t of transports) {
    const r = await probeOnce(url, t);
    if (r.ok) return { ok: true, transport: t, message: `Connected and read video over ${t.toUpperCase()}.` };
    lastErr = r.message;
  }
  return { ok: false, message: lastErr || 'Could not connect to the camera.' };
}

/** Common ffmpeg lifecycle with self-healing restart (capped exponential backoff). */
abstract class FfmpegPipeline {
  protected proc: ChildProcess | null = null;
  protected stopped = false;
  private stderrTail = '';
  private restartTimer: NodeJS.Timeout | null = null;
  private failStreak = 0;
  private startedAt = 0;

  protected constructor(protected readonly id: string) {}

  protected target(): string {
    return `${config.rtspInternal}/${this.id}`;
  }

  protected abstract args(): string[];
  /** Called right after spawn (e.g. to start the frame timer / write frames). */
  protected onSpawned(): void {}

  protected spawnProc(): void {
    if (this.stopped) return;
    const proc = spawn(FFMPEG, this.args(), { stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc = proc;
    this.startedAt = Date.now();
    // If ffmpeg exits while we're mid-write, the stdin pipe emits EPIPE. Swallow it
    // here — an unhandled stream 'error' would crash the whole process. The 'exit'
    // handler below is what actually restarts ffmpeg.
    proc.stdin?.on('error', () => {});
    proc.stderr?.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-600);
    });
    proc.on('error', (err) => log.error(`ffmpeg ${this.id} failed to start`, err));
    proc.on('exit', (code) => {
      // Ignore the exit of a process we've already replaced (e.g. a dims-change
      // SIGKILL): only the currently-tracked child may schedule a restart.
      if (this.stopped || this.proc !== proc) return;
      this.proc = null;
      // Reset the backoff if it ran healthily for a while; otherwise ramp it so a
      // permanently-bad source/args can't churn (and spam logs) every 2s forever.
      this.failStreak = Date.now() - this.startedAt > 30_000 ? 0 : this.failStreak + 1;
      const delay = Math.min(60_000, 2000 * 2 ** Math.min(this.failStreak, 5));
      if (this.stderrTail.trim()) log.debug(`ffmpeg ${this.id}: ${redactCreds(this.stderrTail.trim().split('\n').pop() ?? '')}`);
      log.warn(`ffmpeg ${this.id} exited (code ${code}); restarting in ${Math.round(delay / 1000)}s`);
      this.restartTimer = setTimeout(() => this.spawnProc(), delay);
    });
    this.onSpawned();
  }

  protected clearRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  start(): void {
    this.spawnProc();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.proc) {
      try {
        this.proc.stdin?.end();
        this.proc.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      this.proc = null;
    }
  }
}

class TimetablePipeline extends FfmpegPipeline {
  private timer: NodeJS.Timeout | null = null;
  private dims: Dims;
  // Rasterization happens on a worker thread so it never blocks the event loop
  // (which would starve ffmpeg's stdin and the MediaMTX API). At most one render
  // is in flight at a time — if the box can't keep up we just skip a tick.
  private readonly worker = new RenderWorker();
  private rendering = false;
  private looping = false;
  // The scrolling ticker is drawn by ffmpeg (smooth). We track the active text and,
  // when it changes (schedule windows, edits, enable/disable), rewrite the text file
  // and respawn ffmpeg so its drawtext filters rebuild.
  private tickerText = '';
  private tickerProhibited = false; // red prohibited-time message → drawtext colour is an ffmpeg arg
  private tickerColor = '#ffffff'; // themed ticker text colour (ffmpeg arg) → respawn on theme change
  private tickerSpeed = 5; // scroll speed is an ffmpeg arg → respawn when it changes
  // The strip the ticker may scroll inside when the red Iqāmah-change reminder is sharing the
  // band; null when it has the band to itself. Baked into the drawtext crop, so it has to
  // respawn ffmpeg when it changes — which is when a change comes into range, drops out of
  // range, or its wording (and so the card's width) moves.
  private tickerScroll: { x: number; w: number } | null = null;
  private bitrate = 0; // configurable bitrate cap (kbps) — an ffmpeg arg → respawn on change
  private readonly tickerFile: string;
  // The size we rasterise (capped); ffmpeg upscales to this.dims. Keeps each render
  // fast enough that the per-second countdown never skips, with no ffmpeg respawn.
  private renderDims: Dims;

  constructor(id: string, private readonly getTt: () => Timetable | undefined) {
    super(id);
    this.tickerFile = path.join(config.dataDir, `ticker_${id}.txt`);
    const tt = getTt();
    this.dims = tt ? dimsFor(tt.orientation, tt.quality) : { width: 1280, height: 720 };
    this.bitrate = tt ? brFor(tt, this.dims) : 0;
    const st = tt ? safeTicker(tt) : { text: '', prohibited: false };
    this.tickerText = st.text;
    this.tickerProhibited = st.prohibited;
    this.tickerColor = tt ? tickerTextColor(tt) : '#ffffff';
    this.tickerSpeed = tt?.tickerSpeed ?? 5;
    // Needs dims + tickerText/prohibited, all set above.
    this.tickerScroll = this.wantScroll(tt);
    // renderDims depends on tickerText (full-res while a ticker animates), so set it last.
    this.renderDims = this.computeRenderDims();
    this.writeTickerFile();
  }

  private tickerSpec(): TickerSpec | null {
    const font = primaryFontFile();
    if (!this.tickerText || !font) return null;
    return { text: this.tickerText, textfile: this.tickerFile, fontfile: font, speed: this.tickerSpeed, prohibited: this.tickerProhibited, color: this.tickerColor };
  }

  private writeTickerFile(): void {
    if (!this.tickerText) return;
    try {
      fs.writeFileSync(this.tickerFile, this.tickerText);
    } catch (err) {
      log.debug(`ticker file write failed for ${this.id}`);
    }
  }

  protected args(): string[] {
    return timetableArgs(this.dims, this.target(), this.tickerSpec(), this.renderDims, this.bitrate, this.tickerScroll);
  }

  /** The strip the ticker may scroll inside for the CURRENT timetable, or null when it has the
   *  whole band — no reminder, or a prohibited-time message has taken the band instead. The
   *  SVG makes the same call, and the two must agree or the moving text and the well it is
   *  supposed to run inside will not line up. */
  private wantScroll(tt: Timetable | undefined): { x: number; w: number } | null {
    if (!tt || !this.tickerText || this.tickerProhibited) return null;
    try {
      return bottomBandSplit(tt, new Date(), this.dims.width, this.dims.height, true).scroll;
    } catch {
      return null; // never let a bad schedule stop the stream
    }
  }

  private restartProc(): void {
    this.clearRestart();
    if (this.proc) {
      const old = this.proc;
      this.proc = null;
      try {
        old.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    this.spawnProc();
  }

  protected override onSpawned(): void {
    if (!this.looping) {
      this.looping = true;
      this.loop();
    }
  }

  // The loop paces two jobs at different rates:
  //  • reconcile + SVG render — at most once per wall-clock second (the heavy work),
  //  • frame WRITE — at the input framerate (TICKER_FPS with a ticker, else 1/s), by
  //    repeating the last render so ffmpeg gets a genuine, evenly-paced CFR stream.
  // A fixed 1 s render loop skipped ticks when a render ran long (countdown jumped by 2);
  // polling faster and gating the render on the whole second keeps it locked to ~1 s.
  private lastSec = -1;
  private lastCheck = 0;
  private lastWriteSlot = -1;
  /** most recent rendered frame; re-fed to ffmpeg every input-frame slot */
  private lastFrame: Awaited<ReturnType<RenderWorker['raw']>> | null = null;
  /** when lastFrame was produced — the whole point is that a frame has an AGE */
  private lastFrameAt = 0;
  /** the dimmed + red-barred copy of a stale frame, built once and reused */
  private staleFrame: Buffer | null = null;
  private staleLogged = false;
  private failStreakRender = 0;

  private loop(): void {
    if (this.stopped) {
      this.looping = false;
      return;
    }
    this.tick();
    // Tick fast enough to feed each TICKER_FPS frame; a plain 1 fps stream needs no rush.
    const interval = this.tickerText ? Math.max(20, Math.round(1000 / TICKER_FPS)) : 250;
    this.timer = setTimeout(() => this.loop(), interval);
  }

  private tick(): void {
    if (this.stopped) return;
    // Reconcile (respawn checks) + render only ~4×/s — not on every 50 ms ticker frame.
    const now = Date.now();
    if (now - this.lastCheck >= 240) {
      this.lastCheck = now;
      if (this.reconcileAndRender()) return; // respawned → skip the write this tick
    }
    this.writeLatest();
  }

  /** Respawn checks (ticker text/colour, dims, bitrate, scroll speed) + the
   *  once-per-second SVG render that updates lastFrame. Returns true if ffmpeg was
   *  respawned (the caller then skips writing a frame this tick). */
  private reconcileAndRender(): boolean {
    const tt = this.getTt();
    if (!tt) {
      this.stop();
      return true;
    }
    const tk = safeTicker(tt);
    if (tk.text !== this.tickerText || tk.prohibited !== this.tickerProhibited) {
      this.tickerText = tk.text;
      this.tickerProhibited = tk.prohibited;
      this.writeTickerFile();
      this.renderDims = this.computeRenderDims(); // ticker on/off flips full-res ↔ capped
      this.restartProc();
      return true;
    }
    const want = dimsFor(tt.orientation, tt.quality);
    if (want.width !== this.dims.width || want.height !== this.dims.height) {
      this.dims = want;
      this.renderDims = this.computeRenderDims();
      this.bitrate = brFor(tt, this.dims);
      this.restartProc();
      return true;
    }
    const wantBr = brFor(tt, this.dims);
    if (wantBr !== this.bitrate) {
      this.bitrate = wantBr;
      this.restartProc();
      return true;
    }
    const spd = tt.tickerSpeed ?? 5;
    if (spd !== this.tickerSpeed && this.tickerText) {
      this.tickerSpeed = spd;
      this.restartProc();
      return true;
    }
    // Theme change flips the ticker text colour (an ffmpeg drawtext arg) → respawn.
    const col = tickerTextColor(tt);
    if (col !== this.tickerColor && this.tickerText) {
      this.tickerColor = col;
      this.restartProc();
      return true;
    }
    // The ticker's lane is baked into the drawtext crop, so a change in it (the reminder
    // appearing, clearing, or rewording to a different width) needs the filter rebuilt.
    // Compared by VALUE — these are fresh objects every call, so a reference check would
    // respawn ffmpeg every reconcile and the decoder would reconnect for ever.
    const wantScroll = this.wantScroll(tt);
    const key = (s: { x: number; w: number } | null) => (s ? `${s.x}x${s.w}` : '');
    if (key(wantScroll) !== key(this.tickerScroll)) {
      this.tickerScroll = wantScroll;
      this.restartProc();
      return true;
    }
    if (this.rendering) return false; // a render is still in flight — let it finish
    const sec = Math.floor(Date.now() / 1000);
    if (sec === this.lastSec) return false;
    this.lastSec = sec;
    this.rendering = true;
    const startedAt = Date.now();
    // Whether THIS render is at the output's own size, which is what makes its duration a fair
    // sample. A capped render is cheaper by construction and says nothing about the full one.
    const fullRes = this.renderDims.width === this.dims.width;
    this.worker
      // Stamp the frame at the whole second so the clock/countdown land exactly on it.
      .raw(tt, sec * 1000, this.renderDims.width)
      .then((img) => {
        this.rendering = false;
        if (this.stopped) return;
        // Measured before anything else uses the frame: if this box cannot draw its own resolution
        // inside the slot, drop to the cap now rather than letting the countdown skip for ever.
        if (noteRenderCost(Date.now() - startedAt, fullRes)) {
          this.renderDims = this.computeRenderDims();
          this.restartProc();
          return;
        }
        if (img.width !== this.renderDims.width || img.height !== this.renderDims.height) return;
        this.lastFrame = img; // the write pump feeds this to ffmpeg
        this.lastFrameAt = Date.now();
        this.staleFrame = null; // fresh picture — drop the marked copy
        // Only announce recovery once we are ACTUALLY current again. A suspect clock keeps
        // rendering successfully every second, so clearing this unconditionally would flap
        // between "rendering again" and the warning once per second, for ever.
        if (this.staleLogged && !this.isStale()) {
          log.info(`timetable ${this.id} is rendering again; the screen is current`);
          this.staleLogged = false;
        }
        this.failStreakRender = 0;
      })
      .catch((err) => {
        this.rendering = false;
        if (this.stopped) return;
        // A render that keeps failing is why a screen freezes on old prayer times, so it
        // is a WARNING, not a debug line (debug is off unless OMD_DEBUG=1, so this used to
        // be completely silent). Logged on the first failure and then every ~30th, so a
        // persistent fault stays visible without flooding the log at 1/s.
        const msg = err instanceof Error ? err.message : String(err);
        if (this.failStreakRender % 30 === 0) {
          log.warn(`render ${this.id} failed (${this.failStreakRender + 1} in a row): ${msg}`);
        }
        this.failStreakRender++;
      });
    return false;
  }

  /** Feed ffmpeg genuine CFR frames: repeat the latest render once per input-frame slot
   *  (TICKER_FPS with a ticker, else 1/s). Pacing the writes to wall-clock time is what
   *  turns the old 1-second BURST of frames into an even stream a hardware decoder can
   *  play smoothly. ffmpeg assigns PTS by frame count (-framerate), so slot-based pacing
   *  keeps the video clock ≈ real time. */
  private writeLatest(): void {
    const s = this.proc?.stdin;
    const img = this.lastFrame;
    if (!s || !s.writable || !img) return;
    if (img.width !== this.renderDims.width || img.height !== this.renderDims.height) return;
    const inFps = this.tickerText ? TICKER_FPS : 1;
    const slot = Math.floor(Date.now() / (1000 / inFps));
    if (slot === this.lastWriteSlot) return;
    if (s.writableLength >= img.pixels.length * 3) return; // ffmpeg stalled — don't buffer
    // A frame has an AGE. Without this check the last good frame was re-fed forever, so a
    // broken renderer left a frozen clock and yesterday's Iqamah times on the wall,
    // indefinitely, presented as current. Keep the stream alive (a dead stream just makes
    // the TV say "no signal") but stop passing the picture off as up to date.
    s.write(this.isStale() ? this.markStale(img) : img.pixels);
    this.lastWriteSlot = slot;
  }

  /** Should the picture we are publishing be trusted as CURRENT?
   *
   *  Two ways to fail: the frame is too old (the renderer is broken, not merely busy — the
   *  loop renders once a second), or the host clock is implausible, in which case the frame
   *  is freshly rendered and still shows the wrong times. Both mean "do not present this as
   *  current", so both take the same visible mark. */
  isStale(): boolean {
    return this.staleReason() !== null;
  }

  /** WHY the picture should not be trusted, or null if it should.
   *
   *  The two reasons need telling apart when reporting to a human: a 'frozen' screen has an
   *  old frame and an age worth quoting, whereas a 'clock' screen is rendering perfectly
   *  every second (so its frame age is ~0) and is wrong for an entirely different reason.
   *  Collapsing them made the panel say "Times out of date — about 0 min ago", which reads
   *  like a bug in the panel rather than a wrong clock on the box. */
  staleReason(): 'frozen' | 'clock' | null {
    if (clockSuspect()) return 'clock';
    if (this.lastFrameAt > 0 && Date.now() - this.lastFrameAt > STALE_AFTER_MS) return 'frozen';
    return null;
  }

  /** Age of the published frame in ms (0 before the first render). */
  frameAgeMs(): number {
    return this.lastFrameAt > 0 ? Date.now() - this.lastFrameAt : 0;
  }

  /** The frozen frame, visibly marked so a stale timetable can't be mistaken for a live
   *  one: the picture is dimmed and a solid red bar is laid along the bottom edge.
   *
   *  Deliberately plain pixel arithmetic on the RGBA buffer rather than a re-render —
   *  the SVG renderer is precisely what has failed by the time we get here, so anything
   *  that needed it would fail too. Built once per stale frame and reused, because this
   *  runs on a box that is already struggling. */
  private markStale(img: NonNullable<TimetablePipeline['lastFrame']>): Buffer {
    if (this.staleFrame) return this.staleFrame;
    if (!this.staleLogged) {
      this.staleLogged = true;
      log.warn(
        clockSuspect()
          ? `timetable ${this.id}: this machine's clock reads ${new Date().toISOString()}, which cannot be right — ` +
              'every prayer time on that screen is therefore wrong. Set the clock (or fix NTP) and the ' +
              'screen clears itself; until then it is marked on screen and reported offline'
          : `timetable ${this.id} is showing a frame ${Math.round(this.frameAgeMs() / 1000)}s old — ` +
              'the times on that screen are NOT current; it is marked on screen and reported offline',
      );
    }
    const { width, height, pixels } = img;
    const out = Buffer.from(pixels); // copy — lastFrame must stay pristine
    for (let i = 0; i < out.length; i += 4) {
      out[i] >>= 1;
      out[i + 1] >>= 1;
      out[i + 2] >>= 1;
    }
    const barH = Math.max(6, Math.round(height * 0.02));
    for (let y = Math.max(0, height - barH); y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        out[i] = 0xd0;
        out[i + 1] = 0x3a;
        out[i + 2] = 0x2f;
        out[i + 3] = 0xff;
      }
    }
    this.staleFrame = out;
    return out;
  }

  /** Full resolution while a ticker animates (drawtext stays crisp and there's no
   *  per-frame upscale, since we feed real TICKER_FPS frames); capped otherwise so the
   *  once-per-second render stays cheap. */
  private computeRenderDims(): Dims {
    return this.tickerText ? this.dims : renderDimsFor(this.dims);
  }

  override stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.looping = false;
    this.worker.dispose();
    try {
      fs.unlinkSync(this.tickerFile);
    } catch {
      /* never written / already gone */
    }
    super.stop();
  }
}

class TranscodePipeline extends FfmpegPipeline {
  constructor(id: string, private readonly url: string, private readonly dims: Dims) {
    super(id);
  }
  protected args(): string[] {
    return transcodeArgs(this.url, this.dims, this.target());
  }
}

export interface NormalizeSpec {
  id: string;
  url: string;
  dims: Dims;
}

export class RenderManager {
  private timetables = new Map<string, TimetablePipeline>();
  private transcodes = new Map<string, { pipe: TranscodePipeline; sig: string }>();

  /** Make the running pipelines match the desired active set. */
  reconcile(
    activeTimetables: Timetable[],
    normalizeSources: NormalizeSpec[],
    getTt: (id: string) => Timetable | undefined,
  ): void {
    const wantTt = new Set(activeTimetables.map((t) => t.id));
    for (const [id, pipe] of this.timetables) {
      if (!wantTt.has(id)) {
        pipe.stop();
        this.timetables.delete(id);
        log.info(`stopped timetable stream ${id}`);
      }
    }
    for (const t of activeTimetables) {
      if (!this.timetables.has(t.id)) {
        const pipe = new TimetablePipeline(t.id, () => getTt(t.id));
        pipe.start();
        this.timetables.set(t.id, pipe);
        log.info(`started timetable stream ${t.id}`);
      }
    }

    const wantSrc = new Set(normalizeSources.map((s) => s.id));
    for (const [id, e] of this.transcodes) {
      if (!wantSrc.has(id)) {
        e.pipe.stop();
        this.transcodes.delete(id);
        log.info(`stopped transcode ${id}`);
      }
    }
    for (const s of normalizeSources) {
      const sig = `${s.url}|${s.dims.width}x${s.dims.height}`;
      const cur = this.transcodes.get(s.id);
      if (cur && cur.sig === sig) continue;
      if (cur) cur.pipe.stop();
      const pipe = new TranscodePipeline(s.id, s.url, s.dims);
      pipe.start();
      this.transcodes.set(s.id, { pipe, sig });
      log.info(`started transcode ${s.id}`);
    }
  }

  /** Is the timetable stream `id` publishing an out-of-date picture? False when it isn't
   *  running (nothing is being shown, so nothing is stale). */
  isStale(id: string): boolean {
    return this.timetables.get(id)?.isStale() ?? false;
  }

  /** Why `id`'s picture is out of date ('frozen' | 'clock'), or null. */
  staleReason(id: string): 'frozen' | 'clock' | null {
    return this.timetables.get(id)?.staleReason() ?? null;
  }

  /** Age in ms of the frame `id` is publishing (0 if unknown / not running). */
  frameAgeMs(id: string): number {
    return this.timetables.get(id)?.frameAgeMs() ?? 0;
  }

  stopAll(): void {
    for (const p of this.timetables.values()) p.stop();
    for (const e of this.transcodes.values()) e.pipe.stop();
    this.timetables.clear();
    this.transcodes.clear();
  }
}
