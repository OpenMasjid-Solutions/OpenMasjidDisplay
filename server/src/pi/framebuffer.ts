// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * pi/framebuffer.ts — drawing to a Raspberry Pi's screen with no desktop installed.
 *
 * Raspberry Pi OS Lite has no X and no Wayland, which is exactly why it fits on a Pi 3 B+ with
 * 1 GB of RAM. What it does have is `/dev/fb0`: a file whose bytes ARE the pixels on the HDMI
 * output. Writing a frame is therefore a `pwrite` at the right offset, and that is the whole
 * mechanism here.
 *
 * The awkward part is that the framebuffer's layout is not ours to choose. Three things vary
 * between Pi models, kernels and monitors, and getting any of them wrong produces a picture
 * that is visibly wrong rather than absent — a blue-tinted display, a diagonal smear, or a
 * third of a screen — so each is read from the kernel rather than assumed:
 *
 *   - **the size**, which follows whatever mode the attached television negotiated;
 *   - **the depth**, 32 bits per pixel on current Pi OS but 16 on some configurations;
 *   - **the stride**, the number of bytes per row, which is NOT always `width × 4`. The kernel
 *     pads rows out to a hardware-friendly boundary, and a frame written as though it were
 *     tightly packed comes out sheared into a diagonal.
 *
 * Everything that decides what a byte means is a pure function of that geometry, so it is
 * tested against each layout rather than against whatever monitor happens to be plugged in.
 */
import fs from 'node:fs';
import { readFbset } from './fbset';

/** Where the kernel publishes the framebuffer's layout. */
const SYS = '/sys/class/graphics/fb0';

export interface FbGeometry {
  width: number;
  height: number;
  /** bits per pixel: 32 (BGRX) or 16 (RGB565) */
  bpp: number;
  /** bytes per row, padding included — not necessarily `width * bpp / 8` */
  stride: number;
}

/**
 * The device we draw to.
 *
 * Overridable, together with the geometry, so the agent can be run on a development machine
 * that has no framebuffer at all: point it at an ordinary file and the frames it would have put
 * on a television can be decoded and looked at. On a Pi both are unset and the kernel is the
 * only source of either.
 */
export const FB_DEVICE = process.env.OMD_SCREEN_FB || '/dev/fb0';

/** Geometry override for that same development path, as `WIDTHxHEIGHTxBPP` (e.g. `1920x1080x32`).
 *  Only consulted when the kernel has nothing to say, because on a Pi the kernel is
 *  authoritative and a stale override would draw a correct picture at the wrong size. */
export function geometryOverride(): FbGeometry | null {
  const m = /^(\d{2,5})x(\d{2,5})x(16|32)$/.exec((process.env.OMD_SCREEN_FB_GEOMETRY || '').trim());
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  const bpp = Number(m[3]);
  return { width, height, bpp, stride: width * (bpp / 8) };
}

