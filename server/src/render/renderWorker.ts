// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * render/renderWorker.ts — runs the (CPU-heavy, synchronous) resvg rasterization
 * on a worker thread so it NEVER blocks the main event loop.
 *
 * Before this, `new Resvg(svg).render()` ran once per second on the main thread,
 * re-parsing the bundled fonts and rasterizing a full-screen, gradient-rich SVG.
 * On a small box that pegged a core and starved both the HTTP/WebSocket server and
 * ffmpeg's stdin — the timetable stream would take minutes to come online (or never
 * publish) and the control panel felt sluggish. Doing it here keeps the main thread
 * free; if a render is slow we simply produce frames a little less often.
 *
 * Messages in:  { id, kind: 'raw' | 'png', tt, nowMs, width?, bgFile? }
 * Messages out: { id, ok: true, ... } | { id, ok: false, error }
 *   • raw → { width, height, buf }  (RGBA pixels, ArrayBuffer transferred) for ffmpeg
 *   • png → { buf }                 (PNG bytes, ArrayBuffer transferred) for previews
 */
import { parentPort } from 'node:worker_threads';
import { Resvg } from '@resvg/resvg-js';
import { renderDisplaySvg, activeAnnouncementImage } from './svg';
import { backgroundDataUri, logoDataUri, announcementDataUri } from './background';
import { fontOptions } from './fonts';
import { getPalette } from './theme';
import type { Timetable } from '../types';

if (!parentPort) throw new Error('renderWorker must be run as a worker thread');
const port = parentPort;

interface Req {
  id: number;
  kind: 'raw' | 'png' | 'meta';
  tt: Timetable;
  nowMs: number;
  width?: number;
  /** rasterise the (raw) video frame at this width instead of the SVG's native size */
  renderWidth?: number;
  bgFile?: string;
  logoFile?: string;
}

/** Resolve the background + logo data URIs for a timetable (cached by mtime). An
 *  override (from the raw form body) is used when given, else the stored field. */
function assets(tt: Timetable, bgOverride?: string, logoOverride?: string): { bg: string | null; logo: string | null } {
  const bgFile = bgOverride !== undefined ? bgOverride : tt.backgroundImage;
  const logoFile = logoOverride !== undefined ? logoOverride : tt.logoImage;
  return {
    bg: bgFile ? backgroundDataUri(bgFile) : null,
    logo: logoFile ? logoDataUri(logoFile) : null,
  };
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx ? d / mx : 0, mx];
}
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) => Math.round((v + m) * 255);
  return `#${((to(r) << 16) | (to(g) << 8) | to(b)).toString(16).padStart(6, '0')}`;
}

