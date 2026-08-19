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
import { spawn, type ChildProcess } from 'node:child_process';
import type { FbGeometry } from './framebuffer';

/**
 * Exactly the list the display server allows, character for character.
 *
 * The two MUST agree. A protocol the app accepts but the player refuses is a camera that saves
 * fine in the dashboard and then silently shows nothing on this screen — which is the same class
 * of bug the server's own comment records having been bitten by.
 */
export const FF_PROTOCOLS = 'rtp,rtcp,udp,tcp,rtsp,rtsps,srtp,tls,crypto,rtmp,rtmps';

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
export function videoArgs(url: string, geo: FbGeometry, opts: { hw: boolean; device: string }): string[] {
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

/** Strip any user:pass@ from a URL before it can reach a log. Cameras are very often configured
 *  with credentials in the address, and the journal on a Pi is readable by anyone on the box. */
export function redactCreds(s: string): string {
  return s.replace(/(\w+:\/\/)[^@\s/]+@/g, '$1***@');
}

/**
 * Decide whether a failure is worth retrying without hardware decoding.
 *
 * A Pi whose kernel has no V4L2 M2M decoder, or whose ffmpeg was built without it, fails
 * immediately and consistently — so a *fast* failure while hardware decoding is the signal.
 * A stream that ran for a while and then stopped is a network problem, and dropping to software
 * decoding would not help; it would just quietly double the processor use for the rest of the
 * device's life.
 */
export function shouldDropHardware(ranForMs: number, usedHw: boolean): boolean {
  return usedHw && ranForMs < 5_000;
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
    const args = videoArgs(this.url, this.geo, { hw: this.hw, device: this.device });
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

    proc.stderr?.on('data', (b: Buffer) => {
      const line = redactCreds(String(b).trim()).split('\n').pop() ?? '';
      if (line) this.lastError = line.slice(0, 300);
    });

    proc.on('exit', (code) => {
      if (this.proc !== proc) return; // superseded by a newer spawn
      this.proc = null;
      const ranFor = Date.now() - this.startedAt;
      if (this.stopped) return;

      if (shouldDropHardware(ranFor, this.hw)) {
        // The board or this ffmpeg build has no working V4L2 decoder. Say so once and carry on
        // in software rather than looping on a request that will never succeed.
        this.log('camera: hardware decoding unavailable, falling back to software');
        this.hw = false;
        this.spawn();
        return;
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
