// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Renders one incorrect-parking report to a full-screen (1920×1080) red-bordered
 * alert card as an SVG string. reportFrames.ts rasterizes it (resvg) into an
 * announcement frame that rotates on the timetable(s) the report targets. The car's
 * photo is embedded as a data URI (rendered locally, so there's no size limit).
 */
import type { ParkingReport } from '../types';

function esc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function clip(s: unknown, max: number): string {
  const str = String(s == null ? '' : s);
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

export function renderReportCardSvg(r: ParkingReport, imageDataUri: string | null): string {
  const W = 1920, H = 1080, RED = '#F87171';
  const cx = 140, cy = 130, cw = W - 280, ch = 820;
  const hasImg = !!imageDataUri;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  out.push(`<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#0c3a4d"/><stop offset="0.5" stop-color="#082230"/><stop offset="1" stop-color="#020a12"/>
    </linearGradient><clipPath id="imgclip"><rect x="${cx + cw - 660}" y="${cy + 150}" width="620" height="620" rx="18"/></clipPath></defs>`);
  out.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`);

  // Card + red banner
  out.push(`<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="28" fill="#0F2040" fill-opacity="0.9" stroke="${RED}" stroke-width="6"/>`);
  out.push(`<rect x="${cx}" y="${cy}" width="${cw}" height="96" rx="28" fill="${RED}"/>`);
  out.push(`<rect x="${cx}" y="${cy + 50}" width="${cw}" height="46" fill="${RED}"/>`);
  out.push(`<text x="${cx + 40}" y="${cy + 64}" font-size="52" font-weight="700" fill="#ffffff" font-family="sans-serif">⚠ Incorrect Parking</text>`);

  // Photo on the right (when present)
  if (hasImg) {
    out.push(`<rect x="${cx + cw - 660}" y="${cy + 150}" width="620" height="620" rx="18" fill="#03101c" stroke="rgba(125,200,232,0.2)"/>`);
    out.push(`<image href="${imageDataUri}" x="${cx + cw - 660}" y="${cy + 150}" width="620" height="620" preserveAspectRatio="xMidYMid slice" clip-path="url(#imgclip)"/>`);
  }
  const textMax = hasImg ? 28 : 40;
  const valX = cx + 260;

  // Plate (big)
  let y = cy + 250;
  if (r.plate) {
    const pw = Math.min((hasImg ? cw - 700 : cw) - 80, 120 + r.plate.length * 58);
    out.push(`<rect x="${cx + 40}" y="${y - 88}" width="${pw}" height="118" rx="16" fill="#03101c" stroke="rgba(125,200,232,0.2)"/>`);
    out.push(`<text x="${cx + 68}" y="${y}" font-size="86" font-weight="700" fill="#F4F7FB" font-family="sans-serif" letter-spacing="8">${esc(clip(r.plate, 12))}</text>`);
    y += 96;
  } else {
    y -= 30;
  }

  const row = (label: string, value: string, valFill?: string, weight?: number): void => {
    if (!value) return;
    out.push(`<text x="${cx + 44}" y="${y}" font-size="34" fill="#9FACC2" font-family="sans-serif">${label}</text>`);
    out.push(`<text x="${valX}" y="${y}" font-size="44" font-weight="${weight ?? 500}" fill="${valFill ?? '#F4F7FB'}" font-family="sans-serif">${esc(clip(value, textMax))}</text>`);
    y += 72;
  };
  row('Vehicle', r.description);
  row('Location', r.location);
  row('Reason', r.reason, RED, 700);

  out.push('</svg>');
  return out.join('');
}
