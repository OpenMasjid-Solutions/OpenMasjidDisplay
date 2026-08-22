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
import { chooseDecode, decodeArgs, hwCaps, parseProbe, type DecodePlan, type SourceInfo } from './decode';

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
 * How long to let the "what is this camera?" probe run before giving up on it.
 *
 * Generous enough for an RTSP handshake plus a TLS one over a masjid's network, short enough that a
 * camera which accepts the connection and then says nothing does not hold a screen blank. Failing
 * the probe is not fatal — it means the decoder is chosen conservatively and the screen says it
 * could not tell — so the cost of this expiring is a slower picture, never a blank one.
 */
const PROBE_TIMEOUT_MS = 12_000;

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

/**
 * Arguments for asking a camera what it is, before deciding how to decode it.
 *
 * The protocol allowlist is here too, and that is not belt-and-braces. ffprobe takes the same
 * attacker-influenced URL that ffmpeg does and will just as happily be talked into reading a local
 * file or fetching an internal address — so the invariant that only STREAM protocols are permitted
 * has to hold at every place a source URL is handed to a process, not only at the one that plays it.
 * A source that ffmpeg refuses and ffprobe accepts would be a hole with a confusing shape.
 *
 * The URL is the last argument and a single one, for the same reason it is in videoArgs: array-form
 * spawn, never a command assembled into a string.
 */
export function probeArgs(url: string, timeoutFlag?: string | null): string[] {
  return [
    '-v',
    'error',
    '-protocol_whitelist',
    FF_PROTOCOLS,
    '-rtsp_transport',
    'tcp',
    ...(timeoutFlag ? [`-${timeoutFlag}`, String(SOCKET_TIMEOUT_US)] : []),
    // Only the first video stream. A camera can offer several, plus audio and metadata; the one
    // that will be played is 0:v:0, so that is the one whose shape decides the decoder.
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_name,width,height,avg_frame_rate',
    '-of',
    'default=nw=1',
    url,
  ];
}

/**
 * Frames a second to ask the camera for.
 *
 * A Pi 3 decoding in software — which is all it can do for a stream the V4L2 decoder will not open
 * — plus a colour conversion per frame, saturates the board. Fewer frames is less of both, and
 * nobody watching a prayer hall can tell 10fps from 25.
 *
 * Eight, and the number was chosen on a measurement that took two attempts to get right.
 *
 * The obvious metric is ffmpeg's `speed=`, and it is a trap on a LIVE source: it cannot exceed 1.0x
 * however much headroom there is, because the frames only arrive as fast as they are sent. So it
 * says whether the board is keeping up and nothing at all about by how much. Measured on a Pi 3 B+
 * against a 2688x1512 30fps camera, both 8 and 10 report a flat 1.0x and look equally fine.
 *
 * The metric that discriminates is CPU actually consumed. Measured on a Pi 4 Model B Rev 1.4 at
 * 1.8GHz, at 25fps, through the real pipeline, as cores of the four available:
 *
 *     1080p H.265, hardware        1.17 cores   (29% of the board)
 *     2688x1512 H.264, software    2.00 cores   (50%)
 *     4K H.265, hardware           2.34 cores   (58%)   <- the worst case measured
 *
 * So even the heaviest camera anybody is likely to point at this leaves 42% of the board for the
 * agent's own work — check-ins, fetching assets, drawing a frame — which is twice the margin the
 * Pi 3 needed.
 *
 * The contrast is the whole point of the migration. The SAME 2688x1512 camera on a Pi 3 needed
 * 3.15 cores at EIGHT frames a second, and still lost the stream every half minute, because falling
 * behind a live source grows the lag without limit until the camera hangs up. A Pi 4 shows it at 25
 * using half the board.
 *
 * The Pi 3 numbers are kept here rather than deleted because they are what makes the ceiling
 * legible: 8 was not a taste, it was the most that board could sustain, and 25 is not ambition, it
 * is measured with room to spare.
 */
const CAMERA_FPS = 25;

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
 * `plan` says which decoder to use, and it is a three-way choice rather than a boolean because a
 * Pi 4 has two unrelated hardware decoders reached in two different ways — see pi/decode.ts, which
 * owns that decision and is where the reasoning lives. This function only turns the decision into
 * arguments; it does not make it.
 */
