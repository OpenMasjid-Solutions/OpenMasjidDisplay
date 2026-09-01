// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Printable monthly prayer-time calendar.
 *
 * Returns a self-contained, print-styled HTML page laid out as a true month
 * calendar grid (weeks as rows, Sun–Sat columns), each day showing every
 * prayer's Adhan / Iqamah time, with Fridays highlighted and the Jumu'ah time
 * called out. The browser's own "Save as PDF" turns it into a PDF, so we add no
 * PDF library — staying lightweight, which is one of this app's standing constraints (it has to
 * run on a Raspberry Pi alongside the render loop).
 */
import { zonedNoon } from './prayer/engine';
import { buildModel } from './render/svg';
import { logoDataUri } from './render/background';
import type { Timetable } from './types';

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * FLOORS the minute, exactly as `fmtClock` in render/svg.ts does.
 *
 * It used to `Math.round`, and that is not a rounding preference — it made the printout
 * disagree with the wall. A time at 13:04:40 renders as 13:04 on the screen and printed as
 * 13:05, so roughly half the rows on a month's sheet were a minute later than the board beside
 * it, with nothing to explain why. `printAgreesWithScreen.test.ts` pins the two together.
 *
 * Still not `fmtShort`: the grid deliberately omits AM/PM to keep 31 cells narrow enough to
 * print, and that is the only difference between them.
 */