// Cache one decode of each background photo (keyed by a cheap fingerprint of the
// data URI, which changes when the photo does) — decoding a multi-MB photo every
// frame would defeat the worker. We extract BOTH the average luminance (→ auto text
// contrast) and a representative vivid accent hue (→ auto accent colour).
interface Sample { lum: number; accent: string | null }
const sampleCache = new Map<string, Sample>();
function sampleImage(uri: string): Sample {
  const key = `${uri.length}:${uri.slice(0, 48)}`;
  const hit = sampleCache.get(key);
  if (hit) return hit;
  let res: Sample = { lum: 0.5, accent: null };
  try {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><image href="${uri}" x="0" y="0" width="24" height="24" preserveAspectRatio="none"/></svg>`;
    const px = new Resvg(svg, { font: { loadSystemFonts: false } }).render().pixels;
    let sum = 0, wt = 0, sumSin = 0, sumCos = 0, hueW = 0, satSum = 0;
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3] / 255;
      sum += ((0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255) * a;
      wt += a;
      const [h, s, v] = rgbToHsv(px[i], px[i + 1], px[i + 2]);
      const w = s * v * a; // favour vivid, opaque pixels for the hue
      sumSin += Math.sin((h * Math.PI) / 180) * w;
      sumCos += Math.cos((h * Math.PI) / 180) * w;
      hueW += w; satSum += s * a;
    }
    const lum = wt > 0 ? sum / wt : 0.5;
    const avgSat = wt > 0 ? satSum / wt : 0;
    // Only derive an accent if the image actually has colour (skip near-greyscale).
    let accent: string | null = null;
    if (hueW > 0 && avgSat > 0.12) {
      let hue = (Math.atan2(sumSin, sumCos) * 180) / Math.PI;
      if (hue < 0) hue += 360;
      accent = hslToHex(hue, 0.62, 0.54);
    }
    res = { lum, accent };
  } catch {
    /* keep defaults */
  }
  if (sampleCache.size > 64) sampleCache.clear();
  sampleCache.set(key, res);
  return res;
}

/** Auto-contrast: true when the (scrimmed) custom background photo is light enough
 *  that the theme's light text would wash out, so the render should use dark text.
 *  Only meaningful when the timetable's textColor is "auto". */
function bgIsLight(tt: Timetable, bg: string | null): boolean {
  if (!bg || tt.textColor) return false; // manual colour set, or no photo
  const themeBgLum = (() => {
    const m = /^#?([0-9a-f]{6})$/i.exec(getPalette(tt.themeId, tt.accent).bg.trim());
    if (!m) return 0.1;
    const n = parseInt(m[1], 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  })();
  // The render lays a ~0.45-alpha theme-coloured scrim over the photo, so judge the
  // blended result rather than the raw photo.
  const blended = sampleImage(bg).lum * 0.55 + themeBgLum * 0.45;
  return blended > 0.58;
}

/** Auto accent: a vivid colour pulled from the wallpaper, used only when the user
 *  hasn't picked a manual accent (so the UI harmonises with the photo). */
function bgAccent(tt: Timetable, bg: string | null): string | undefined {
  if (!bg || tt.accent) return undefined; // manual accent wins; no photo → theme colour
  return sampleImage(bg).accent ?? undefined;
}

port.on('message', (msg: Req) => {
  const { id, kind, tt, nowMs } = msg;
  try {
    const now = new Date(typeof nowMs === 'number' ? nowMs : Date.now());
    if (kind === 'meta') {
      // Just collect the click-to-edit regions; no rasterization (cheap).
      const sink = { hotspots: [] as unknown[] };
      renderDisplaySvg(tt, now, { sink: sink as never });
      port.postMessage({ id, ok: true, hotspots: sink.hotspots });
      return;
    }
    if (kind === 'png') {
      const { bg, logo } = assets(tt, msg.bgFile, msg.logoFile);
      const svg = renderDisplaySvg(tt, now, { bg, logo, bgLight: bgIsLight(tt, bg), autoAccent: bgAccent(tt, bg) });
      const png = new Resvg(svg, {
        font: fontOptions(),
        fitTo: { mode: 'width', value: msg.width ?? 960 },
      })
        .render()
        .asPng();
      // Copy into a standalone ArrayBuffer so it can be transferred (a Buffer shares
      // a pooled backing store that must not be detached).
      const ab = new ArrayBuffer(png.byteLength);
      new Uint8Array(ab).set(png);
      port.postMessage({ id, ok: true, buf: ab }, [ab]);
      return;
    }
    // raw RGBA for the video pipeline. During an announcement slideshow phase the
    // timetable becomes a left sidebar and the (sharp) image fills the right.
    const { bg, logo } = assets(tt);
    const annFile = activeAnnouncementImage(tt, now);
    const announcement = annFile ? announcementDataUri(annFile) : null;
    // tickerBandOnly: paint just the strip — ffmpeg overlays the moving text smoothly.
    const svg = renderDisplaySvg(tt, now, { bg, logo, announcement, tickerBandOnly: true, bgLight: bgIsLight(tt, bg), autoAccent: bgAccent(tt, bg) });
    // renderWidth caps the raster (ffmpeg upscales to the output) so each per-second
    // render stays cheap and the live countdown never skips.
    const r = new Resvg(svg, {
      font: fontOptions(),
      ...(msg.renderWidth ? { fitTo: { mode: 'width' as const, value: msg.renderWidth } } : {}),
    }).render();
    const px = r.pixels;
    const ab = new ArrayBuffer(px.byteLength);
    new Uint8Array(ab).set(px);
    port.postMessage({ id, ok: true, width: r.width, height: r.height, buf: ab }, [ab]);
  } catch (e) {
    port.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