export function videoArgs(
  url: string,
  geo: FbGeometry,
  opts: { plan: DecodePlan; device: string; timeoutFlag?: string | null; rotate?: number },
): string[] {
  const { width: w, height: h } = geo;
  // The same rotation the timetable gets, for the same reason: a television turned on its side has
  // to be sent a turned picture, and under KMS the firmware's rotate options do nothing. ffmpeg
  // draws to /dev/fb0 itself, so it has to do its own turning — this agent never sees these frames.
  //
  // Placed BEFORE the scale, so the scale still targets the framebuffer's real dimensions and the
  // pad still fills it. Transposing after scaling would produce a frame the framebuffer refuses.
  // Cheap here because it runs on the already-fps-limited stream: 12 frames a second, not the
  // camera's 25.
  const turn =
    opts.rotate === 90 ? 'transpose=1,' : opts.rotate === 270 ? 'transpose=2,' : opts.rotate === 180 ? 'hflip,vflip,' : '';
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
    // The hardware decoder, when there is one to use. Before -i in every form, because these
    // select the decoder FOR THE INPUT — one placed after -i applies to nothing at all, silently.
    // That holds for `-hwaccel drm` exactly as it does for `-c:v h264_v4l2m2m`.
    ...decodeArgs(opts.plan),
    '-i',
    url,
    // Video only. A camera's audio track has nowhere to go on a screen in a prayer hall.
    '-map',
    '0:v:0',
    '-an',
    // The framebuffer device will not scale, and refuses a size that is not exactly its own. Fit
    // inside and pad the rest black — never stretch, which makes a room look the wrong shape.
    '-vf',
    // Order matters, and every stage here is there to spend less of the board.
    //
    // `fps` FIRST, before scaling or converting: dropping frames early means the expensive stages
    // run on fewer of them. A masjid measured `Consumed 12min CPU` over twelve minutes of wall
    // clock — a completely pegged core — which starved the timetable renderer down to a frame
    // every seven seconds. The server's own transcode has always capped itself the same way
    // (renderer.ts), and 12fps on a camera pointed at a prayer hall is not something anybody sees.
    //
    // `flags=area`, because the default is bicubic and the default is not free. Measured on a Pi 3
    // B+ against a 2688x1512 camera, writing real frames to /dev/fb0: bicubic 9.43 fps, area 10.68.
    // Area is also the RIGHT algorithm for a downscale — it averages the source region a pixel
    // covers — and it is the closest of the cheap filters to what bicubic produced (PSNR 44.4dB,
    // against bilinear's 43.4 and fast_bilinear's 36.2). On the other side, for a camera SMALLER
    // than the screen, swscale's area degenerates to bilinear: measured identical to bilinear to
    // two decimal places at both 640x480 and 1280x720 upscaled, so a small camera loses nothing.
    //
    // The conversion is ONE step, and it used to be two. The comment here used to justify going via
    // bgra: swscale has no accelerated yuv420p -> rgb565le path, it says so in the log and then does
    // it a pixel at a time in C, whereas the routes into and out of bgra are SIMD. That reasoning is
    // sound and the conclusion was still wrong, because it counted instructions and ignored memory.
    // The extra pass writes and re-reads an 8MB bgra frame, and a Pi 3 has far less memory bandwidth
    // than it has ALU. Measured, again writing to the real framebuffer: via bgra 6.31 fps, direct
    // 9.43 — the "optimisation" was costing a third of the frames.
    //
    // It cost nothing to remove, either. The same camera frame through both chains yields exactly
    // 268 distinct 16-bit colours, so there is no banding either way. (An earlier comparison across
    // separate live runs appeared to show a difference; it was comparing different moments of a
    // moving picture, not different conversions.)
    `fps=${CAMERA_FPS},${turn}scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=area,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=${pixFmt(
      geo.bpp,
    )}`,
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
  /^\s*(Input #|Stream #|Metadata:|Duration:|encoder|frame=|Press \[q\]|built with|configuration:|lib[a-z]+ +[0-9]|\[?swscaler|deprecated|Last message repeated|Guessed Channel)/i;

/** Warnings recognised wherever they appear in a line, not only at its start — because the tail is
 *  sliced to a fixed size and a warning can arrive with its opening bracket already cut off. */
const NOISE_ANYWHERE =
  /(no accelerated colorspace|chroma interpolation|terpolation for destination|not yet implemented|deprecated pixel format)/i;

/**
 * What an ffmpeg line has to look like before it is shown to a masjid as the reason a camera failed.
 *
 * This is an ALLOWLIST, and the inversion is the point. Blocklisting warnings was tried three times
 * and defeated three times by the same thing: the stderr tail is sliced to a fixed size, so a
 * warning arrives with its front cut off and no longer matches. The screen ended up reading
 *
 *     Camera unavailable
 *     terpolation for destination format 'rgb565le' not yet implemented
 *
 * which is a fragment of a performance note. A truncated warning can always be mistaken for an
 * unknown line; it can never be mistaken for a line that says a connection was refused. So the test
 * is now "does this state a failure" rather than "is this one of the warnings I thought of".
 *
 * When nothing matches, the screen says something plain instead of quoting ffmpeg — see
 * `cameraFailureText`. Less detail on the wall, and the full tail is still in the log.
 */
const ERROR_SHAPE =
  // NOTE the word boundaries on the status codes. Without them, `4\d\d|5\d\d` matched the "565"
  // inside "rgb565le" — so the very warning this allowlist exists to exclude was being quoted as an
  // error by the pattern meant to catch HTTP failures.
  /(connection (refused|timed out|reset)|failed|unauthorized|forbidden|not found|invalid|no route|unreachable|timed out|timeout|refused|denied|does not contain|could not|unable to|error|\b[45]\d\d\b)/i;

/**
 * The line to put on the television, or a plain sentence when nothing qualifies.
 *
 * Pure so the classification is testable, which matters: every wrong answer here has been visible
 * to a congregation.
 */
/**
 * ffmpeg prefixes most lines with the component that emitted them and its address in memory, e.g.
 * `[tls @ 0x557cc6a7e0] `. On a television that is a meaningless eight-byte number in front of the
 * only part anybody can read, so it comes off every line before it is shown.
 */
export function stripFfmpegTag(line: string): string {
  return line.replace(/^\s*(?:\[[^\]]*@\s*0x[0-9a-f]+\]\s*)+/gi, '').trim();
}

/**
 * Messages that state a failure — so ERROR_SHAPE rightly matches them — but say nothing a masjid
 * can act on, paired with what they actually mean.
 *
 * "Error in the pull function" is the one that prompted this: it is GnuTLS's generic read failure,
 * shown verbatim on a masjid's wall under "Camera unavailable". It is a true statement about a
 * function nobody watching has heard of. The allowlist was right to let it through — it IS the
 * error — and quoting it was still the wrong call, so the fix belongs here rather than in the
 * pattern that classifies lines.
 *
 * Deliberately short. Every entry has to be a message seen on real hardware, because guessing at
 * ffmpeg phrasings is how the noise filters above got defeated three times.
 */
const OPAQUE: [RegExp, string][] = [
  [
    /error in the (pull|push) function/i,
    'The secure connection to this camera failed. Check its address and port, and that the camera still has its stream switched on.',
  ],
  [
    /immediate exit requested/i,
    'The camera stopped responding and the connection was given up.',
  ],
];

export function cameraFailureText(tail: string, truncated: boolean): string {
  const lines = tail.split('\n');
  // A sliced first line is a fragment and cannot be classified — drop it outright.
  if (truncated && lines.length > 1) lines.shift();
  const hit = lines
    .map((l) => l.trim())
    .find((l) => l && !NOISE.test(l) && !NOISE_ANYWHERE.test(l) && ERROR_SHAPE.test(l));
  if (!hit) return 'Could not play this camera. Its address or network may be wrong.';
  const clean = stripFfmpegTag(hit);
  for (const [pattern, plain] of OPAQUE) if (pattern.test(clean)) return plain;
  // Nothing left once the tag came off means the line WAS only a tag.
  return clean ? clean.slice(0, 300) : 'Could not play this camera. Its address or network may be wrong.';
}

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
  /** What this camera turned out to be, once probed. Absent until then. */
  source?: SourceInfo;
  /** Why this decoder was chosen, in words. Reported so a slow picture has an explanation. */
  decodeWhy?: string;
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
  /** Quarter turns to apply, matching the timetable's — see videoArgs. */
  private rotate = 0;
  private stopped = true;
  /** What was decided for this camera. Null until the source has been probed. */
  private plan: DecodePlan | null = null;
  /** What the camera turned out to be, from one ffprobe per camera. */
  private source: SourceInfo | null = null;
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
    /** Ships in the same package as ffmpeg; separate only so a test can point it elsewhere. */
    private readonly ffprobe = 'ffprobe',
  ) {}

  status(): VideoStatus {
    return {
      playing: !!this.proc,
      lastError: this.lastError,
      failures: this.failures,
      hardware: this.plan ? this.plan.kind !== 'software' : false,
      source: this.source ?? undefined,
      decodeWhy: this.plan?.why,
    };
  }

  /** Start, or switch to a different camera. A no-op when already playing this one, so it can be
   *  called on every poll without restarting the picture every five seconds. */
  play(url: string, geo: FbGeometry, rotate = 0): void {
    // The rotation is part of "is this the same picture": changing it while a camera is playing has
    // to restart ffmpeg, because the filter chain is fixed at spawn.
    if (!this.stopped && this.url === url && this.geo?.width === geo.width && this.rotate === rotate) return;
    this.stop();
    this.url = url;
    this.geo = geo;
    this.rotate = rotate;
    this.stopped = false;
    this.failures = 0;
    this.plan = null;
    this.source = null;
    this.triedHw = false;
    // Asking the camera what it is takes a second or two, so it must not happen on this thread:
    // play() is called from the drawing loop, and blocking there would stop the clock. The loop
    // already holds the last frame for a few seconds before it says anything is wrong, which is
    // exactly the gap this leaves.
    void this.decideThenSpawn(url);
  }

  /**
   * Ask the camera what it is, choose a decoder, then start.
   *
   * One ffprobe per camera, rather than the old try-hardware-and-see. On a Pi 3 there was one
   * hardware decoder and one thing to try, so a wrong guess cost a single failed attempt. A Pi 4 has
   * two unrelated decoders reached in two different ways, and guessing between them makes a wrong
   * guess indistinguishable from a broken camera — while asking costs one cheap process and yields
   * the actual numbers needed to tell somebody their camera is too big for the hardware.
   */
  private async decideThenSpawn(url: string): Promise<void> {
    const src = await this.probeSource(url);
    // The screen may have been switched to something else while we were asking.
    if (this.stopped || this.url !== url) return;
    this.source = src;
    this.plan = chooseDecode(src, hwCaps(this.ffmpeg));
    this.log('camera: ' + this.plan.why);
    this.spawn();
  }

  /**
   * What this camera is sending. Never throws, and never holds the screen up for long.
   *
   * A probe that fails leaves an unknown source, and chooseDecode treats an unknown size as "do not
   * claim this fits the hardware" — so it is decoded in software and the screen says it could not
   * tell. That is the honest failure. Handing an oversized stream to a decoder that cannot open it
   * is what produced the Pi 3's "No such file or directory", and sent everyone looking at device
   * permissions for a week.
   */
  private probeSource(url: string): Promise<SourceInfo> {
    return new Promise((resolve) => {
      const unknown: SourceInfo = { codec: 'other', width: 0, height: 0, fps: 0 };
      let done = false;
      const finish = (v: SourceInfo): void => {
        if (done) return;
        done = true;
        resolve(v);
      };
      try {
        // Array-form, and with the same protocol allowlist ffmpeg gets — see probeArgs.
        const p = spawn(this.ffprobe, probeArgs(url, socketTimeoutFlag(this.ffmpeg)), {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        let out = '';
        p.stdout?.on('data', (b: Buffer) => {
          out = (out + String(b)).slice(0, 4000);
        });
        p.on('error', () => finish(unknown));
        p.on('exit', () => finish(out ? parseProbe(out) : unknown));
        // A camera that accepts the connection and then says nothing must not stall the screen.
        const t = setTimeout(() => {
          try {
            p.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          finish(unknown);
        }, PROBE_TIMEOUT_MS);
        t.unref?.();
      } catch {
        finish(unknown);
      }
    });
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
    const plan: DecodePlan = this.plan ?? { kind: 'software', why: 'Decoding in software.' };
    const args = videoArgs(this.url, this.geo, {
      rotate: this.rotate,
      plan,
      device: this.device,
      timeoutFlag: socketTimeoutFlag(this.ffmpeg),
    });
    this.startedAt = Date.now();
    this.log(
      `camera: opening ${redactCreds(this.url)}${plan.kind === 'software' ? '' : ' (hardware decoding)'}`,
    );

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
      const before = tail.length + String(b).length;
      tail = (tail + redactCreds(String(b))).slice(-800);
      this.lastError = cameraFailureText(tail, before > 800);
    });

    proc.on('exit', (code) => {
      if (this.proc !== proc) return; // superseded by a newer spawn
      this.proc = null;
      const ranFor = Date.now() - this.startedAt;
      // Note whether the HARDWARE decoder is what produced a working stream. Nothing else can tell
      // us that, and re-arming it later depends on it.
      const wasHardware = this.plan ? this.plan.kind !== 'software' : false;
      if (wasHardware && ranHealthily(ranFor)) this.hwEverWorked = true;
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

      if (shouldDropHardware(ranFor, wasHardware, this.triedHw)) {
        // Might be a decoder that will not open this particular stream — or might be a TLS
        // handshake that failed in four seconds and has nothing to do with decoding. Try software
        // ONCE, and say which it is rather than asserting the decoder is missing.
        //
        // This is the safety net UNDER the probe, not a replacement for it. The probe decides from
        // the source's real codec and size; this catches the case where the hardware refuses a
        // stream that should have fitted. Both are needed, because a published ceiling is not the
        // same thing as what the silicon actually does — the Pi 3 taught that at length.
        this.triedHw = true;
        this.plan = {
          kind: 'software',
          why: 'The hardware decoder would not open this camera, so the picture is being decoded in software.',
        };
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
        // Re-derived from what the camera actually is, rather than flipped back to "hardware".
        // With two decoders there is no single hardware setting to restore — the right one depends
        // on the codec — so the decision is simply taken again from the probe we already have.
        if (this.triedHw && this.hwEverWorked && this.source) {
          this.triedHw = false;
          this.plan = chooseDecode(this.source, hwCaps(this.ffmpeg));
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
