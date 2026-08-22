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
