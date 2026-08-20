// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * pi/video.ts — the camera, opened by the Pi itself.
 *
 * This file is the reason the Raspberry Pi screen exists at all.
 *
 * Every other kind of screen is fed video BY the display server: the server pulls the camera,
 * re-publishes it, and each screen relays from there. That works when the server is in the same
 * building as the camera. It falls apart when it is not — a browser screen on a cloud-hosted
 * server sends the picture up to the cloud and back down again, and the measured result was a
 * frame every couple of minutes. The Pi is on the same network as the camera, so it is handed the
 * camera's own address and opens it directly. The server carries none of the video, and a
 * cloud-hosted display server becomes possible.
 *
 * ffmpeg draws straight to `/dev/fb0` rather than handing frames back to us. At 1080p25 a decoded
 * frame is 8 MB, which is 200 MB/s through a pipe — not something a Pi 3 is going to do. The
 * kernel's framebuffer output device writes those bytes where they already need to be.
 *
 * The security posture here is the same one the server uses, and for the same reasons
 * (CLAUDE.md §4): **array-form spawn** so a crafted URL cannot become an argument, and an
 * explicit **`-protocol_whitelist` of stream protocols only** so it cannot become a local file
 * read either. The URL arrives over an authenticated channel from our own server, which has
 * already validated it — this is the second lock on the same door, not the first.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import type { FbGeometry } from './framebuffer';

/**
 * Exactly the list the display server allows, character for character.
 *
 * The two MUST agree. A protocol the app accepts but the player refuses is a camera that saves
 * fine in the dashboard and then silently shows nothing on this screen — which is the same class
 * of bug the server's own comment records having been bitten by.
 */
export const FF_PROTOCOLS = 'rtp,rtcp,udp,tcp,rtsp,rtsps,srtp,tls,crypto,rtmp,rtmps';

/**
 * How long ffmpeg may sit on a silent socket before giving up, in microseconds.
 *
 * Without this there is no bound at all. The RTSP demuxer defaults its timeout to zero and passes
 * that down to tcp/tls, and with interleaved TCP there is no keepalive — so a mid-stream network
 * failure blocks the read forever with the socket nominally open. Because the output is the
 * framebuffer, the last decoded frame then stays on the television indefinitely: a still,
 * entirely plausible picture of the camera, with nothing in the log, nothing counted as a
 * failure, and nothing reported to the dashboard. It is the worst failure in this file precisely
 * because it does not look like one.
 */
const SOCKET_TIMEOUT_US = 10_000_000;

/**
 * Which spelling of the socket timeout this ffmpeg understands.
 *
 * It moved: on 4.x the microsecond socket timeout is `-stimeout` and `-timeout` means how long to
 * wait for an incoming connection; from 5.0 `-timeout` took over the socket meaning. Guessing
 * wrong is not harmless — ffmpeg rejects an unknown option and the camera never plays at all.
 *
 * So ask it, once, the same way the installer asks whether it can write to a framebuffer. A build
 * that answers neither gets no flag: an unbounded read is bad, and no video at all is worse.
 */
