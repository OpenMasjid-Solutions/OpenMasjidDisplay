// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Printable monthly prayer-time calendar.
 *
 * Returns a self-contained, print-styled HTML page laid out as a true month
 * calendar grid (weeks as rows, Sun–Sat columns), each day showing every
 * prayer's Adhan / Iqamah time, with Fridays highlighted and the Jumu'ah time
 * called out. The browser's own "Save as PDF" turns it into a PDF, so we add no
 * PDF library — staying lightweight (see CLAUDE.md §5).
 */
import {
  prayerTimes,
  timezoneOffsetHours,
  iqamahHours,
  parseHHMM,
  type MethodDef,
} from './prayer/engine';
import { logoDataUri } from './render/background';
import type { Timetable } from './types';

const pad2 = (n: number) => String(n).padStart(2, '0');

function fmt(hours: number | null, timeFormat: string): string {
  if (hours == null) return '—';
  let h = Math.floor(hours) % 24;
  let m = Math.round((hours - Math.floor(hours)) * 60);
  if (m === 60) { m = 0; h = (h + 1) % 24; }
  if (h < 0) h += 24;
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

/** A readable Jumu'ah summary from the timetable's configured times (e.g. "1:30 & 4:00"). */
function jumuahLabel(tt: Timetable): string | null {
  const times = (tt.jumuah ?? [])
    .map((t) => parseHHMM(t))
    .filter((x): x is number => x != null)
    .map((h) => fmt(h, tt.timeFormat));
  return times.length ? times.join(' & ') : null;
}

/** Build a printable month calendar. `month` is 1-12, `year` is the full year. */
export function renderMonthPrintHtml(tt: Timetable, year: number, month: number): string {
  const tz = tt.timezone || undefined;
  const method: CalcMethodOrDef =
    tt.method === 'Custom'
      ? { label: 'Custom', fajr: tt.fajrAngle ?? 18, isha: tt.ishaAngle ?? 17 }
      : tt.method;
  const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // Day of week (0=Sun) the 1st falls on, so we can pad the first row.
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const jLabel = jumuahLabel(tt);

  // Compute every day once.
  const cells: DayCell[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const instant = new Date(Date.UTC(year, month - 1, day, 12));
    const off = timezoneOffsetHours(instant, tz);
    const t = prayerTimes({ year, month, day }, tt.latitude!, tt.longitude!, off, method, tt.asrMadhab);
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const isFri = dow === 5;

    const dayKey = `${pad2(month)}-${pad2(day)}`;
    const yearRow = tt.iqamahYear?.[dayKey];
    const iqOf = (k: string, adhan: number): number | null => {
      const csv = (yearRow as Record<string, string> | undefined)?.[k];
      const csvH = csv ? parseHHMM(csv) : null;
      if (csvH != null) return csvH;
      return iqamahHours(adhan, tt.iqamah[k as keyof typeof tt.iqamah]);
    };

    cells.push({
      day,
      jumuah: isFri ? jLabel : null,
      rows: PRAYERS.map((p) => ({
        label: p.label,
        adhan: fmt(t[p.key as keyof typeof t], tt.timeFormat),
        iqamah: fmt(iqOf(p.key, t[p.key as keyof typeof t]), tt.timeFormat),
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

type CalcMethodOrDef = Timetable['method'] | MethodDef;
