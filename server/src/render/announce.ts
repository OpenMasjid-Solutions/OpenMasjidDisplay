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

/** One prayer line on the poster. Iqāmah only — this is an Iqāmah-change notice, and the
 *  Adhan column was answering a question nobody reading it had asked. Sunrise is gone for
 *  the same reason: it has no jamā'ah, so it cannot change. */
interface PosterRow {
  name: string;
  arabic: string;
  iqamah: string;
  /** the Iqāmah being replaced, when this row is one of the ones changing */
  was: string | null;
  changed: boolean;
}

export interface PosterModel {
  masjidName: string;
  location: string;
  /** "Friday, 20 March 2026" */
  dateLine: string;
  /** how many days from today; ≤ 0 when this change has already taken effect */
  daysUntil: number;
  /** true when the poster is describing a change that has already happened */
  past: boolean;
  /** the parenthetical under the date — "tomorrow", "in 12 days", "in effect since last week" */
  whenNote: string;
  rows: PosterRow[];
  jumuah: string[];
  rtl: boolean;
  changedCount: number;
}

/** The small note under the date. Reads naturally on both sides of today, because the poster
 *  is now offered for the most recent past change when nothing is scheduled ahead. */
function whenNoteFor(daysUntil: number): string {
  if (daysUntil === 1) return 'tomorrow';
  if (daysUntil > 1) return `in ${daysUntil} days`;
  if (daysUntil === 0) return 'from today';
  if (daysUntil === -1) return 'in effect since yesterday';
  return `in effect for ${Math.abs(daysUntil)} days`;
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

  const rows: PosterRow[] = mOn.rows
    // Sunrise is not a jamā'ah — there is no Iqāmah to change, so it is noise on a notice
    // that exists to say which Iqāmah moved.
    .filter((r) => r.key !== 'sunrise')
    .map((r) => {
      const wasH = prevIqamah.get(r.key) ?? null;
      // A row is marked only if the detector called it a change AND the time really moved —
      // the detector's own rules (vs the rule for the day, vs the day before) are what decide,
      // and this second test just keeps a 0-minute difference from drawing a "was" line.
      const moved = changedKeys.has(r.key) && wasH != null && r.iqamah != null && Math.round(wasH * 60) !== Math.round(r.iqamah * 60);
      return {
        name: rowName(r, L),
        arabic: tt.language === 'ar' ? '' : PRAYER_LABELS.ar[r.label] ?? '',
        iqamah: r.iqamah != null ? fmtShort(r.iqamah, tt.timeFormat) : '',
        was: moved ? fmtShort(wasH, tt.timeFormat) : null,
        changed: moved,
      };
    });

  const dow = new Date(Date.UTC(change.year, change.month - 1, change.day, 12)).getUTCDay();
  return {
    masjidName: tt.masjidName || 'Our Masjid',
    location: tt.location || '',
    dateLine: `${WEEKDAYS[dow]}, ${change.day} ${MONTH_NAMES[change.month - 1]} ${change.year}`,
    daysUntil: change.daysUntil,
    past: change.daysUntil <= 0,
    whenNote: whenNoteFor(change.daysUntil),
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
    // Gradient only. The screens carry a faint geometric motif over this, but at poster
    // scale — viewed on a phone, often re-compressed by a messaging app — it read as a grid
    // ruled over the notice rather than as texture, and competed with the one thing the
    // page is for.
    `<radialGradient id="scene" cx="50%" cy="18%" r="95%">` +
      `<stop offset="0%" stop-color="${p.bg2}"/><stop offset="100%" stop-color="${p.bg}"/></radialGradient>`,
    `</defs>`,
    rect(0, 0, W, H, 0, 'url(#scene)'),
  );

  // ── Everything below is ONE measured group, centred in the page ───────────
  //
  // Header included. The header used to be pinned to the top with only the times centred
  // beneath it, which was fine while the content was tall — but with the Adhan column, the
  // Sunrise row and the footer all gone, the remainder floated: a gulf under the masjid name
  // and a matching void at the bottom. Measuring the whole thing and centring it once keeps
  // the top and bottom margins equal whatever the poster contains (logo or not, Jumu'ah or
  // not, one changed prayer or four).
  const block: string[] = [];
  let y = 0;

  if (logo) {
    const s = 104;
    block.push(`<image href="${logo}" x="${(W - s) / 2}" y="${y}" width="${s}" height="${s}" preserveAspectRatio="xMidYMid meet"/>`);
    y += s + 34;
  }
  // Autofit the masjid name: a long name must shrink rather than run off the card.
  const nameSize = clamp((W - 2 * pad) / Math.max(9, m.masjidName.length * 0.56), 30, 62);
  block.push(text(W / 2, y + nameSize * 0.36, m.masjidName, { size: nameSize, fill: p.text, weight: 800, anchor: 'middle' }));
  y += nameSize * 0.9;
  if (m.location) {
    block.push(text(W / 2, y + 22, m.location.toUpperCase(), { size: 20, fill: p.textDim, weight: 600, anchor: 'middle', letter: 3 }));
    y += 34;
  }

  // ── The announcement itself ───────────────────────────────────────────────
  //
  // Everything from here to the Jumu'ah strip is built in LOCAL coordinates starting at 0
  // and translated as one group at the end. The block's height varies — Sunrise can be off,
  // Jumu'ah can be absent, one to four prayers can change — and a fixed top offset left a
  // deep band of empty poster under it in the common cases. Measuring, then centring in the
  // space between the header and the footer, makes every combination look composed.
  y += 52;
  // Past tense when the change has already landed — the poster is then a "these are the
  // times now" notice, and announcing it as upcoming would be plainly wrong. Shared with the
  // WhatsApp text (`announceHeadline`) so a poster and a message about the same change can
  // never disagree about tense.
  block.push(text(W / 2, y, announceHeadline(m), { size: 26, fill: p.gold, weight: 800, anchor: 'middle', letter: 5 }));
  y += 30;
  block.push(rect(W / 2 - 46, y, 92, 3, 1.5, hexToRgba(p.gold, 0.55)));
  y += 58;
  block.push(text(W / 2, y, `${m.past ? 'Since' : 'From'} ${m.dateLine}`, { size: 40, fill: p.text, weight: 700, anchor: 'middle' }));
  y += 34;
  block.push(text(W / 2, y, `(${m.whenNote})`, { size: 22, fill: p.textDim, weight: 500, anchor: 'middle' }));

  // ── The times ─────────────────────────────────────────────────────────────
  //
  // One time column, not two. The Adhan is not changing and nobody reading an Iqāmah-change
  // notice is looking for it; dropping it also fixed the highlight, which used to be sized
  // for one line while a changed row stacked "was" over "now" and overflowed the band.
  // A changed row now puts the old time in its own column, so every row is a single line of
  // the same height and the band always contains it.
  y += 50;
  const cardX = pad;
  const cardW = W - 2 * pad;
  const headH = 52;
  const rowH = 82;
  const cardH = headH + m.rows.length * rowH + 18;
  block.push(rect(cardX, y, cardW, cardH, 28, p.light ? hexToRgba('#ffffff', 0.72) : hexToRgba('#ffffff', 0.06)));
  block.push(rect(cardX, y, cardW, cardH, 28, 'none', `stroke="${hexToRgba(p.text, 0.12)}" stroke-width="1.5"`));

  const inX = cardX + 34;
  const colIq = cardX + cardW - 34;
  const colWas = cardX + cardW * 0.68; // fixed column, so nothing depends on estimated widths
  const anyChanged = m.rows.some((r) => r.changed);
  let ry = y + 36;
  block.push(text(inX, ry, labelOr(tt, 'prayer', 'Prayer').toUpperCase(), { size: 18, fill: p.textFaint, weight: 700, letter: 2 }));
  if (anyChanged) block.push(text(colWas, ry, 'WAS', { size: 18, fill: p.textFaint, weight: 700, anchor: 'end', letter: 2 }));
  block.push(text(colIq, ry, labelOr(tt, 'iqamah', 'Iqamah').toUpperCase(), { size: 18, fill: p.textFaint, weight: 700, anchor: 'end', letter: 2 }));
  ry = y + headH;
  block.push(rect(inX, ry, cardW - 68, 1.5, 0, hexToRgba(p.text, 0.12)));

  for (const r of m.rows) {
    // One baseline for the whole row. `mid` is the row's vertical centre and every glyph
    // sits on it, which is what keeps the highlight band and its contents in step.
    const mid = ry + rowH / 2;
    if (r.changed) {
      // The one thing this poster exists to communicate. A tinted band plus an accent
      // edge, so it survives being screenshotted, forwarded and viewed at thumbnail size.
      block.push(rect(cardX + 12, ry + 5, cardW - 24, rowH - 10, 18, hexToRgba(p.primary, 0.16)));
      block.push(rect(cardX + 12, ry + 5, 6, rowH - 10, 3, p.primary));
    }
    const nameSz = 32;
    block.push(text(inX, mid + nameSz * 0.35, r.name, { size: nameSz, fill: r.changed ? p.primarySoft : p.text, weight: r.changed ? 800 : 700 }));
    if (r.arabic) {
      block.push(text(inX + r.name.length * nameSz * 0.58 + 16, mid + nameSz * 0.35, r.arabic, { size: nameSz * 0.84, fill: hexToRgba(p.gold, 0.85), weight: 600, family: FONT_ARABIC }));
    }
    if (r.was) {
      // The time being replaced, struck through with a drawn line — resvg does not render
      // `text-decoration`.
      const wasSz = 24;
      block.push(text(colWas, mid + wasSz * 0.35, r.was, { size: wasSz, fill: p.textFaint, weight: 600, anchor: 'end' }));
      block.push(
        `<line x1="${(colWas - approxW(r.was, wasSz)).toFixed(1)}" y1="${(mid).toFixed(1)}" x2="${colWas.toFixed(1)}" y2="${(mid).toFixed(1)}" ` +
          `stroke="${p.textFaint}" stroke-width="1.8" opacity="0.85"/>`,
      );
    }
    const iqSz = r.changed ? 36 : 32;
    block.push(text(colIq, mid + iqSz * 0.35, r.iqamah || '—', {
      size: iqSz,
      fill: r.iqamah ? (r.changed ? p.primarySoft : p.text) : p.textFaint,
      weight: r.changed ? 800 : 700,
      anchor: 'end',
    }));
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

  // ── Compose ───────────────────────────────────────────────────────────────
  const dy = Math.max(pad, (H - y) / 2);
  out.push(`<g transform="translate(0,${dy.toFixed(1)})">${block.join('')}</g>`);

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

/**
 * The eyebrow — the one line that says what this notice IS. Shared by the poster and the
 * WhatsApp text so the two never disagree about tense or number.
 */
export function announceHeadline(m: PosterModel): string {
  return m.past
    ? m.changedCount === 1
      ? 'IQĀMAH TIME HAS CHANGED'
      : 'IQĀMAH TIMES HAVE CHANGED'
    : m.changedCount === 1
      ? 'IQĀMAH TIME IS CHANGING'
      : 'IQĀMAH TIMES ARE CHANGING';
}

/**
 * WhatsApp's four formatting characters. A masjid name containing one would otherwise open
 * a bold/italic run that swallows the rest of the message, so they are stripped from every
 * interpolated value. There is no escape syntax in WhatsApp markup — removing is the only
 * option, and losing a stray asterisk from a masjid name costs nothing.
 */
function waSafe(s: string): string {
  return s.replace(/[*_~`]/g, '').trim();
}

/**
 * The same notice as the poster, as a WhatsApp message.
 *
 * This exists because the platform's Fabric WhatsApp API carries **text only** — there is no
 * media field on `POST /api/fabric/whatsapp`, so the poster PNG cannot be put through the
 * masjid's queue. Rather than not announce at all, we say the same thing in the one format
 * that does go through.
 *
 * It is built from `PosterModel`, the poster's own model, on purpose: the times, the "was"
 * values, which rows count as changed and how the date reads are all decided once. A second
 * implementation of "what will Asr be" is exactly the bug this avoids — a group told one time
 * and a wall showing another.
 *
 * Two deliberate differences from the poster:
 *  - The headline comes FIRST. In a group, line one is the notification preview, and everyone
 *    there already knows which masjid it is.
 *  - The old time is struck through with `~…~` rather than a drawn line, which is the same
 *    idea in the medium's own vocabulary.
 */
export function announceText(tt: Timetable, m: PosterModel): string {
  const lines: string[] = [];
  lines.push(`*${announceHeadline(m)}*`);

  const who = [waSafe(m.masjidName), waSafe(m.location)].filter(Boolean).join(' · ');
  if (who) lines.push(who);

  lines.push('');
  lines.push(`${m.past ? 'Since' : 'From'} ${m.dateLine} (${m.whenNote})`);
  lines.push('');

  for (const r of m.rows) {
    const name = waSafe(r.name);
    const time = r.iqamah || '—';
    // Changed rows are bold and carry the struck-through old time; unchanged rows are plain,
    // so the eye lands on the difference without having to compare two columns.
    lines.push(r.changed && r.was ? `*${name} — ${time}*  (was ~${r.was}~)` : `${name} — ${time}`);
  }

  if (m.jumuah.length) {
    lines.push('');
    lines.push(`${waSafe(labelOr(tt, 'jumuah', "Jumu'ah"))} — ${m.jumuah.join(' · ')}`);
  }

  return lines.join('\n');
}