let timeoutFlag: string | null | undefined;
export function socketTimeoutFlag(ffmpeg = 'ffmpeg', probe?: (bin: string) => string): string | null {
  if (timeoutFlag !== undefined) return timeoutFlag;
  let help = '';
  try {
    help = probe
      ? probe(ffmpeg)
      : execFileSync(ffmpeg, ['-hide_banner', '-h', 'demuxer=rtsp'], {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
  } catch {
    help = '';
  }
  timeoutFlag = pickTimeoutFlag(help);
  return timeoutFlag;
}

/** Pure half of the above, so the version-sniffing is testable without ffmpeg. */
export function pickTimeoutFlag(help: string): string | null {
  // Prefer -timeout only when its own help text says microseconds; on 4.x that same name is the
  // listen timeout and setting it would break nothing visibly but bound nothing either.
  const timeoutLine = /^\s*-timeout\s+.*$/m.exec(help)?.[0] ?? '';
  if (/microsecond/i.test(timeoutLine)) return 'timeout';
  if (/^\s*-stimeout\s/m.test(help)) return 'stimeout';
  if (timeoutLine) return 'timeout';
  return null;
}

/** Test seam — the probe result is cached for the life of the process. */
export function __resetTimeoutFlagForTests(): void {
  timeoutFlag = undefined;
}

/** The pixel layout the kernel's framebuffer device expects, by depth. */
function pixFmt(bpp: number): string {
  return bpp === 16 ? 'rgb565le' : 'bgra';
}

/**
 * The command line for playing one camera onto this screen.
 *
 * Pure, and exported, because the arguments are the whole of the security posture and half of
 * the behaviour — and because there is no way to check them on a development machine other than
 * by reading them.
 *
 * `hw` asks for the Pi's hardware H.264 decoder. It is worth asking for: software-decoding 1080p
 * on a 1.4 GHz Cortex-A53 uses most of the board, and this screen has a timetable to draw as well.
 * It is also not always present or working, which is why the caller falls back rather than
 * insisting.
 */
export function videoArgs(
  url: string,
  geo: FbGeometry,
  opts: { hw: boolean; device: string; timeoutFlag?: string | null },
): string[] {
  const { width: w, height: h } = geo;
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    // Stream protocols only. Never file:, http: or concat: — that is what stops a crafted source
    // turning a camera into a local-file read.
    '-protocol_whitelist',
    FF_PROTOCOLS,
    // TCP rather than UDP: a masjid's wifi drops packets, and a torn picture reads as a broken
    // camera. The server pulls its own sources the same way.
    '-rtsp_transport',
    'tcp',
    // Bound the read. Before -i, because it is an option for the input.
    ...(opts.timeoutFlag ? [`-${opts.timeoutFlag}`, String(SOCKET_TIMEOUT_US)] : []),
    // The Pi's V4L2 hardware decoder, when we are trying it. Before -i, because it selects the
    // decoder for the input.
    ...(opts.hw ? ['-c:v', 'h264_v4l2m2m'] : []),
    '-i',
    url,
    // Video only. A camera's audio track has nowhere to go on a screen in a prayer hall.
    '-map',
    '0:v:0',
    '-an',
    // The framebuffer device will not scale, and refuses a size that is not exactly its own. Fit
    // inside and pad the rest black — never stretch, which makes a room look the wrong shape.
    '-vf',
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=${pixFmt(geo.bpp)}`,
    '-f',
    'fbdev',
    opts.device,
  ];
}

/**
 * Lines that are NOT the reason a camera failed.
 *
 * ffmpeg is chatty on stderr and most of it is progress or advice. Two lines in particular were
 * being shown to a masjid as the reason their camera was unavailable. One:
 *
 *   [swscaler @ 0x...] No accelerated colorspace conversion found from yuv420p to rgb565le.
 *
 * which is a performance note, not a failure. The other is GnuTLS reporting that the session has
 * been invalidated, which it emits only AFTER an earlier fatal error already killed the session —
 * so it is never the cause either. Both crowded out the line that says what actually went wrong.
 */
const NOISE =
  /^\s*(Input #|Stream #|Metadata:|Duration:|encoder|frame=|Press \[q\]|built with|configuration:|lib[a-z]+ +[0-9]|\[swscaler|deprecated|Last message repeated|Guessed Channel)/i;

/** Strip any user:pass@ from a URL before it can reach a log. Cameras are very often configured
 *  with credentials in the address, and the journal on a Pi is readable by anyone on the box. */
export function redactCreds(s: string): string {
  return s.replace(/(\w+:\/\/)[^@\s/]+@/g, '$1***@');
}

/**
 * Decide whether a failure is worth retrying without hardware decoding.
 *
 * A Pi whose kernel has no V4L2 M2M decoder fails immediately and consistently, so a fast failure
 * while hardware decoding is *a* signal — but it is a weak one, and taking it at face value was
 * wrong on real hardware. A TLS handshake that failed in four seconds logged "hardware decoding
 * unavailable", switched to software, and stayed there for the life of the process, because the
 * exit handler leaves `stopped` false so `play()` never reaches the line that re-arms it. The
 * board was decoding in software, at roughly double the processor cost, for no reason at all.
 *
 * Deliberately NOT error-string matching. A Debian build with no v4l2_m2m says
 * `Unknown decoder 'h264_v4l2m2m'`; a broken bcm2835-codec says
 * `ioctl(VIDIOC_STREAMON): Invalid argument`; an allowlist that misses either replaces this bug
 * with its inverse. Instead the caller drops hardware AT MOST ONCE per camera and re-arms it after
 * any run that lasted, so a wrong guess costs one attempt rather than the life of the device.
 */
export function shouldDropHardware(ranForMs: number, usedHw: boolean, alreadyTried: boolean): boolean {
  return usedHw && !alreadyTried && ranForMs < 5_000;
}

/**
 * Whether a run lasted long enough to count as healthy, resetting the backoff.
 *
 * Without this the failure count only ever rises: it is zeroed in `play()`, which no-ops on every
 * later poll because the camera has not changed. So a camera that drops every few minutes reaches
 * the 30-second cap within the first half hour, and from then on every recovery takes the full 30
 * seconds — half a minute of an ffmpeg error card on a prayer-hall wall, every single time. The
 * server already gets this right in renderer.ts and this mirrors it.
 */
export function ranHealthily(ranForMs: number): boolean {
  // TEN seconds, not thirty.
  //
  // Thirty was lifted from the server's own pipeline, where it guards something else, and on a real
  // camera it sat exactly on the failure it was supposed to absorb: a UniFi stream that played for
  // about thirty seconds and dropped scored as NOT healthy every single time, so the failure count
  // only ever climbed and the gap between attempts grew 1s, 2s, 4s … 30s. The drop stayed the same
  // and our response to it got steadily worse.
  //
  // A stream that played for ten seconds plainly connected, authenticated and delivered video. That
  // is a mid-stream drop, not a failure to start, and the right response is to try again at once.
  // A genuine connect failure — wrong address, refused, bad certificate — ends in under five
  // seconds and is still counted, so the backoff still protects a camera that is switched off.
  return ranForMs > 10_000;
}

/**
 * How long to wait before trying a camera again.
 *
 * Backs off, because a camera that is switched off at night should not have a process
 * relaunched at it every second until morning, but caps low enough that a camera coming back
 * shows up within a few seconds rather than a few minutes. Nobody is watching this device to
 * restart it.
 */
export function retryDelayMs(consecutiveFailures: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.min(5, Math.max(0, consecutiveFailures - 1)));
}

export interface VideoStatus {
  playing: boolean;
  /** the last thing ffmpeg complained about, already redacted */
  lastError: string;
  failures: number;
  hardware: boolean;
}

/**
 * One camera, kept on the screen.
 *
 * Owns a single ffmpeg process and restarts it when it dies, which it will: cameras are rebooted,
 * networks drop, and a masjid's screen has to come back without anyone attending to it. The
 * caller starts and stops it as the screen's content changes and otherwise leaves it alone.
 */
export class VideoPlayer {
  private proc: ChildProcess | null = null;
  private url = '';
  private geo: FbGeometry | null = null;
  private stopped = true;
  private hw = true;
  private failures = 0;
  private lastError = '';
  private startedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  /** Whether hardware decoding has already been given up on for THIS camera. Reset per camera, so
   *  a wrong guess costs one attempt rather than the life of the device. */
  private triedHw = false;
  /** Set only once hardware decoding has ACTUALLY produced a working stream. Until then there is
   *  nothing to fall back to, and retrying it costs a black screen every reconnect. */
  private hwEverWorked = false;

  constructor(
    private readonly device: string,
    private readonly log: (...a: unknown[]) => void,
    private readonly ffmpeg = 'ffmpeg',
  ) {}

  status(): VideoStatus {
    return { playing: !!this.proc, lastError: this.lastError, failures: this.failures, hardware: this.hw };
  }

  /** Start, or switch to a different camera. A no-op when already playing this one, so it can be
   *  called on every poll without restarting the picture every five seconds. */
  play(url: string, geo: FbGeometry): void {
    if (!this.stopped && this.url === url && this.geo?.width === geo.width) return;
    this.stop();
    this.url = url;
    this.geo = geo;
    this.stopped = false;
    this.failures = 0;
    this.hw = true;
    this.triedHw = false;
    this.spawn();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const p = this.proc;
    this.proc = null;
    if (p) {
      try {
        // SIGKILL rather than SIGTERM: ffmpeg writing to a framebuffer has nothing to flush, and
        // a lingering one would keep painting over the timetable we are about to draw.
        p.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }

  private spawn(): void {
    if (this.stopped || !this.geo) return;
    const args = videoArgs(this.url, this.geo, {
      hw: this.hw,
      device: this.device,
      timeoutFlag: socketTimeoutFlag(this.ffmpeg),
    });
    this.startedAt = Date.now();
    this.log(`camera: opening ${redactCreds(this.url)}${this.hw ? ' (hardware decoding)' : ''}`);

    let proc: ChildProcess;
    try {
      // Array-form, always. The URL is an argument, never part of a command string — that is what
      // stops a crafted source from becoming an extra flag.
      proc = spawn(this.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      this.lastError = (e as Error).message;
      this.failures++;
      this.scheduleRetry();
      return;
    }
    this.proc = proc;

    // Keep a TAIL, and prefer the FIRST error-looking line in it.
    //
    // The previous version took the last line of each chunk and let later chunks overwrite it.
    // ffmpeg prints the cause before the symptom, so that reliably threw away the useful line and
    // kept the useless one: the reported "The specified session has been invalidated for some
    // reason" is GnuTLS's second-order complaint, emitted only after an earlier fatal error had
    // already marked the session dead — and that earlier line is the one that says why.
    let tail = '';
    proc.stderr?.on('data', (b: Buffer) => {
      tail = (tail + redactCreds(String(b))).slice(-800);
      const first = tail
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !NOISE.test(l));
      if (first) this.lastError = first.slice(0, 300);
    });

    proc.on('exit', (code) => {
      if (this.proc !== proc) return; // superseded by a newer spawn
      this.proc = null;
      const ranFor = Date.now() - this.startedAt;
      // Note whether the HARDWARE decoder is what produced a working stream. Nothing else can tell
      // us that, and re-arming it later depends on it.
      if (this.hw && ranHealthily(ranFor)) this.hwEverWorked = true;
      if (this.stopped) return;

      // Exit code ZERO is not a failure.
      //
      // Seen on a real UniFi camera: it plays for about thirty seconds and ffmpeg exits 0, because
      // the server tore the RTSP session down and ffmpeg reports that as a clean end of stream.
      // Counting it as a failure grew the backoff for something that had just worked perfectly.
      // Reopen at once, and say what actually happened rather than printing an error.
      if (code === 0) {
        this.failures = 0;
        this.log(`camera: the stream ended after ${Math.round(ranFor / 1000)}s; reopening`);
        this.scheduleRetry();
        return;
      }

      if (shouldDropHardware(ranFor, this.hw, this.triedHw)) {
        // Might be a board with no working V4L2 decoder — or might be a TLS handshake that failed
        // in four seconds and has nothing to do with decoding. Try software ONCE, and say which it
        // is rather than asserting the decoder is missing.
        this.triedHw = true;
        this.hw = false;
        this.log(`camera: failed in ${Math.round(ranFor / 1000)}s with hardware decoding; trying software once: ${this.lastError}`);
        this.spawn();
        return;
      }

      if (ranHealthily(ranFor)) {
        // It ran. Whatever went wrong is a fresh problem, so start the backoff over — otherwise a
        // camera that drops every few minutes is stuck at the 30-second cap for good, and every
        // recovery shows half a minute of an error card on the wall.
        this.failures = 0;
        // Give the hardware decoder another chance ONLY if it has ever actually worked.
        //
        // It used to re-arm unconditionally. On a board whose V4L2 decoder does not exist — the
        // real log says "Could not find a valid device", every single attempt — that burned two
        // seconds of black screen on EVERY reconnect, for ever. And the healthy run that gets us
        // here was in software, so it says nothing whatever about the hardware.
        if (this.triedHw && this.hwEverWorked) {
          this.triedHw = false;
          this.hw = true;
        }
      }

      this.failures++;
      this.log(`camera: ffmpeg exited (${code ?? 'signal'}) after ${Math.round(ranFor / 1000)}s: ${this.lastError}`);
      this.scheduleRetry();
    });
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const wait = retryDelayMs(this.failures);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.spawn();
    }, wait);
  }
}
