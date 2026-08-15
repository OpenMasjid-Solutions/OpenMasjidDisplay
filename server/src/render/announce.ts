// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * render/announce.ts — the downloadable "Iqāmah times are changing" poster.
 *
 * A masjid announces a change twice: on the screens (the red band, see svg.ts) and in the
 * WhatsApp group / on the noticeboard. The screens were handled; this is the second one — a
 * portrait image the admin downloads from the Salah-times tab and sends as-is.
 *
 * It deliberately does NOT reuse the display's layout. The display is a landscape 16:9 wall
 * panel read from across a hall; this is a 4:5 card read on a phone, and the thing it has to
 * make obvious is *what changed*, which the display never has to say. What it does share is
 * the masjid's identity: the timetable's theme palette, its logo, its masjid name, its
 * language and 12/24-hour setting — so the poster looks like the screens rather than like a
 * generic template.
 *
 * The times themselves come from `buildModel` — the same function the screens render from —
 * evaluated on the change date and on the day before it. That is what guarantees the poster
 * and the wall cannot disagree: there is no second implementation of "what will Asr be".
 */
import { buildModel, fmtShort, labels, rowName, PRAYER_LABELS, WEEKDAYS, MONTH_NAMES, type NextIqamahChange } from './svg';
import { getPalette, type Palette } from './theme';
import { zonedNoon } from '../prayer/engine';
import type { Timetable } from '../types';

/** 4:5 — the shape that survives a phone feed without being cropped. */
export const POSTER_W = 1080;
export const POSTER_H = 1350;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function hexToRgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const FONT_SANS = 'Noto Sans, Noto Sans Arabic, DejaVu Sans, sans-serif';
const FONT_ARABIC = 'Amiri, Noto Naskh Arabic, Noto Sans Arabic, Noto Sans, DejaVu Sans, sans-serif';

interface TextOpts {
  size: number;
  fill: string;
  weight?: number;
  anchor?: 'start' | 'middle' | 'end';
  family?: string;
  letter?: number;
  opacity?: number;
}

function text(x: number, baseline: number, content: string, o: TextOpts): string {
  const a = o.anchor ?? 'start';
  return (
    `<text x="${x.toFixed(1)}" y="${baseline.toFixed(1)}" font-family="${o.family ?? FONT_SANS}" ` +
    `font-size="${o.size.toFixed(1)}" font-weight="${o.weight ?? 400}" fill="${o.fill}" ` +
    `text-anchor="${a}"${o.letter ? ` letter-spacing="${o.letter}"` : ''}` +
    `${o.opacity != null ? ` opacity="${o.opacity}"` : ''}>${esc(content)}</text>`
  );
}

