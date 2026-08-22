// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Renders one incorrect-parking report to a full-bleed (1920×1080) red alert card as
 * an SVG string. reportFrames.ts rasterizes it (resvg) into an announcement frame
 * that rotates on the timetable(s) the report targets. A report with several photos
 * produces one frame per photo (same details, different photo) so the slideshow
 * scrolls through them. The photo is embedded as a data URI (rendered locally, so
 * there's no size limit). Read from far away, so labels/values are large.
 */
import type { ParkingReport } from '../types';

const RED = '#ff4d4d'; // bright, high-visibility red

function esc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function clip(s: unknown, max: number): string {
  const str = String(s == null ? '' : s);
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/** `imageDataUri` — the photo to show on this frame (a report may render several). */
export function renderReportCardSvg(r: ParkingReport, imageDataUri: string | null): string {
  const W = 1920, H = 1080;
  const B = 22;                    // red frame thickness (full-bleed: card = whole canvas)
  const hasImg = !!imageDataUri;
  const imgW = 660, imgX = W - B - 40 - imgW, imgY = 250, imgH = 640;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  out.push(`<defs><clipPath id="imgclip"><rect x="${imgX}" y="${imgY}" width="${imgW}" height="${imgH}" rx="18"/></clipPath></defs>`);

  // Full-bleed red frame: red fills the canvas, a dark inset panel sits inside it.
  out.push(`<rect width="${W}" height="${H}" fill="${RED}"/>`);
  out.push(`<rect x="${B}" y="${B}" width="${W - 2 * B}" height="${H - 2 * B}" rx="10" fill="#0b1a2b"/>`);

  // Banner
  out.push(`<rect x="${B}" y="${B}" width="${W - 2 * B}" height="128" fill="${RED}"/>`);
  out.push(`<text x="${B + 44}" y="${B + 90}" font-size="72" font-weight="700" fill="#ffffff" font-family="sans-serif">⚠ Incorrect Parking</text>`);

  // Photo on the right (when present)
  if (hasImg) {
    out.push(`<rect x="${imgX}" y="${imgY}" width="${imgW}" height="${imgH}" rx="18" fill="#03101c"/>`);
    out.push(`<image href="${imageDataUri}" x="${imgX}" y="${imgY}" width="${imgW}" height="${imgH}" preserveAspectRatio="xMidYMid slice" clip-path="url(#imgclip)"/>`);
  }
  const textMax = hasImg ? 26 : 42;
  const valX = B + 320;

  // Plate (big)
  let y = 380;
  if (r.plate) {
    const pw = Math.min((hasImg ? imgX : W - B) - (B + 44) - 20, 140 + r.plate.length * 62);
    out.push(`<rect x="${B + 44}" y="${y - 96}" width="${pw}" height="128" rx="16" fill="#03101c"/>`);
    out.push(`<text x="${B + 74}" y="${y}" font-size="96" font-weight="700" fill="#F4F7FB" font-family="sans-serif" letter-spacing="8">${esc(clip(r.plate, 12))}</text>`);
    y += 130;
  } else {
    y -= 20;
  }

  // Rows — large headers + values for distance readability.
  const row = (label: string, value: string, valFill?: string, weight?: number): void => {
    if (!value) return;
    out.push(`<text x="${B + 44}" y="${y}" font-size="46" fill="#9FACC2" font-family="sans-serif">${label}</text>`);
    out.push(`<text x="${valX}" y="${y}" font-size="62" font-weight="${weight ?? 600}" fill="${valFill ?? '#F4F7FB'}" font-family="sans-serif">${esc(clip(value, textMax))}</text>`);
    y += 96;
  };
  row('Vehicle', r.description);
  row('Location', r.location);
  row('Reason', r.reason, RED, 700);

  out.push('</svg>');
  return out.join('');
}
