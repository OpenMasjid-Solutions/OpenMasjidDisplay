// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * pi/decode.ts — which decoder to use for a camera, and why.
 *
 * A Raspberry Pi 4 has TWO hardware video decoders and they are not the same kind of thing. Getting
 * that wrong is the single easiest way to make this migration fail silently, so the whole decision
 * lives here, in one place, as pure functions that can be tested without any Pi at all.
 *
 *   H.264  goes to the older VideoCore block, a STATEFUL V4L2 M2M device (/dev/video10, driver
 *          bcm2835-codec). ffmpeg drives it with `-c:v h264_v4l2m2m`. Published ceiling: 1080p60.
 *
 *   H.265  goes to a SEPARATE, dedicated block — rpivid — which is a STATELESS V4L2 decoder using
 *          the kernel request API (/dev/video19, needs `dtoverlay=rpivid-v4l2`). ffmpeg drives it
 *          with `-hwaccel drm`, NOT with a `-c:v` decoder. Published ceiling: 2160p (4K).
 *
 * ── THE TRAP, and it is a nasty one ──
 *
 * `ffmpeg -decoders` on a Raspberry Pi lists `hevc_v4l2m2m`. Using it is wrong. That wrapper was
 * written for STATEFUL m2m decoders and the Pi's HEVC block is stateless, so it is a decoder that
 * exists, is advertised, and does not work. Anything that picks a decoder by pattern-matching
 * "<codec>_v4l2m2m" will therefore look correct, pass a naive test, and fail on real hardware — the
 * exact shape of mistake that cost this project weeks on the Pi 3. So the mapping below is a table
 * with two hand-written entries, not a rule.
 *
 * ── Why hardware HEVC needs the right ffmpeg BUILD, not just the right flag ──
 *
 * `-hwaccel drm` only exists if ffmpeg was configured `--enable-v4l2-request --enable-libdrm`.
 * Raspberry Pi OS's own ffmpeg package (the `+rpt` build) is; a generic Debian one is not. That is
 * not something to assume — `hwaccels()` below asks the binary, the same way `socketTimeoutFlag`
 * already asks it about `-timeout`.
 *
 * ── What is actually known here ──
 *
 * There is no Pi 4 to measure, and the Pi 3 work is a long lesson in what happens when a plausible
 * belief goes unmeasured. So every number below is labelled with where it came from, nothing is
 * inferred silently, and the decision always produces a `why` string that the screen reports —
 * so the first real Pi 4 says which path it took instead of leaving somebody guessing.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export type Codec = 'h264' | 'hevc' | 'other';

/** What the source turned out to be. Everything here comes from ffprobe, never from a guess. */
export interface SourceInfo {
  codec: Codec;
  width: number;
  height: number;
  /** frames per second as the source advertises it; 0 when it does not say */
  fps: number;
}

/** What this particular board and this particular ffmpeg can actually do. All probed, none assumed. */
export interface HwCaps {
  /** ffmpeg lists the `drm` hwaccel, i.e. it was built with --enable-v4l2-request */
  drmHwaccel: boolean;
  /** ffmpeg has the stateful H.264 M2M wrapper */
  h264M2m: boolean;
  /** the rpivid stateless HEVC decoder is present as a device */
  rpivid: boolean;
  /** the board as the firmware describes it, for the log and for the model gate */
  model: string;
}

export type DecodeKind = 'hw-drm' | 'hw-m2m' | 'software';

export interface DecodePlan {
  kind: DecodeKind;
  /** Plain-language reason, reported to the dashboard. This is the instrumentation. */
  why: string;
}

/**
 * Published decode ceilings for a Pi 4, from Raspberry Pi's own specification for the board
 * ("H.265 4Kp60 decode, H.264 1080p60 decode").
 *
 * DOCUMENTED, not measured. Treat them as the best available answer and not as gospel: on the Pi 3
 * the equivalent H.264 ceiling was never published in a form that predicted the actual failure, and
 * a 2688x1512 level-5.0 stream failed to open with an error that named a missing file. If a real Pi 4
 * turns out to differ, THIS is the constant to correct, and `why` in the plan below is what will
 * have told you.
 */