function fmt(hours: number | null, timeFormat: string): string {
  if (hours == null || !Number.isFinite(hours)) return '—';
  let total = Math.floor(hours * 60);
  total = ((total % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (timeFormat === '24h') return `${pad2(h)}:${pad2(m)}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad2(m)}`; // AM/PM omitted in the grid to keep cells compact
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

const PRAYERS = [
  { key: 'fajr', label: 'Fajr' },
  { key: 'dhuhr', label: 'Dhuhr' },
  { key: 'asr', label: 'Asr' },
  { key: 'maghrib', label: 'Maghrib' },
  { key: 'isha', label: 'Isha' },
] as const;

interface DayCell {
  day: number;
  rows: { label: string; adhan: string; iqamah: string | null }[];
  jumuah: string | null;
}

/**
 * A readable Jumu'ah summary for ONE day (e.g. "1:30 & 4:00").
 *
 * Per-day rather than per-timetable, because a scheduled change can move the Jumu'ah times
 * part-way through the month — and `buildModel` has already resolved which times apply on the
 * date, so the sheet shows what each Friday will actually be.
 */
function jumuahLabel(hours: number[], timeFormat: string): string | null {
  const times = hours.map((h) => fmt(h, timeFormat));
  return times.length ? times.join(' & ') : null;
}

/** Build a printable month calendar. `month` is 1-12, `year` is the full year. */
export function renderMonthPrintHtml(tt: Timetable, year: number, month: number): string {
  const tz = tt.timezone || undefined;
  const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // Day of week (0=Sun) the 1st falls on, so we can pad the first row.
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  /**
   * Every day through `buildModel`, the same function the screens and the Fabric feed use.
   *
   * This file used to compute the month itself, and every difference between its version and
   * the real one was a printout that contradicted the board on the wall:
   *   * `iqamahSchedule` was not consulted at all, so a masjid that had scheduled a change —
   *     the whole point of the WhatsApp wizard — printed the OLD Iqamah times indefinitely;
   *   * `adhanOffsets` were not applied, so both the Adhan column and every offset-derived
   *     Iqamah were early by however many minutes the masjid had set;
   *   * a CSV override was honoured for Maghrib, which `buildModel` deliberately never does
   *     (Maghrib always tracks the calculated sunset).
   * One implementation of the precedence chain is the only way that stays true, so this now has
   * none of its own. `zonedNoon` is the required anchor — see buildModel.
   */
  const cells: DayCell[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const m = buildModel(tt, zonedNoon(year, month, day, tz));
    const row = (key: string) => m.rows.find((r) => r.key === key);
    cells.push({
      day,
      jumuah: m.isFriday ? jumuahLabel(m.jumuah, tt.timeFormat) : null,
      rows: PRAYERS.map((p) => ({
        label: p.label,
        adhan: fmt(row(p.key)?.adhan ?? null, tt.timeFormat),
        iqamah: fmt(row(p.key)?.iqamah ?? null, tt.timeFormat),
      })),
    });
  }

  // Assemble weeks (rows of 7), padding leading + trailing blanks.
  const weeks: (DayCell | null)[][] = [];
  let week: (DayCell | null)[] = [];
  for (let i = 0; i < firstDow; i++) week.push(null);
  for (const c of cells) {
    week.push(c);
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  if (week.length) { while (week.length < 7) week.push(null); weeks.push(week); }

  const dayName = (c: DayCell | null, dow: number): string => {
    if (!c) return '<td class="empty"></td>';
    const fri = dow === 5;
    const rowsHtml = c.rows
      .map(
        (r) =>
          `<div class="pr"><span class="pn">${r.label}</span><span class="pt">${r.adhan}${r.iqamah ? ` / ${r.iqamah}` : ''}</span></div>`,
      )
      .join('');
    return (
      `<td class="${fri ? 'fri' : ''}">` +
      `<div class="dnum">${c.day}</div>` +
      (c.jumuah ? `<div class="jum">Jumu'ah ${esc(c.jumuah)}</div>` : '') +
      `<div class="prs">${rowsHtml}</div>` +
      '</td>'
    );
  };

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const headHtml = WEEKDAYS.map((d, i) => `<th class="${i === 5 ? 'fri' : ''}">${d}</th>`).join('');
  const bodyHtml = weeks
    .map((wk) => `<tr>${wk.map((c, dow) => dayName(c, dow)).join('')}</tr>`)
    .join('\n      ');

  const masjid = esc(tt.masjidName || 'Our Masjid');
  // Short, compact method name for the corner legend (the full label is long).
  const methodLabel = esc(tt.method);
  const fmtLabel = tt.timeFormat === '24h' ? '24-hour' : '12-hour';
  const tzNote = tt.timezone ? `Times are local to ${esc(tt.timezone)}.` : '';
  const logo = tt.logoImage ? logoDataUri(tt.logoImage) : null;

  // Month navigation (prev/next) links so the printed sheet can be re-aimed.
  const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  const navLink = (y: number, m: number, text: string) =>
    `<a class="nav" href="?month=${y}-${pad2(m)}">${text}</a>`;

  // Fit the whole month onto ONE landscape page: size the rows + prayer text to the
  // number of weeks (4, 5 or 6) so a tall month never spills onto a second sheet.
  // ~545px of usable height at 96dpi (landscape Letter, 8mm margins, minus chrome).
  const rows = weeks.length;
  const rowH = Math.floor(545 / rows);
  const prayerFs = Math.max(9, Math.min(13, Math.floor((rowH - 30) / 6.8)));
  const dnumFs = Math.min(16, prayerFs + 4);
  const jumFs = Math.max(9, prayerFs - 1);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${masjid} — ${esc(monthName)} prayer calendar</title>
<style>
  :root {
    --ink:#16241e; --dim:#5b6b63; --line:#d9e0db; --paper:#e7e7e4;
    --green:#143027; --emerald:#1fa37a; --gold:#a8801f; --gold-bg:#f4ecd6; --gold-soft:#b9912a;
  }
  * { box-sizing: border-box; }
  html,body { margin:0; padding:0; }
  body { font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif; color:var(--ink); background:var(--paper);
         padding:14px 18px; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px;
           border-bottom:3px solid var(--gold-soft); padding-bottom:8px; margin-bottom:10px; }
  .brand { display:flex; align-items:center; gap:14px; }
  .brand img { height:56px; width:auto; }
  h1 { font-size:24px; margin:0; letter-spacing:.2px; }
  .subtitle { font-size:15px; margin:2px 0 0; color:var(--emerald); font-weight:700; }
  .legend { text-align:right; color:var(--dim); font-size:12px; line-height:1.55; padding-top:2px; white-space:nowrap; }
  .legend .em { color:var(--gold); font-style:italic; }
  .nav { color:var(--emerald); text-decoration:none; font-weight:600; margin-left:10px; font-size:12px; }

  table { width:100%; border-collapse:separate; border-spacing:0; table-layout:fixed; }
  thead th { background:var(--green); color:#eaf3ee; font-size:13px; font-weight:700; padding:6px 6px; text-align:center;
             border-right:1px solid rgba(255,255,255,.08); }
  thead th:last-child { border-right:none; }
  thead th.fri { background:var(--gold-soft); color:#1c1402; }
  tbody td { vertical-align:top; height:${rowH}px; padding:4px 7px; border-bottom:1px solid var(--line); border-right:1px solid var(--line);
             background:#f2f2ef; overflow:hidden; }
  tbody tr td:last-child { border-right:none; }
  tbody td.empty { background:transparent; border-right-color:transparent; }
  tbody td.fri { background:var(--gold-bg); }
  .dnum { font-size:${dnumFs}px; font-weight:700; color:var(--emerald); line-height:1; margin-bottom:2px; }
  .jum { font-size:${jumFs}px; font-weight:700; color:var(--gold); margin-bottom:2px; }
  .prs { display:flex; flex-direction:column; gap:0; }
  .pr { display:flex; justify-content:space-between; gap:6px; font-size:${prayerFs}px; line-height:1.3; }
  .pn { color:var(--ink); }
  .pt { color:var(--dim); font-variant-numeric:tabular-nums; white-space:nowrap; }

  footer { margin-top:8px; text-align:center; color:var(--dim); font-size:11px; }
  .print-btn { display:inline-block; margin-left:14px; padding:6px 14px; border:1px solid var(--emerald); border-radius:8px;
               background:var(--emerald); color:#fff; font-size:12px; cursor:pointer; }
  @page { size: Letter landscape; margin: 8mm; }
  @media print {
    .print-btn, .nav { display:none; }
    body { padding:0; background:#fff; }
    table, tr, td, thead { break-inside:avoid; page-break-inside:avoid; }
    header { break-after:avoid; }
  }
</style>
</head>
<body>
<header>
  <div class="brand">
    ${logo ? `<img src="${logo}" alt="" />` : ''}
    <div>
      <h1>${masjid}</h1>
      <p class="subtitle">Prayer Calendar — ${esc(monthName)}</p>
    </div>
  </div>
  <div class="legend">
    Each cell: Adhan / Iqamah &nbsp;·&nbsp; ${fmtLabel}<br />
    <span class="em">${methodLabel} &nbsp;·&nbsp; Asr: ${esc(tt.asrMadhab)}</span><br />
    ${navLink(prev.y, prev.m, '‹ Prev')}${navLink(next.y, next.m, 'Next ›')}
    <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  </div>
</header>
<table>
  <thead><tr>${headHtml}</tr></thead>
  <tbody>
      ${bodyHtml}
  </tbody>
</table>
<footer>${esc(monthName)}${tzNote ? ` · ${tzNote}` : ''}</footer>
</body>
</html>`;
}