function rect(x: number, y: number, w: number, h: number, r: number, fill: string, extra = ''): string {
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="${r.toFixed(1)}" fill="${fill}"${extra ? ` ${extra}` : ''}/>`;
}

/** One prayer line on the poster. */
interface PosterRow {
  name: string;
  arabic: string;
  adhan: string;
  iqamah: string;
  /** the Iqāmah as it is TODAY, when this row is one of the ones changing */
  was: string | null;
  changed: boolean;
  /** Sunrise: no Iqāmah, drawn dimmer — it is context, not a jamā'ah */
  minor: boolean;
}

export interface PosterModel {
  masjidName: string;
  location: string;
  /** "Friday, 20 March 2026" */
  dateLine: string;
  /** how many days from today, for the small "in N days" note */
  daysUntil: number;
  rows: PosterRow[];
  jumuah: string[];
  rtl: boolean;
  changedCount: number;
}

/**
 * Turn a detected change into everything the poster needs to say.
 *
 * `before` is read from the calendar day BEFORE the change rather than from "today", because
 * a masjid may schedule two changes close together — quoting today's time as the "was" would
 * then be wrong for anyone reading the poster after the first one lands.
 */
export function posterModel(tt: Timetable, change: NextIqamahChange): PosterModel {
  const tz = tt.timezone || undefined;
  const L = labels(tt.language, tt.labels);
  const on = zonedNoon(change.year, change.month, change.day, tz);
  const before = zonedNoon(change.year, change.month, change.day - 1, tz);
  const mOn = buildModel(tt, on);
  const mBefore = buildModel(tt, before);

  const prevIqamah = new Map<string, number | null>();
  for (const r of mBefore.rows) prevIqamah.set(r.key, r.iqamah);
  const changedKeys = new Set(change.changed.map((c) => c.key as string));

  const rows: PosterRow[] = mOn.rows.map((r) => {
    const wasH = prevIqamah.get(r.key) ?? null;
    // A row is marked only if the detector called it a change AND the time really moved —
    // the detector's own rules (vs the rule for the day, vs the day before) are what decide,
    // and this second test just keeps a 0-minute difference from drawing a "was" line.
    const moved = changedKeys.has(r.key) && wasH != null && r.iqamah != null && Math.round(wasH * 60) !== Math.round(r.iqamah * 60);
    return {
      name: rowName(r, L),
      arabic: tt.language === 'ar' ? '' : PRAYER_LABELS.ar[r.label] ?? '',
      adhan: r.adhan != null ? fmtShort(r.adhan, tt.timeFormat) : '',
      iqamah: r.iqamah != null ? fmtShort(r.iqamah, tt.timeFormat) : '',
      was: moved ? fmtShort(wasH, tt.timeFormat) : null,
      changed: moved,
      minor: r.key === 'sunrise',
    };
  });

  const dow = new Date(Date.UTC(change.year, change.month - 1, change.day, 12)).getUTCDay();
  return {
    masjidName: tt.masjidName || 'Our Masjid',
    location: tt.location || '',
    dateLine: `${WEEKDAYS[dow]}, ${change.day} ${MONTH_NAMES[change.month - 1]} ${change.year}`,
    daysUntil: change.daysUntil,
    rows,
    jumuah: mOn.jumuah.map((j) => fmtShort(j, tt.timeFormat)),
    rtl: tt.language === 'ar' || tt.language === 'ur',
    changedCount: rows.filter((r) => r.changed).length,
  };
}

/** The poster as an SVG string. `logo` is a data: URI (resvg only embeds those), or null. */
export function renderAnnounceSvg(tt: Timetable, m: PosterModel, logo: string | null): string {
  const p: Palette = getPalette(tt.themeId, tt.accent, tt.goldColor);
  const W = POSTER_W;
  const H = POSTER_H;
  const pad = 72;
  const out: string[] = [];

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<defs>`,
    `<radialGradient id="scene" cx="50%" cy="18%" r="95%">` +
      `<stop offset="0%" stop-color="${p.bg2}"/><stop offset="100%" stop-color="${p.bg}"/></radialGradient>`,
    // The same faint geometric motif the screens carry, so the poster reads as the
    // masjid's own rather than as a stock template.
    `<pattern id="khatam" width="120" height="120" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
      `<path d="M60 0 L120 60 L60 120 L0 60 Z" fill="none" stroke="${hexToRgba(p.pattern, 0.10)}" stroke-width="2"/>` +
      `</pattern>`,
    `</defs>`,
    rect(0, 0, W, H, 0, 'url(#scene)'),
    rect(0, 0, W, H, 0, 'url(#khatam)'),
  );

  // ── Header: logo, masjid name, location ───────────────────────────────────
  let y = pad + 18;
  const hasLogo = !!logo;
  if (hasLogo) {
    const s = 104;
    out.push(`<image href="${logo}" x="${(W - s) / 2}" y="${y}" width="${s}" height="${s}" preserveAspectRatio="xMidYMid meet"/>`);
    y += s + 34;
  }
  // Autofit the masjid name: a long name must shrink rather than run off the card.
  const nameSize = clamp((W - 2 * pad) / Math.max(9, m.masjidName.length * 0.56), 30, 62);
  out.push(text(W / 2, y + nameSize * 0.36, m.masjidName, { size: nameSize, fill: p.text, weight: 800, anchor: 'middle' }));
  y += nameSize * 0.9;
  if (m.location) {
    out.push(text(W / 2, y + 22, m.location.toUpperCase(), { size: 20, fill: p.textDim, weight: 600, anchor: 'middle', letter: 3 }));
    y += 34;
  }

  // ── The announcement itself ───────────────────────────────────────────────
  //
  // Everything from here to the Jumu'ah strip is built in LOCAL coordinates starting at 0
  // and translated as one group at the end. The block's height varies — Sunrise can be off,
  // Jumu'ah can be absent, one to four prayers can change — and a fixed top offset left a
  // deep band of empty poster under it in the common cases. Measuring, then centring in the
  // space between the header and the footer, makes every combination look composed.
  const headBottom = y;
  const block: string[] = [];
  y = 0;

  y += 26;
  block.push(text(W / 2, y, m.changedCount === 1 ? 'IQĀMAH TIME IS CHANGING' : 'IQĀMAH TIMES ARE CHANGING', { size: 26, fill: p.gold, weight: 800, anchor: 'middle', letter: 5 }));
  y += 30;
  block.push(rect(W / 2 - 46, y, 92, 3, 1.5, hexToRgba(p.gold, 0.55)));
  y += 58;
  block.push(text(W / 2, y, `From ${m.dateLine}`, { size: 40, fill: p.text, weight: 700, anchor: 'middle' }));
  y += 34;
  const inDays = m.daysUntil === 1 ? 'tomorrow' : `in ${m.daysUntil} days`;
  block.push(text(W / 2, y, `(${inDays})`, { size: 22, fill: p.textDim, weight: 500, anchor: 'middle' }));

  // ── The timetable ─────────────────────────────────────────────────────────
  y += 50;
  const cardX = pad;
  const cardW = W - 2 * pad;
  const headH = 52;
  const rowH = 74;
  const cardH = headH + m.rows.length * rowH + 18;
  block.push(rect(cardX, y, cardW, cardH, 28, p.light ? hexToRgba('#ffffff', 0.72) : hexToRgba('#ffffff', 0.06)));
  block.push(rect(cardX, y, cardW, cardH, 28, 'none', `stroke="${hexToRgba(p.text, 0.12)}" stroke-width="1.5"`));

  const inX = cardX + 34;
  const colIq = cardX + cardW - 34;
  const colAd = cardX + cardW * 0.685;
  let ry = y + 36;
  block.push(text(inX, ry, (labelOr(tt, 'prayer', 'Prayer')).toUpperCase(), { size: 18, fill: p.textFaint, weight: 700, letter: 2 }));
  block.push(text(colAd, ry, (labelOr(tt, 'athan', 'Adhan')).toUpperCase(), { size: 18, fill: p.textFaint, weight: 700, anchor: 'end', letter: 2 }));
  block.push(text(colIq, ry, (labelOr(tt, 'iqamah', 'Iqamah')).toUpperCase(), { size: 18, fill: p.textFaint, weight: 700, anchor: 'end', letter: 2 }));
  ry = y + headH;
  block.push(rect(inX, ry, cardW - 68, 1.5, 0, hexToRgba(p.text, 0.12)));

  for (const r of m.rows) {
    const mid = ry + rowH * 0.52;
    if (r.changed) {
      // The one thing this poster exists to communicate. A tinted band plus an accent
      // edge, so it survives being screenshotted, forwarded and viewed at thumbnail size.
      block.push(rect(cardX + 12, ry + 6, cardW - 24, rowH - 12, 16, hexToRgba(p.primary, 0.16)));
      block.push(rect(cardX + 12, ry + 6, 6, rowH - 12, 3, p.primary));
    }
    const nameColor = r.changed ? p.primarySoft : r.minor ? p.textDim : p.text;
    const nameSz = 30;
    block.push(text(inX, mid + 10, r.name, { size: nameSz, fill: nameColor, weight: r.changed ? 800 : 700 }));
    if (r.arabic) {
      block.push(text(inX + r.name.length * nameSz * 0.58 + 16, mid + 10, r.arabic, { size: nameSz * 0.84, fill: hexToRgba(p.gold, 0.85), weight: 600, family: FONT_ARABIC }));
    }
    if (r.minor) {
      // Sunrise has one time and no jamā'ah; centre it between the two columns.
      block.push(text((colAd + colIq) / 2, mid + 10, r.adhan, { size: 28, fill: p.textDim, weight: 600, anchor: 'middle' }));
    } else {
      block.push(text(colAd, mid + 10, r.adhan, { size: 28, fill: p.textDim, weight: 600, anchor: 'end' }));
      if (r.was) {
        // old → new, stacked, so the reader sees the delta without holding two posters side
        // by side. The old time is struck through with a drawn line rather than
        // `text-decoration`, which resvg does not render.
        const wasSz = 23;
        block.push(text(colIq, mid - 4, r.was, { size: wasSz, fill: p.textFaint, weight: 600, anchor: 'end' }));
        const wasW = approxW(r.was, wasSz);
        block.push(
          `<line x1="${(colIq - wasW).toFixed(1)}" y1="${(mid - 11).toFixed(1)}" x2="${colIq.toFixed(1)}" y2="${(mid - 11).toFixed(1)}" ` +
            `stroke="${p.textFaint}" stroke-width="1.8" opacity="0.85"/>`,
        );
        block.push(text(colIq, mid + 30, r.iqamah, { size: 34, fill: p.primarySoft, weight: 800, anchor: 'end' }));
      } else {
        block.push(text(colIq, mid + 10, r.iqamah || '—', { size: 32, fill: r.iqamah ? (r.changed ? p.primarySoft : p.text) : p.textFaint, weight: r.changed ? 800 : 700, anchor: 'end' }));
      }
    }
    ry += rowH;
  }
  y += cardH;

  // ── Jumu'ah strip ─────────────────────────────────────────────────────────
  if (m.jumuah.length) {
    y += 22;
    const jH = 78;
    block.push(rect(cardX, y, cardW, jH, 22, hexToRgba(p.gold, 0.14)));
    block.push(text(inX, y + jH * 0.62, labelOr(tt, 'jumuah', "Jumu'ah"), { size: 28, fill: p.gold, weight: 800 }));
    block.push(text(colIq, y + jH * 0.62, m.jumuah.join('   ·   '), { size: 30, fill: p.gold, weight: 800, anchor: 'end' }));
    y += jH;
  }

  // ── Compose: centre the measured block between header and footer ──────────
  const footerY = H - pad + 6;
  const avail = footerY - 46 - headBottom;
  const dy = headBottom + Math.max(0, (avail - y) / 2);
  out.push(`<g transform="translate(0,${dy.toFixed(1)})">${block.join('')}</g>`);

  out.push(
    text(W / 2, footerY, 'Please pass this on to the congregation', {
      size: 21,
      fill: p.textFaint,
      weight: 500,
      anchor: 'middle',
    }),
  );

  out.push('</svg>');
  return out.join('');
}

/** Rough advance width, only used to underline the struck-through "was" time. */
function approxW(s: string, size: number): number {
  return s.length * size * 0.55;
}

function labelOr(tt: Timetable, key: string, fallback: string): string {
  return labels(tt.language, tt.labels)[key] ?? fallback;
}
