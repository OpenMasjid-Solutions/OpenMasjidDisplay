// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * pi/raster.ts — fitting a rendered frame onto whatever television is plugged in.
 *
 * Every screen this app draws is designed at a fixed size — 1920×1080, or 1080×1920 rotated —
 * because a layout that reflows per monitor is a layout nobody can check. A television, on the
 * other hand, reports whatever mode it negotiated: 1920×1080 usually, but 1280×1024 and 1024×768
 * are both common on the older panels a masjid is most likely to have spare, and an ultrawide
 * turns up occasionally.
 *
 * So the frame has to be fitted rather than assumed, and the fitting has to be *conservative*:
 * scale to fit inside the screen, keep the aspect ratio, and letterbox the remainder in black.
 * The alternative — stretching to fill — would make a prayer timetable subtly wrong in a way
 * nobody reports but everybody notices, and cropping would cut times off the edge.
 *
 * Both functions here are pure arithmetic on buffers, which is the point: this is the part that
 * is wrong on a monitor nobody testing has, so it is checked against sizes instead.
 */

/**
 * Which dimension to scale by so the whole frame fits.
 *
 * resvg scales by one axis and derives the other, so the choice is between "match the width and
 * let the height fall where it may" and the reverse. Matching the width is right when the screen
 * is *taller* relative to the design (the usual case: a 4:3 monitor showing a 16:9 design), and
 * wrong when it is wider, where it would render taller than the screen and get cut off.
 */
export function fitMode(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): { mode: 'width' | 'height'; value: number } {
  // Compare aspect ratios without dividing, so an odd size cannot land on a rounding edge.
  return srcW * dstH >= dstW * srcH ? { mode: 'width', value: dstW } : { mode: 'height', value: dstH };
}

/**
 * Copy an RGBA frame into the centre of a black frame of the screen's exact size.
 *
 * The output is always `dstW × dstH × 4` regardless of what came in, because that is what the
 * framebuffer demands — a buffer of any other length is a sheared or truncated picture. Anything
 * the source does not cover stays black, which is what letterboxing is.
 *
 * A source larger than the destination is clipped rather than rejected. It should not happen
 * after `fitMode`, but rounding in the renderer can produce a frame one pixel over, and one
 * clipped pixel row is a far better outcome than a screen that refuses to draw.
 */
export function blitCentered(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Buffer {
  const out = Buffer.alloc(dstW * dstH * 4);
  if (srcW <= 0 || srcH <= 0) return out;

  const offX = Math.max(0, Math.floor((dstW - srcW) / 2));
  const offY = Math.max(0, Math.floor((dstH - srcH) / 2));
  const copyW = Math.min(srcW, dstW);
  const copyH = Math.min(srcH, dstH);

  for (let y = 0; y < copyH; y++) {
    const s = y * srcW * 4;
    const d = ((y + offY) * dstW + offX) * 4;
    // A row at a time: this runs once a second forever on a Pi 3, and a per-pixel loop here was
    // measurably slower than letting the memcpy underneath do the work.
    out.set(src.subarray(s, s + copyW * 4), d);
  }
  return out;
}

/**
 * A rotated copy of an RGBA frame.
 *
 * ## Why this is in software and not in the boot config
 *
 * Turning a television on its side is the commonest thing a masjid asks for — a portrait timetable
 * in a corridor — and every guide answers it with `display_rotate=1` in `config.txt`. That option
 * belongs to the legacy firmware display stack and does nothing at all under `vc4-kms-v3d`, which
 * is what this installer configures. The KMS answer is a `video=…,rotate=90` on the kernel command
 * line, which works, and costs a reboot, a boot-partition edit, and a black screen if it is wrong.
 *
 * None of that is necessary here. This agent owns every pixel it puts on the screen: it renders an
 * SVG to RGBA and writes the bytes into `/dev/fb0` itself. So the rotation is four lines of index
 * arithmetic on a buffer we already have in hand — it takes effect on the next frame, needs no
 * reboot, cannot leave a screen black, and works the same on a board where the firmware options do
 * nothing.
 *
 * Cost, since this runs once a second forever: a 1920×1080 rotation is 2 million 4-byte reads at a
 * stride the cache dislikes. That is real but small beside rasterising the SVG in the first place,
 * which is tens of milliseconds. The 180° case is a straight reversal and much cheaper, so it is
 * kept separate rather than folded into the general one.
 *
 * `deg` is a clockwise rotation OF THE PICTURE: 90 moves the top of the picture to the right-hand
 * edge. Note that this is the opposite of how the television is mounted, and it is easy to get
 * backwards — a set physically turned clockwise needs the picture turned anticlockwise to come back
 * upright, so that mounting is 270 here, not 90. The panel names the mountings and stores these
 * numbers; the same convention as ffmpeg's `transpose` and the kernel's `video=…,rotate=`, which is
 * why the camera path can use the matching transpose value directly.
 */
export function rotateRgba(
  src: Uint8Array,
  w: number,
  h: number,
  deg: 0 | 90 | 180 | 270,
): { pixels: Uint8Array; width: number; height: number } {
  if (deg === 0 || w <= 0 || h <= 0) return { pixels: src, width: w, height: h };

  if (deg === 180) {
    // Every pixel maps to the one the same distance from the other end, so this is one pass
    // forwards and one backwards over the same buffer — no transposed stride at all.
    const out = new Uint8Array(w * h * 4);
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const s = i * 4;
      const d = (n - 1 - i) * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = src[s + 3];
    }
    return { pixels: out, width: w, height: h };
  }

  // The other two swap the axes, so the output is h × w.
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      // 90 clockwise: the pixel at (x, y) lands at (h - 1 - y, x) in an h-wide frame.
      // 270 clockwise is the same map run the other way.
      const dx = deg === 90 ? h - 1 - y : y;
      const dy = deg === 90 ? x : w - 1 - x;
      const d = (dy * h + dx) * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = src[s + 3];
    }
  }
  return { pixels: out, width: h, height: w };
}

/**
 * The box to draw into after allowing for overscan.
 *
 * A television that crops its input — old sets do it by default, and many still ship with it on —
 * eats the outermost few percent of the picture. On a photograph nobody notices; on a timetable it
 * takes the last row of times off the bottom, which is the one somebody is standing there to read.
 *
 * The firmware's `overscan_left`/`disable_overscan` options are the documented cure and, like
 * `display_rotate`, they belong to the legacy display stack. This does it in the frame instead:
 * render smaller and centre it, so the black margin absorbs whatever the set crops. It is the same
 * arithmetic as letterboxing, which `blitCentered` already does — the only new part is choosing a
 * target smaller than the screen.
 *
 * `percent` is per EDGE, so 5 takes five percent off each side and leaves ninety in the middle. It
 * is clamped to 0-15: beyond that the picture is small enough that the fix is the television's own
 * settings, and an unbounded value could shrink a screen to nothing.
 */
export function overscanBox(w: number, h: number, percent: unknown): { width: number; height: number } {
  const p = Number(percent);
  const pct = Number.isFinite(p) && p > 0 ? Math.min(15, p) : 0;
  if (!pct) return { width: w, height: h };
  const keep = 1 - (pct * 2) / 100;
  // Floor, then guard: a rounding that produced 0 would ask resvg for a zero-width render.
  return { width: Math.max(16, Math.floor(w * keep)), height: Math.max(16, Math.floor(h * keep)) };
}
