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
import { dimsFor, activeTicker, tickerTextColor, tickerLayout, TICKER_RED, type Dims } from './svg';
import { primaryFontFile } from './fonts';
import { RenderWorker } from './renderPool';
import type { Timetable } from '../types';

const log = makeLog('render');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

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
/** Rasterise the timetable at a CAPPED resolution and let ffmpeg upscale to the
 *  output. The heavy per-second work is the resvg render; capping it (a 720p frame is
 *  ~2.25× cheaper than 1080p) keeps every render well under its 1-second slot even
 *  when the periodic reconcile steals CPU — so the live countdown never skips a
 *  second. Crucially the upscale is a `scale` filter set ONCE at spawn, so the layout
 *  carousel (which only changes SVG content, not ffmpeg args) still never respawns
 *  ffmpeg → the decoder never reconnects. Output ≤ 720p renders 1:1 (no upscale). */
const RENDER_CAP = 1280; // longest side of the rasterised frame (keeps the per-second render cheap so the ticker + countdown never stutter on a 2-core box)
export function renderDimsFor(out: Dims): Dims {
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
function timetableVf(d: Dims, ticker: TickerSpec | null, inDims: Dims = d): string {
  const up = inDims.width !== d.width || inDims.height !== d.height
    ? `scale=${d.width}:${d.height}:flags=lanczos,`
    : '';
  if (!ticker) return `${up}format=yuv420p,fps=15`;
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
  return `${up}fps=${TICKER_FPS},${dt.join(',')},format=yuv420p`;
}

/** @param d output (encoded) dims; @param inDims the rasterised frame piped on stdin
 *  (== d unless capped, in which case ffmpeg upscales d ← inDims). */
/** Bitrate cap (kbps) for a timetable's output size — the admin can override the
 *  defaults per resolution in the timetable settings. */
function brFor(tt: Timetable, d: Dims): number {
  return d.height >= 1080 ? tt.bitrate1080 ?? 8000 : tt.bitrate720 ?? 4000;
}

function timetableArgs(d: Dims, target: string, ticker: TickerSpec | null, inDims: Dims = d, bitrate = 0): string[] {
  // The display is mostly static high-detail (gradients, glass, crisp text), so a low
  // CBR starved it and it went blocky/banded. Give it a generous bitrate — the content
  // compresses well so this only spends bits where detail actually needs them — and use
  // a slightly better preset (the heavy work is the 1 fps SVG render, so the encoder has
  // ample headroom). GOP is one keyframe per second at the output fps.
  const ofps = ticker ? TICKER_FPS : 15;
  // With a ticker we feed genuine CFR frames at TICKER_FPS (the pipeline duplicates the
  // last render in real time), so the input framerate IS the output framerate and there
  // is no `fps=` filter. Without a ticker the SVG-per-second feed (1 fps) is upsampled by
  // the `fps=15` filter as before (static content, no motion to stutter).
  const inFps = ticker ? TICKER_FPS : 1;
  const br = bitrate > 0 ? bitrate : d.height >= 1080 ? 8000 : 4000;
  const buf = br * 2;
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${inDims.width}x${inDims.height}`, '-framerate', `${inFps}`, '-i', 'pipe:0',
    '-vf', timetableVf(d, ticker, inDims), '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-profile:v', 'baseline', '-level', levelFor(d.height),
    '-g', `${ofps}`, '-keyint_min', `${ofps}`, '-sc_threshold', '0', '-bf', '0',
    '-x264-params', 'repeat-headers=1:nal-hrd=cbr',
    '-b:v', `${br}k`, '-maxrate', `${br}k`, '-bufsize', `${buf}k`,
    '-an', '-f', 'rtsp', '-rtsp_transport', 'tcp', target,
  ];
}

function transcodeArgs(url: string, d: Dims, target: string): string[] {
  const br = d.height >= 1080 ? 4500 : 2500;
  return [
    '-hide_banner', '-loglevel', 'warning',
    // Defence-in-depth: even if a non-rtsp URL ever slipped past validation, ffmpeg
    // may only speak these protocols (no file:/http:/concat: local read or SSRF).
    // `srtp` is included so secure cameras (e.g. UniFi's rtsps://…?enableSrtp) work.
    // (We do NOT pass -tls_verify: ffmpeg doesn't verify rtsps certs by default, which
    // is what self-signed local cameras need, and the flag isn't accepted by every
    // ffmpeg build — passing it made some builds bail out, breaking rtsps.)
    '-protocol_whitelist', 'rtp,rtcp,udp,tcp,rtsp,rtsps,srtp,tls,crypto',
    '-rtsp_transport', 'tcp', '-i', url,
    '-map', '0:v:0',
    '-vf', `scale=${d.width}:${d.height}:force_original_aspect_ratio=decrease,pad=${d.width}:${d.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p,fps=15`,
    '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-profile:v', 'main', '-level', levelFor(d.height),
    '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-bf', '0',
    '-x264-params', 'repeat-headers=1',
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
      '-protocol_whitelist', 'rtp,rtcp,udp,tcp,rtsp,rtsps,srtp,tls,crypto',
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
    return timetableArgs(this.dims, this.target(), this.tickerSpec(), this.renderDims, this.bitrate);
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
    if (this.rendering) return false; // a render is still in flight — let it finish
    const sec = Math.floor(Date.now() / 1000);
    if (sec === this.lastSec) return false;
    this.lastSec = sec;
    this.rendering = true;
    this.worker
      // Stamp the frame at the whole second so the clock/countdown land exactly on it.
      .raw(tt, sec * 1000, this.renderDims.width)
      .then((img) => {
        this.rendering = false;
        if (this.stopped) return;
        if (img.width !== this.renderDims.width || img.height !== this.renderDims.height) return;
        this.lastFrame = img; // the write pump feeds this to ffmpeg
      })
      .catch((err) => {
        this.rendering = false;
        if (!this.stopped) log.debug(`render ${this.id} failed: ${err instanceof Error ? err.message : String(err)}`);
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
    s.write(img.pixels);
    this.lastWriteSlot = slot;
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

  stopAll(): void {
    for (const p of this.timetables.values()) p.stop();
    for (const e of this.transcodes.values()) e.pipe.stop();
    this.timetables.clear();
    this.transcodes.clear();
  }
}
