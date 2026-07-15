// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * iqamahCsv.ts — import / export of a whole year of Iqamah times as CSV.
 *
 * A masjid can upload one file with a row per day (keyed by month-day, so it
 * repeats every year) and exact Iqamah clock times per prayer. Those override the
 * per-prayer rules for matching dates; other days fall back to the rules.
 *
 * Accepted columns (header, case-insensitive): date, fajr, dhuhr, asr, isha, jumuah.
 * **Maghrib is intentionally NOT accepted** — its adhan drifts with sunset all year, so a
 * fixed clock time would be wrong. Maghrib is always the calculated sunset time plus the
 * Maghrib Iqamah offset (its per-prayer rule); any Maghrib column in an upload is ignored.
 * The date may be YYYY-MM-DD, MM-DD or M/D; times may be 24h "HH:MM" or 12h "h:MM am/pm",
 * normalised to "HH:MM" 24h.
 */
import type { IqamahYear, Timetable } from './types';
import { prayerTimes, iqamahHours, timezoneOffsetHours, localParts } from './prayer/engine';

type PrayerCol = 'fajr' | 'dhuhr' | 'asr' | 'maghrib' | 'isha' | 'jumuah';
// Columns actually handled in CSV / per-day overrides. Maghrib is excluded on purpose — it's
// always the calculated sunset time plus its Iqamah offset, never a stored per-day value.
const CSV_COLS = ['fajr', 'dhuhr', 'asr', 'isha', 'jumuah'] as const;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Parse a clock string ("HH:MM", "h:MM am/pm") to "HH:MM" 24h, or null. */
function parseClock(s: string): string | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*(am|pm)?\s*$/i.exec(s);
  if (!m) return null;
  let h = +m[1];
  const min = +m[2];
  if (min > 59) return null;
  const ap = m[3]?.toLowerCase();
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === 'pm' && h !== 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
  }
  if (h > 23) return null;
  return `${pad2(h)}:${pad2(min)}`;
}

// Month names (full + common abbreviations), so dates like Excel's "1-Jan" parse.
const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/** Parse a date cell to "MM-DD", or null. Accepts YYYY-MM-DD, MM-DD, M/D, and the
 *  month-NAME forms Excel auto-produces when it reformats a CSV (1-Jan, Jan-1,
 *  "1 January", 01-Jan-2024, …) — separators -, /, ., or space, optional trailing
 *  year. (Excel mangling "01-01" → "1-Jan" was breaking every upload.) */
function parseMonthDay(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  let mo: number | null = null;
  let da: number | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t))) {
    mo = +m[2]; // YYYY-MM-DD
    da = +m[3];
  } else if ((m = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.]\d{2,4})?$/.exec(t))) {
    mo = +m[1]; // MM-DD or M/D (optional trailing year) — month first
    da = +m[2];
  } else if ((m = /^(\d{1,2})[-/.\s]+([A-Za-z]{3,})(?:[-/.\s]+\d{2,4})?$/.exec(t))) {
    da = +m[1]; // D-Mon (e.g. 1-Jan, "1 January", 01-Jan-2024)
    mo = MONTH_NAMES[m[2].toLowerCase()] ?? null;
  } else if ((m = /^([A-Za-z]{3,})[-/.\s]+(\d{1,2})(?:[-/.\s]+\d{2,4})?$/.exec(t))) {
    mo = MONTH_NAMES[m[1].toLowerCase()] ?? null; // Mon-D (e.g. Jan-1, "January 1")
    da = +m[2];
  } else {
    return null;
  }
  if (mo == null || da == null || mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return `${pad2(mo)}-${pad2(da)}`;
}

function splitLine(line: string): string[] {
  // Minimal CSV: commas, optional surrounding double-quotes.
  return line.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1').trim());
}

export interface ParsedCsv {
  data: IqamahYear;
  rows: number;
  errors: string[];
}