export const HW_MAX = {
  h264: { width: 1920, height: 1080 },
  hevc: { width: 3840, height: 2160 },
} as const;

/** Parse `ffmpeg -hwaccels`. The list is one per line under a header line. */
export function parseHwaccels(out: string): string[] {
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^hardware acceleration methods:/i.test(l));
}

/** Parse `ffmpeg -decoders` for the V4L2 wrappers we care about. */
export function parseDecoders(out: string): { h264M2m: boolean } {
  return { h264M2m: /\bh264_v4l2m2m\b/.test(out) };
}

/**
 * Is this a board we support?
 *
 * Pi 3 support was dropped deliberately, and this is the gate. Matching on the model string rather
 * than on a capability because the decision is a product one, not a technical one — a Pi 3 can still
 * *run* the agent, it just is not something anybody should be asked to put on a wall.
 *
 * Written to accept anything NEWER than a Pi 4 too. A model check that lists only the boards that
 * existed when it was written is a check that refuses next year's hardware.
 */
export function isSupportedBoard(model: string): boolean {
  const m = model.toLowerCase();
  if (!m.includes('raspberry pi')) return true; // not a Pi at all: not ours to refuse
  const gen = /raspberry pi\s+(\d+)/.exec(m);
  if (!gen) return true; // a name we do not recognise — do not refuse on a guess
  return Number(gen[1]) >= 4;
}

/** Why a board was refused, in words somebody standing in a masjid can act on. */
export function unsupportedBoardMessage(model: string): string {
  return (
    `This screen needs a Raspberry Pi 4 or newer. This board reports itself as "${model.trim() || 'unknown'}", ` +
    'and support for the Pi 3 has ended — it could not keep up with a modern camera and there is no ' +
    'version of this software that changes that.'
  );
}

const fits = (s: SourceInfo, max: { width: number; height: number }): boolean =>
  s.width > 0 && s.height > 0 && s.width <= max.width && s.height <= max.height;

const dims = (s: SourceInfo): string =>
  s.width && s.height ? `${s.width}x${s.height}` : 'an unknown size';

/**
 * Pick a decoder for this source on this board, and say why in words worth reading.
 *
 * The `why` is not decoration. On the Pi 3 the reason a camera was slow lived nowhere: the code
 * fell back to software silently and a masjid saw a stuttering picture with no explanation, for
 * months. Every branch here produces a sentence, and the agent reports it.
 */
export function chooseDecode(src: SourceInfo, caps: HwCaps): DecodePlan {
  if (src.codec === 'hevc') {
    if (!caps.drmHwaccel) {
      return {
        kind: 'software',
        why: 'This camera is H.265, which this board can decode in hardware — but this copy of ffmpeg was not built with the support needed to reach it, so the picture is being decoded in software.',
      };
    }
    if (!caps.rpivid) {
      return {
        kind: 'software',
        why: 'This camera is H.265 and the hardware decoder for it is switched off in this Pi\'s boot settings, so the picture is being decoded in software. Re-running setup turns it on.',
      };
    }
    if (!fits(src, HW_MAX.hevc)) {
      return {
        kind: 'software',
        why: `This H.265 camera is ${dims(src)}, which is larger than the ${HW_MAX.hevc.width}x${HW_MAX.hevc.height} the hardware decoder handles, so the picture is being decoded in software. A smaller stream from the same camera would use the hardware.`,
      };
    }
    return { kind: 'hw-drm', why: `Decoding this ${dims(src)} H.265 camera in hardware.` };
  }

  if (src.codec === 'h264') {
    if (!caps.h264M2m) {
      return {
        kind: 'software',
        why: 'This camera is H.264 and this copy of ffmpeg has no hardware decoder for it, so the picture is being decoded in software.',
      };
    }
    if (!fits(src, HW_MAX.h264)) {
      return {
        kind: 'software',
        why: `This H.264 camera is ${dims(src)}, which is above the ${HW_MAX.h264.width}x${HW_MAX.h264.height} this board decodes in hardware, so the picture is being decoded in software. Its 1080p or 720p stream would use the hardware instead, and look the same on a television.`,
      };
    }
    return { kind: 'hw-m2m', why: `Decoding this ${dims(src)} H.264 camera in hardware.` };
  }

  return {
    kind: 'software',
    why: 'This camera is not H.264 or H.265, so there is no hardware decoder for it and the picture is being decoded in software.',
  };
}

