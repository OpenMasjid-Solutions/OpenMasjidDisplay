// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * pi/fbset.ts — asking the kernel what the screen really is, instead of inferring it.
 *
 * The files under `/sys/class/graphics/fb0` are not a description of the display. `virtual_size`
 * is the buffer the driver allocated, which may be larger than what is scanned out; `mode` is
 * frequently empty on the Pi's DRM-backed fbdev emulation; and neither distinguishes the visible
 * resolution from the virtual one. Guessing from them produced a picture composed at twice the
 * width of the television and clipped through the middle of every centred line.
 *
 * `fbset -i` performs the `FBIOGET_VSCREENINFO` and `FBIOGET_FSCREENINFO` ioctls and prints all
 * four numbers that matter, unambiguously:
 *
 *     mode "1920x1080"
 *         geometry 1920 1080 1920 1080 16
 *         ...
 *     endmode
 *         LineLength  : 3840
 *
 * `geometry` is `xres yres xres_virtual yres_virtual depth` — the visible size FIRST, then the
 * virtual one — and `LineLength` is the true stride in bytes. That is every value this agent
 * needs, from the same ioctl the kernel answers a real graphics program with.
 *
 * Parsing is pure and separate from running the command, because the parsing is the part that can
 * be wrong on hardware nobody testing owns.
 */
import { execFileSync } from 'node:child_process';
import type { FbGeometry } from './framebuffer';

/**
 * Pull the geometry out of `fbset -i` output.
 *
 * Returns null rather than guessing: an unparseable answer must fall back to the sysfs reading,
 * not produce a confidently wrong screen.
 */
export function parseFbset(out: string): FbGeometry | null {
  // geometry <xres> <yres> <xres_virtual> <yres_virtual> <depth>
  const g = /^\s*geometry\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(out);
  if (!g) return null;

  const width = Number(g[1]);
  const height = Number(g[2]);
  const virtualWidth = Number(g[3]);
  const bpp = Number(g[5]);

  if (!width || !height || width > 8192 || height > 8192) return null;
  if (bpp !== 16 && bpp !== 32) return null;

  // The real distance between rows. Falling back to the VIRTUAL width — never the visible one,
  // which would shear the picture into a diagonal on any screen where the two differ.
  const line = /^\s*LineLength\s*:\s*(\d+)\s*$/m.exec(out);
  const packed = (virtualWidth || width) * (bpp / 8);
  const declared = line ? Number(line[1]) : 0;
  const stride = declared >= packed ? declared : packed;

  return { width, height, bpp, stride };
}

/** Ask the running kernel. Null when fbset is not installed or has nothing to say. */
export function readFbset(): FbGeometry | null {
  for (const args of [['-i'], ['-s']]) {
    try {
      const out = execFileSync('fbset', args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      const geo = parseFbset(out);
      if (geo) return geo;
    } catch {
      /* not installed, or no framebuffer — the caller falls back to sysfs */
    }
  }
  return null;
}

/** The raw text, for the log. A screen that is the right shape in the wrong place is decided
 *  entirely by these numbers, and none of them exist on a development machine. */
export function describeFbset(): string {
  try {
    const out = execFileSync('fbset', ['-i'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const g = /^\s*geometry\s+.*$/m.exec(out)?.[0]?.trim() ?? 'geometry ?';
    const l = /^\s*LineLength\s*:.*$/m.exec(out)?.[0]?.trim() ?? 'LineLength ?';
    return `${g} | ${l}`;
  } catch {
    return 'fbset unavailable';
  }
}