export function parseIqamahCsv(text: string): ParsedCsv {
  const lines = String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const errors: string[] = [];
  const data: IqamahYear = {};
  if (lines.length === 0) return { data, rows: 0, errors: ['The file was empty.'] };

  // Header → column index map.
  const header = splitLine(lines[0]).map((h) => h.toLowerCase());
  const dateCol = header.findIndex((h) => h === 'date' || h === 'day' || h === 'month-day');
  if (dateCol < 0) {
    return { data, rows: 0, errors: ['No "date" column found. The first row must be a header like: date,fajr,dhuhr,asr,maghrib,isha'] };
  }
  const colOf: Partial<Record<PrayerCol, number>> = {};
  for (const p of CSV_COLS) {
    const idx = header.indexOf(p);
    if (idx >= 0) colOf[p] = idx;
  }

  let rows = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const key = parseMonthDay(cells[dateCol] ?? '');
    if (!key) {
      if (errors.length < 10) errors.push(`Line ${i + 1}: couldn't read the date "${cells[dateCol] ?? ''}".`);
      continue;
    }
    const entry: Partial<Record<PrayerCol, string>> = {};
    for (const p of CSV_COLS) {
      const idx = colOf[p];
      if (idx == null) continue;
      const raw = cells[idx] ?? '';
      if (!raw) continue;
      const clk = parseClock(raw);
      if (clk) entry[p] = clk;
      else if (errors.length < 10) errors.push(`Line ${i + 1}: couldn't read ${p} time "${raw}".`);
    }
    if (Object.keys(entry).length > 0) {
      data[key] = entry;
      rows++;
    }
  }
  return { data, rows, errors };
}

/** Validate/clean an IqamahYear object posted by the in-app monthly editor:
 *  "MM-DD" keys, "HH:MM" times, only known prayer columns. */
export function normalizeIqamahYear(input: unknown): IqamahYear {
  const out: IqamahYear = {};
  if (!input || typeof input !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (n >= 400) break;
    const key = parseMonthDay(k);
    if (!key || !v || typeof v !== 'object') continue;
    const row = v as Record<string, unknown>;
    const entry: Partial<Record<PrayerCol, string>> = {};
    for (const p of CSV_COLS) {
      const raw = row[p];
      if (typeof raw === 'string' && raw.trim()) {
        const clk = parseClock(raw);
        if (clk) entry[p] = clk;
      }
    }
    if (Object.keys(entry).length > 0) {
      out[key] = entry;
      n++;
    }
  }
  return out;
}

/** Serialise stored overrides back to CSV (sorted by date). No Maghrib column — it's always
 *  the calculated sunset time plus its Iqamah offset, never a stored per-day value. */
export function toCsv(year: IqamahYear | undefined): string {
  const head = 'date,fajr,dhuhr,asr,isha,jumuah';
  const keys = Object.keys(year ?? {}).sort();
  const lines = keys.map((k) => {
    const e = (year as IqamahYear)[k];
    return [k, e.fajr ?? '', e.dhuhr ?? '', e.asr ?? '', e.isha ?? '', e.jumuah ?? ''].join(',');
  });
  return [head, ...lines].join('\n') + '\n';
}

function fmtHHMM(hours: number | null): string {
  if (hours == null || !Number.isFinite(hours)) return '';
  let total = Math.round(hours * 60);
  total = ((total % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // leap-year Feb

/** A full-year example/template CSV. When the timetable has a location, every row
 *  is pre-filled with the Iqamah times its rules currently produce — so it doubles
 *  as a ready-to-edit starting point the masjid can tweak and re-upload. */
export function templateCsv(tt: Timetable): string {
  // No Maghrib column: it's always the calculated sunset time + its Iqamah offset.
  const head = 'date,fajr,dhuhr,asr,isha,jumuah';
  const lines: string[] = [head];
  const hasLoc = tt.latitude != null && tt.longitude != null;
  const tz = tt.timezone || undefined;
  const YEAR = 2024; // a leap year, so 02-29 exists
  const method = tt.method === 'Custom' ? { label: 'Custom', fajr: tt.fajrAngle ?? 18, isha: tt.ishaAngle ?? 17 } : tt.method;
  for (let mo = 1; mo <= 12; mo++) {
    for (let da = 1; da <= DAYS_IN_MONTH[mo - 1]; da++) {
      const key = `${pad2(mo)}-${pad2(da)}`;
      if (!hasLoc) {
        lines.push(`${key},,,,,`);
        continue;
      }
      const noon = new Date(Date.UTC(YEAR, mo - 1, da, 12));
      const off = timezoneOffsetHours(noon, tz);
      const parts = localParts(noon, tz);
      const t = prayerTimes(parts, tt.latitude!, tt.longitude!, off, method, tt.asrMadhab);
      const iq = (k: keyof typeof tt.iqamah, adhan: number) => fmtHHMM(iqamahHours(adhan, tt.iqamah[k]));
      // Maghrib is omitted — it always follows the calculated sunset + its Iqamah offset.
      lines.push([key, iq('fajr', t.fajr), iq('dhuhr', t.dhuhr), iq('asr', t.asr), iq('isha', t.isha), ''].join(','));
    }
  }
  return lines.join('\n') + '\n';
}
