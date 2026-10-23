// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * iqamahSchedule.ts — the "from this date onward" Iqamah change schedule.
 *
 * Unlike iqamahYear (a per-DAY map, from CSV import), a schedule is a small list of
 * step-changes: from an absolute date, the listed prayers take new fixed times and KEEP
 * them until a later entry's date takes over. This is the common masjid case — iqamah is
 * changed a handful of times a year and then holds — which a per-day table models badly.
 *
 * Each prayer carries forward INDEPENDENTLY: an entry that only sets Fajr leaves the other
 * prayers on whatever the previous entry (or the base rule) gave. Maghrib is never
 * scheduled (it always follows the calculated sunset + its offset).
 */
import type { IqamahScheduleEntry, Timetable } from './types';
import { parseClock } from './iqamahCsv';
import { localParts } from './prayer/engine';

const DAILY = ['fajr', 'dhuhr', 'asr', 'isha'] as const;
type DailyKey = (typeof DAILY)[number];

/** The effective scheduled times for a calendar date. */
export interface ResolvedSchedule {
  fajr?: string;
  dhuhr?: string;
  asr?: string;
  isha?: string;
  /** Jumu'ah time(s) "HH:MM" effective on the date (replaces the base Jumu'ah times) */
  jumuah?: string[];
}

/** Comparable integer for a "YYYY-MM-DD" (invalid → +Infinity so it never applies). */
function fromNum(from: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from);
  if (!m) return Number.POSITIVE_INFINITY;
  return +m[1] * 10000 + +m[2] * 100 + +m[3];
}

/** Resolve the schedule to the effective overrides for calendar date (year, month, day):
 *  for each daily prayer, the time from the latest entry (`from` ≤ date) that sets it; and
 *  the Jumu'ah times from the latest such entry that sets a non-empty jumuah. Entries need
 *  not be pre-sorted. Returns an empty object when nothing applies. */
export function resolveSchedule(
  schedule: IqamahScheduleEntry[] | undefined,
  year: number,
  month: number,
  day: number,
): ResolvedSchedule {
  const out: ResolvedSchedule = {};
  if (!schedule || !schedule.length) return out;
  const dateNum = year * 10000 + month * 100 + day;
  const sorted = [...schedule].sort((a, b) => fromNum(a.from) - fromNum(b.from));
  for (const e of sorted) {
    if (fromNum(e.from) > dateNum) continue; // not yet effective
    for (const k of DAILY) if (e[k]) out[k] = e[k];
    if (e.jumuah && e.jumuah.length) out.jumuah = e.jumuah;
  }
  return out;
}

/**
 * A FIXED Iqamah time in the panel's "Iqamah times" table means the time in force TODAY.
 *
 * It used to mean the time typed before any scheduled change, and so it never moved: Fajr was
 * scheduled from 6:00 to 6:30 on the 1st, the screens went to 6:30, and the table kept saying
 * 6:00 for good. The panel now shows the scheduled time once it has taken effect (`toForm` in
 * Timetables.tsx). This is the other half: reading the form back.
 *
 * The stored rule itself is NOT moved to the new time. It is what every date before the first
 * change resolves to, so overwriting it would rewrite that history — the printed calendar for
 * the days before the change, and the comparison that recognises a change as a change (the
 * on-screen reminder, the WhatsApp post, the poster and the calendar's highlight all ask "does
 * this differ from the day before?", and the day before would quietly become the new time too).
 *
 * So, for each fixed prayer a change is setting today:
 *   - the same time as the change → not an edit; the rule keeps its stored value;
 *   - the same time as the stored RULE → not an edit either. That is what a panel opened before
 *     this existed sends back, and what a body with no `iqamah` falls back to; read as an edit it
 *     would write the old time over the scheduled change and undo it on every screen. The cost is
 *     one ambiguous case — someone deliberately typing the pre-change time back in — which does
 *     nothing rather than something wrong; removing the scheduled change is the way to do that;
 *   - any other time → an edit. It goes onto THAT change, so it shows from now on, and the rule
 *     again keeps its value. (Onto the rule it would do nothing at all: the change outranks it.)
 *
 * Only fixed-to-fixed. A prayer just switched to "fixed" was not showing a scheduled time, so its
 * value is a fresh choice and is left as typed. `next.iqamahSchedule` is replaced with a copy
 * when an edit lands, never mutated: it is `base`'s own array, and the preview reads through here.
 */
export function keepRuleUnderSchedule(next: Timetable, base: Timetable, now: Date): void {
  const schedule = base.iqamahSchedule;
  if (!schedule?.length || next.iqamahSchedule !== schedule) return;
  const p = localParts(now, next.timezone || undefined);
  const today = p.year * 10000 + p.month * 100 + p.day;
  let edited: IqamahScheduleEntry[] | null = null;
  for (const k of DAILY) {
    const rule = next.iqamah[k];
    const was = base.iqamah[k];
    if (rule?.mode !== 'fixed' || was?.mode !== 'fixed') continue;
    // The latest change on or before today that sets this prayer.
    let at = -1;
    schedule.forEach((e, i) => {
      if (e[k] && fromNum(e.from) <= today && (at < 0 || fromNum(e.from) >= fromNum(schedule[at].from))) at = i;
    });
    if (at < 0) continue;
    const typed = rule.fixed ? parseClock(rule.fixed) : null;
    if (typed && typed !== schedule[at][k] && typed !== (was.fixed && parseClock(was.fixed))) {
      edited ??= schedule.map((e) => ({ ...e }));
      edited[at][k] = typed;
    }
    next.iqamah = { ...next.iqamah, [k]: { ...rule, fixed: was.fixed } };
  }
  if (edited) next.iqamahSchedule = edited;
}

/** Validate `from` to a canonical "YYYY-MM-DD", or null. */
function normFromDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const da = +m[3];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Clean an IqamahSchedule posted by the editor: valid "YYYY-MM-DD" `from` (one entry per
 *  date), "HH:MM" prayer times, a de-duped sorted Jumu'ah list, only real fields; drops any
 *  entry that sets nothing. Returns entries sorted ascending by date. */
export function normalizeIqamahSchedule(input: unknown): IqamahScheduleEntry[] {
  if (!Array.isArray(input)) return [];
  const out: IqamahScheduleEntry[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (out.length >= 200) break;
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const from = normFromDate(r.from);
    if (!from || seen.has(from)) continue; // one entry per date
    const entry: IqamahScheduleEntry = { from };
    for (const k of DAILY) {
      const v = r[k];
      if (typeof v === 'string' && v.trim()) {
        const c = parseClock(v);
        if (c) entry[k] = c;
      }
    }
    const jRaw = Array.isArray(r.jumuah) ? r.jumuah : typeof r.jumuah === 'string' ? [r.jumuah] : [];
    const jums: string[] = [];
    for (const jv of jRaw) {
      if (jums.length >= 6) break;
      if (typeof jv === 'string' && jv.trim()) {
        const c = parseClock(jv);
        if (c && !jums.includes(c)) jums.push(c);
      }
    }
    jums.sort();
    if (jums.length) entry.jumuah = jums;
    if (DAILY.some((k) => entry[k]) || entry.jumuah) {
      out.push(entry);
      seen.add(from);
    }
  }
  out.sort((a, b) => fromNum(a.from) - fromNum(b.from));
  return out;
}

export type { DailyKey };
export { DAILY };