/**
 * The ffmpeg arguments this plan needs, which must go BEFORE -i.
 *
 * Both forms select a decoder for the input, and a decoder chosen after -i applies to nothing — the
 * same rule the existing `-c:v h264_v4l2m2m` placement already follows, with a test asserting it.
 *
 * Deliberately NOT setting `-hwaccel_output_format`. Left alone, ffmpeg transfers hardware frames
 * back to system memory automatically when the filter chain needs them, which ours does because it
 * ends at a framebuffer write. Pinning the output to drm_prime would be a second guess stacked on an
 * untested first one, and it would fail as a filter-graph error rather than something a masjid could
 * read. If a real Pi 4 shows the automatic transfer is not happening, this is the place to add it.
 */
export function decodeArgs(plan: DecodePlan): string[] {
  if (plan.kind === 'hw-drm') return ['-hwaccel', 'drm'];
  if (plan.kind === 'hw-m2m') return ['-c:v', 'h264_v4l2m2m'];
  return [];
}

/** Map ffprobe's codec_name onto what we decide with. */
export function codecFrom(name: string): Codec {
  const n = name.trim().toLowerCase();
  if (n === 'h264' || n === 'avc1') return 'h264';
  if (n === 'hevc' || n === 'h265' || n === 'hvc1') return 'hevc';
  return 'other';
}

/**
 * Read a stream's shape out of ffprobe's `-of default=nw=1` output.
 *
 * Line-oriented rather than JSON on purpose: it is a handful of `key=value` lines, and parsing them
 * needs nothing that could throw on a camera that answers oddly. `avg_frame_rate` arrives as a
 * rational like `30/1`, and as `0/0` for a source that will not say.
 */
export function parseProbe(out: string): SourceInfo {
  const get = (k: string): string => new RegExp(`^${k}=(.*)$`, 'm').exec(out)?.[1]?.trim() ?? '';
  const num = (v: string): number => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const rate = get('avg_frame_rate');
  const [a, b] = rate.split('/').map((x) => Number.parseInt(x, 10));
  const fps = Number.isFinite(a) && Number.isFinite(b) && b > 0 ? Math.round(a / b) : 0;
  return {
    codec: codecFrom(get('codec_name')),
    width: num(get('width')),
    height: num(get('height')),
    fps: fps > 0 && fps < 1000 ? fps : 0,
  };
}

// ── the probed side: everything above is pure, everything below touches the machine ──────────────

let caps: HwCaps | undefined;

/** Test seam, matching socketTimeoutFlag's. */
export function __resetCapsForTests(): void {
  caps = undefined;
}

/**
 * What this board and this ffmpeg can do. Probed once and cached for the life of the process.
 *
 * Never throws. Every failure reads as "no hardware", which costs a slower picture — while a throw
 * here would cost the whole screen. That is not a precaution written in advance: on the Pi 3, a fact
 * gathered only in order to draw an icon once took a television down through sixteen restarts.
 */
export function hwCaps(ffmpeg = 'ffmpeg', probe?: (args: string[]) => string): HwCaps {
  if (caps) return caps;
  const run = (args: string[]): string => {
    try {
      return probe
        ? probe(args)
        : execFileSync(ffmpeg, args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return '';
    }
  };
  let model = '';
  try {
    model = fs.readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').trim().slice(0, 80);
  } catch {
    /* not a Pi, or a kernel that does not say. The model gate treats that as "do not refuse". */
  }
  let rpivid = false;
  try {
    // The device the rpivid stateless HEVC decoder appears as. Its absence is a boot-config
    // problem, not a missing chip, and the message in chooseDecode says so.
    rpivid = fs.existsSync('/dev/video19');
  } catch {
    /* treated as absent */
  }
  caps = {
    drmHwaccel: parseHwaccels(run(['-hide_banner', '-hwaccels'])).includes('drm'),
    h264M2m: parseDecoders(run(['-hide_banner', '-decoders'])).h264M2m,
    rpivid,
    model,
  };
  return caps;
}