function readSys(name: string): string | null {
  try {
    return fs.readFileSync(`${SYS}/${name}`, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Parse the kernel's geometry files.
 *
 * Split out from the reading so the parsing — the part with the arithmetic in it — is testable
 * without a framebuffer. `stride` is honoured when the kernel offers it and computed otherwise,
 * because the file is absent on some kernels and a wrong stride shears the picture.
 */
export function parseGeometry(
  virtualSize: string | null,
  bitsPerPixel: string | null,
  stride: string | null,
  mode: string | null = null,
): FbGeometry | null {
  const m = /^(\d{1,5}),(\d{1,5})$/.exec((virtualSize ?? '').trim());
  if (!m) return null;
  let width = Number(m[1]);
  let height = Number(m[2]);
  if (!width || !height || width > 8192 || height > 8192) return null;

  // `virtual_size` is xres_VIRTUAL — the buffer the kernel allocated, which is allowed to be
  // bigger than the part of it the television actually shows. Drivers make it wider or taller for
  // panning and page-flipping, and on a Pi driving a 4K panel it came back at roughly double the
  // visible width.
  //
  // Drawing into the virtual size looks almost right, which is what makes it nasty: the picture
  // is composed correctly and then only its left portion is on screen, so every centred line is
  // cut off exactly at its middle. `mode` carries the size that is really being scanned out
  // (e.g. "U:1920x1080p-60"), so it wins whenever the kernel offers it.
  const vm = /(\d{2,5})x(\d{2,5})/.exec((mode ?? '').trim());
  if (vm) {
    const mw = Number(vm[1]);
    const mh = Number(vm[2]);
    // Only ever narrows. A mode larger than the buffer would mean writing past the end of it.
    if (mw > 0 && mh > 0 && mw <= width && mh <= height) {
      width = mw;
      height = mh;
    }
  }

  const bpp = Number((bitsPerPixel ?? '').trim());
  // Only the two depths this file knows how to pack. Anything else would be drawn as garbage,
  // and a blank screen with a log line is a far better failure than a scrambled one.
  if (bpp !== 32 && bpp !== 16) return null;

  // NOTE: measured against the VIRTUAL width, not the visible one. The stride is the distance
  // from one row to the next in the buffer, which does not shrink just because less of it is
  // on screen — using the visible width here would shear the picture.
  const packed = Number(m[1]) * (bpp / 8);
  const declared = Number((stride ?? '').trim());
  // A stride below the packed width cannot be real; treat it as missing rather than trusting it.
  const rowBytes = Number.isFinite(declared) && declared >= packed ? declared : packed;

  return { width, height, bpp, stride: rowBytes };
}

/** Read the attached screen's actual layout, or null if there is no framebuffer here. */
/** Everything the kernel says about the framebuffer, verbatim — for the log. A picture that is
 *  the right shape but in the wrong place is decided entirely by these four values, and none of
 *  them can be guessed at from a development machine. */
export function describeFramebuffer(): string {
  return ['virtual_size', 'mode', 'bits_per_pixel', 'stride']
    .map((k) => `${k}=${readSys(k) ?? '?'}`)
    .join(' ');
}

export function readGeometry(): FbGeometry | null {
  // fbset first, because it is the only source that separates the VISIBLE size from the virtual
  // one — it performs the same ioctls a real graphics program would. The sysfs files below
  // cannot make that distinction, which is how a picture ended up composed at twice the width of
  // the television and clipped through the middle of every centred line.
  const viaIoctl = readFbset();
  if (viaIoctl) return viaIoctl;
  // The kernel wins wherever it has an opinion. An override left set on a real Pi would
  // otherwise draw a perfectly correct picture at the wrong size for the attached television.
  return (
    parseGeometry(readSys('virtual_size'), readSys('bits_per_pixel'), readSys('stride'), readSys('mode')) ??
    geometryOverride()
  );
}

/**
 * Convert one RGBA frame into the bytes this framebuffer expects.
 *
 * resvg hands us RGBA in that order. A 32-bit Linux framebuffer on a Pi is XRGB8888
 * little-endian, so the bytes on disk run blue, green, red, unused — red and blue swapped
 * relative to what we were given. Getting this backwards is the single most likely mistake
 * here and it does not look like a bug so much as a colour-blind theme: the gold accent turns
 * blue and everything else looks *nearly* right.
 *
 * `src` is expected to be tightly packed at `width × height × 4`. The output is `stride`-based,
 * so any row padding the kernel wants is preserved.
 */
export function packFrame(src: Uint8Array, geo: FbGeometry): Buffer {
  const { width, height, bpp, stride } = geo;
  const need = width * height * 4;
  if (src.length < need) {
    throw new Error(`frame is ${src.length} bytes, need ${need} for ${width}x${height}`);
  }
  const out = Buffer.alloc(stride * height);

  if (bpp === 32) {
    for (let y = 0; y < height; y++) {
      let s = y * width * 4;
      let d = y * stride;
      for (let x = 0; x < width; x++) {
        out[d] = src[s + 2]; // B
        out[d + 1] = src[s + 1]; // G
        out[d + 2] = src[s]; // R
        out[d + 3] = 0xff; // X — opaque; some overlays read this as alpha
        s += 4;
        d += 4;
      }
    }
    return out;
  }

  // 16bpp: RGB565, little-endian. Truncating the low bits is the standard reduction and is what
  // the hardware does with a deeper source anyway.
  for (let y = 0; y < height; y++) {
    let s = y * width * 4;
    let d = y * stride;
    for (let x = 0; x < width; x++) {
      const v = ((src[s] & 0xf8) << 8) | ((src[s + 1] & 0xfc) << 3) | (src[s + 2] >> 3);
      out[d] = v & 0xff;
      out[d + 1] = v >> 8;
      s += 4;
      d += 2;
    }
  }
  return out;
}

/**
 * An open framebuffer, held for the life of the agent.
 *
 * Reopening per frame would be simpler, but the agent draws once a second forever and the file
 * descriptor is the one piece of state worth keeping. Writes go to offset 0 with `pwrite` so a
 * short write cannot leave the position half-advanced into the next frame.
 */
export class Framebuffer {
  private fd: number;
  readonly geo: FbGeometry;

  private constructor(fd: number, geo: FbGeometry) {
    this.fd = fd;
    this.geo = geo;
  }

  static open(device = FB_DEVICE, geo?: FbGeometry): Framebuffer | null {
    const g = geo ?? readGeometry();
    if (!g) return null;
    try {
      return new Framebuffer(fs.openSync(device, 'w'), g);
    } catch {
      return null;
    }
  }

  /** Draw an RGBA frame. Returns false rather than throwing: a failed frame is a dropped frame,
   *  not a reason to take the screen down. */
  draw(rgba: Uint8Array): boolean {
    try {
      const buf = packFrame(rgba, this.geo);
      let off = 0;
      while (off < buf.length) {
        const n = fs.writeSync(this.fd, buf, off, buf.length - off, off);
        if (n <= 0) return false;
        off += n;
      }
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Get the text console out of the way.
 *
 * Two things fight us for the same pixels. The kernel's framebuffer console keeps a blinking
 * cursor and prints messages over whatever we drew, and console blanking turns the screen off
 * after ten minutes of no keyboard activity — which, on a screen nobody types at, means the
 * display goes black and stays black. Both are best-effort: a Pi where these fail still shows
 * the timetable, it just may also show a cursor.
 */
export function quietConsole(): void {
  // Unbind the framebuffer console so kernel log lines stop landing on our frame.
  for (const vt of ['vtcon0', 'vtcon1']) {
    try {
      fs.writeFileSync(`/sys/class/vtconsole/${vt}/bind`, '0');
    } catch {
      /* not present, or not ours to unbind */
    }
  }
  for (const tty of ['/dev/tty0', '/dev/tty1']) {
    try {
      // Hide the cursor, and set the blanking timer to never. Written as escapes rather than
      // literal control bytes, so this file stays plain text a diff can show.
      fs.writeFileSync(tty, '\u001b[?25l\u001b[9;0]');
    } catch {
      /* no console on this device */
    }
  }
  try {
    fs.writeFileSync(`${SYS}/blank`, '0');
  } catch {
    /* already awake */
  }
}
