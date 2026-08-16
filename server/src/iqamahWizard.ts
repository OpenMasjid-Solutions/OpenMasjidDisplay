// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * iqamahWizard.ts — adding a scheduled Iqāmah change by WhatsApp, one question at a time.
 *
 * ## Why there is a state machine here at all
 *
 * The platform's command contract is **one shot**: it hands us `{ command, text }` and takes
 * one reply. It holds a menu snapshot and a pending confirmation per sender, but it has no
 * notion of "ask the next question and wait" — a command's argument must be typed inline on
 * the same line (`!display 1 <answer>`), or it answers `missing-argument` itself.
 *
 * So a guided flow has to be ours. Each `!display 1 <answer>` is a separate call, and this
 * module is what remembers where we were. Declaring the argument `required: false` is what
 * makes a bare `!display 1` legal, which is how the flow starts.
 *
 * ## One session, because the platform tells us nothing about who is asking
 *
 * The request body is `{ command, text, requestId, locale }`. There is **no sender**, so the
 * state cannot be keyed per person — there is one session, and it belongs to whoever is
 * mid-flow. In practice one admin is standing in a car park fixing one thing, and the
 * platform has already decided they are allowed to. Two admins at once would interleave, so
 * every reply restates the whole gathered change, and the session expires after
 * {@link SESSION_TTL_MS}.
 *
 * ## Nothing is written until "save"
 *
 * `confirm: true` in the manifest would make the platform demand a code before **every** step
 * of the wizard, which is unusable. So the command declares `confirm: false` and this owns its
 * own confirmation: the times are gathered, echoed back in the masjid's own time format, and
 * only written when the admin sends `save`. That echo is also the safety net for a time typed
 * without am/pm — the admin sees "5:45 AM" before anything changes on a wall.
 */
import type { DB, IqamahScheduleEntry, Timetable } from './types';
import type { Store } from './store';
import { normalizeIqamahSchedule } from './iqamahSchedule';
import { fmtShort, WEEKDAYS, MONTH_NAMES } from './render/svg';
import { localParts } from './prayer/engine';
import { announceTimetable } from './whatsappAnnounce';

/** How long a half-finished change waits. Long enough to be interrupted by a phone call,
 *  short enough that tomorrow's admin never inherits yesterday's abandoned answers. */
export const SESSION_TTL_MS = 15 * 60_000;

/** Maghrib is deliberately absent — it is never schedulable (see iqamahSchedule.ts), so
 *  offering it would be a number that cannot work. Order is the menu order. */
export const WIZARD_PRAYERS = [
  { key: 'fajr', label: 'Fajr' },
  { key: 'dhuhr', label: 'Dhuhr' },
  { key: 'asr', label: 'Asr' },
  { key: 'isha', label: 'Isha' },
  { key: 'jumuah', label: "Jumu'ah" },
] as const;

export type WizardPrayer = (typeof WIZARD_PRAYERS)[number]['key'];

export interface WizardSession {
  step: 'date' | 'prayer' | 'time';
  touchedAt: number;
  /** "YYYY-MM-DD" once the date is agreed */
  date?: string;
  /** 24-hour "HH:MM" per prayer; jumuah may hold several */
  times: Partial<Record<Exclude<WizardPrayer, 'jumuah'>, string>>;
  jumuah?: string[];
  /** which prayer the next time belongs to */
  awaiting?: WizardPrayer;
}

export interface WizardReply {
  ok: boolean;
  text: string;
}

const EXIT_WORDS = new Set(['exit', 'quit', 'stop', 'cancel', 'nevermind', 'never mind']);
const SAVE_WORDS = new Set(['save', 'done', 'finish', 'ok']);
const BACK_WORDS = new Set(['back', 'menu']);

const pad2 = (n: number) => String(n).padStart(2, '0');

// ── parsing ──────────────────────────────────────────────────────────────────

/**
 * A date, but only in forms that cannot mean two different days.
 *
 * `1/9/2026` is rejected on purpose. It is 9 January to an American and 1 September to
 * everyone else, and the cost of guessing wrong here is a masjid praying at the wrong time on
 * a day nobody checked. Asking for the month in words costs one more message.
 */
export function parseWizardDate(raw: string): string | null {
  const s = raw.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) return validDate(+iso[1], +iso[2], +iso[3]);

  const monthOf = (w: string): number => {
    const i = MONTH_NAMES.findIndex((m) => m.toLowerCase().startsWith(w.toLowerCase().slice(0, 3)));
    return i < 0 ? 0 : i + 1;
  };
  // "1 Sep 2026" / "1 September 2026"
  const dmy = /^(\d{1,2}) ([A-Za-z]{3,9}) (\d{4})$/.exec(s);
  if (dmy) return validDate(+dmy[3], monthOf(dmy[2]), +dmy[1]);
  // "Sep 1 2026" / "September 1 2026"
  const mdy = /^([A-Za-z]{3,9}) (\d{1,2}) (\d{4})$/.exec(s);
  if (mdy) return validDate(+mdy[3], monthOf(mdy[1]), +mdy[2]);
  return null;
}

function validDate(y: number, mo: number, da: number): string | null {
  if (!y || !mo || !da || mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  if (y < 2000 || y > 2100) return null;
  // Round-trip through UTC noon to reject 31 February and 29 February in a common year.
  const probe = new Date(Date.UTC(y, mo - 1, da, 12));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== da) return null;
  return `${y}-${pad2(mo)}-${pad2(da)}`;
}

/**
 * A time, resolved against the prayer it belongs to.
 *
 * "5:45" is AM for Fajr and PM for Asr, and an admin on a phone will type it without a
 * suffix every time. Guessing is safe here ONLY because nothing is written until the change
 * is echoed back and confirmed — the admin reads "Asr 5:15 PM" before a wall changes.
 * An explicit am/pm always wins, and anything past 12 is read as 24-hour.
 */
export function parseWizardTime(prayer: WizardPrayer, raw: string): string | null {
  const m = /^(\d{1,2})[:.](\d{2})\s*(am|pm|a|p)?\.?$/i.exec(raw.trim());
  if (!m) return null;
  let h = +m[1];
  const min = +m[2];
  if (min > 59) return null;
  const suffix = m[3]?.[0]?.toLowerCase();
  if (suffix) {
    if (h < 1 || h > 12) return null;
    h = suffix === 'a' ? (h === 12 ? 0 : h) : h === 12 ? 12 : h + 12;
  } else if (h > 12) {
    if (h > 23) return null; // already 24-hour
  } else if (h >= 1 && h <= 12) {
    // Fajr is the only one of these that is ever in the morning.
    if (prayer === 'fajr') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  }
  if (h < 0 || h > 23) return null;
  return `${pad2(h)}:${pad2(min)}`;
}

/** Jumu'ah can have several jamā'ahs, so it takes a list. */
export function parseWizardTimes(prayer: WizardPrayer, raw: string): string[] | null {
  const parts = raw
    .split(/[,;]|\band\b/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length || parts.length > 6) return null;
  const out: string[] = [];
  for (const p of parts) {
    const t = parseWizardTime(prayer, p);
    if (!t) return null;
    out.push(t);
  }
  return [...new Set(out)].sort();
}

// ── formatting ───────────────────────────────────────────────────────────────

function longDate(iso: string): string {
  const [y, mo, da] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, mo - 1, da, 12)).getUTCDay();
  return `${WEEKDAYS[dow]}, ${MONTH_NAMES[mo - 1]} ${da}, ${y}`;
}

function show(tt: Timetable, hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return fmtShort(h + m / 60, tt.timeFormat);
}

/** The numbered prayer list, with anything already chosen shown beside it. Repeated in full
 *  on every reply: the sender is reading one message at a time on a phone, and the platform
 *  gives us no way to know whether they still have the last one on screen. */
function prayerMenu(tt: Timetable, s: WizardSession): string {
  return WIZARD_PRAYERS.map((p, i) => {
    const set =
      p.key === 'jumuah'
        ? s.jumuah?.map((t) => show(tt, t)).join(', ')
        : s.times[p.key as Exclude<WizardPrayer, 'jumuah'>]
          ? show(tt, s.times[p.key as Exclude<WizardPrayer, 'jumuah'>]!)
          : '';
    return `${i + 1}  ${p.label}${set ? ` — ${set}` : ''}`;
  }).join('\n');
}

function chosenCount(s: WizardSession): number {
  return Object.keys(s.times).length + (s.jumuah?.length ? 1 : 0);
}

function askPrayer(tt: Timetable, s: WizardSession, lead: string): string {
  const any = chosenCount(s) > 0;
  return [
    lead,
    '',
    prayerMenu(tt, s),
    '',
    any ? 'Send another number, or *save* to save.' : 'Send a number.',
    'Send *exit* to stop without saving.',
  ].join('\n');
}

// ── the machine ──────────────────────────────────────────────────────────────

/**
 * Advance the wizard by one message.
 *
 * Pure over (session, input, timetable): the session is passed in and the next one is handed
 * back, so every branch is testable without a store, a clock or a platform.
 */
export function stepWizard(
  session: WizardSession | null,
  input: string,
  tt: Timetable,
  nowMs: number,
  todayIso: string,
): { session: WizardSession | null; reply: WizardReply; commit?: IqamahScheduleEntry } {
  const text = input.trim();
  const word = text.toLowerCase();

  // Expiry is checked here rather than on a timer: a session only matters when someone is
  // answering it, and a stale one must never absorb an answer meant to start a new change.
  let s = session && nowMs - session.touchedAt <= SESSION_TTL_MS ? session : null;

  if (s && EXIT_WORDS.has(word)) {
    return { session: null, reply: { ok: true, text: 'Stopped. Nothing was changed.' } };
  }
  // Starting fresh: no session, or a bare `!display 1`.
  if (!s) {
    if (EXIT_WORDS.has(word)) return { session: null, reply: { ok: true, text: 'Nothing to stop.' } };
    s = { step: 'date', touchedAt: nowMs, times: {} };
    // An admin who typed the date straight after the number gets to skip a message.
    if (text) return stepWizard(s, text, tt, nowMs, todayIso);
    return {
      session: s,
      reply: {
        ok: true,
        text: [
          `*New Iqāmah change* — ${tt.name || tt.masjidName || 'your timetable'}`,
          '',
          'What date does it start?',
          'Send it as *2026-09-01* or *1 Sep 2026*.',
          '',
          'Send *exit* at any time to stop.',
        ].join('\n'),
      },
    };
  }

  s = { ...s, touchedAt: nowMs };

  if (s.step === 'date') {
    const iso = parseWizardDate(text);
    if (!iso) {
      return {
        session: s,
        reply: {
          ok: false,
          text: [
            "I couldn't read that as a date.",
            '',
            'Send it as *2026-09-01* or *1 Sep 2026*.',
            // Said plainly, because the alternative is a silently wrong month.
            'Please write the month in words or use the year-month-day form — *1/9/2026* means two different days in different countries, so I will not guess.',
          ].join('\n'),
        },
      };
    }
    if (iso < todayIso) {
      return {
        session: s,
        reply: { ok: false, text: `${longDate(iso)} has already passed. Send a date from today onwards.` },
      };
    }
    const next: WizardSession = { ...s, step: 'prayer', date: iso };
    return { session: next, reply: { ok: true, text: askPrayer(tt, next, `*From ${longDate(iso)}*\nWhich prayer is changing?`) } };
  }

  if (s.step === 'prayer') {
    if (SAVE_WORDS.has(word)) {
      if (!chosenCount(s)) {
        return { session: s, reply: { ok: false, text: askPrayer(tt, s, 'Nothing has been set yet, so there is nothing to save.') } };
      }
      const entry: IqamahScheduleEntry = { from: s.date!, ...s.times, ...(s.jumuah?.length ? { jumuah: s.jumuah } : {}) };
      return { session: null, reply: { ok: true, text: '' }, commit: entry };
    }
    const n = /^\d{1,2}$/.test(word) ? Number(word) : 0;
    const picked = WIZARD_PRAYERS[n - 1];
    if (!picked) {
      return { session: s, reply: { ok: false, text: askPrayer(tt, s, "That isn't one of the numbers.") } };
    }
    const next: WizardSession = { ...s, step: 'time', awaiting: picked.key };
    return {
      session: next,
      reply: {
        ok: true,
        text: [
          `*${picked.label}* — what time?`,
          picked.key === 'jumuah'
            ? "Send one time, or several separated by commas — *1:30, 2:30*."
            : 'Send it as *5:45*. Add *am* or *pm* if you want to be sure, or use 24-hour time.',
          '',
          'Send *back* to pick a different prayer.',
        ].join('\n'),
      },
    };
  }

  // step === 'time'
  const prayer = s.awaiting!;
  if (BACK_WORDS.has(word)) {
    const next: WizardSession = { ...s, step: 'prayer', awaiting: undefined };
    return { session: next, reply: { ok: true, text: askPrayer(tt, next, 'Which prayer is changing?') } };
  }
  if (prayer === 'jumuah') {
    const times = parseWizardTimes(prayer, text);
    if (!times) {
      return { session: s, reply: { ok: false, text: "I couldn't read that as a time. Send *1:30*, or *1:30, 2:30* for two jamā'ahs." } };
    }
    const next: WizardSession = { ...s, step: 'prayer', awaiting: undefined, jumuah: times };
    const set = times.map((t) => show(tt, t)).join(', ');
    return { session: next, reply: { ok: true, text: askPrayer(tt, next, `Jumu'ah set to *${set}*.`) } };
  }
  const t = parseWizardTime(prayer, text);
  if (!t) {
    return { session: s, reply: { ok: false, text: "I couldn't read that as a time. Send *5:45*, or *5:45 pm*, or 24-hour time like *17:15*." } };
  }
  const label = WIZARD_PRAYERS.find((p) => p.key === prayer)!.label;
  const next: WizardSession = { ...s, step: 'prayer', awaiting: undefined, times: { ...s.times, [prayer]: t } };
  return { session: next, reply: { ok: true, text: askPrayer(tt, next, `${label} set to *${show(tt, t)}*.`) } };
}

// ── committing ───────────────────────────────────────────────────────────────

/**
 * Merge the gathered change into the timetable's schedule.
 *
 * MERGE, not append: `normalizeIqamahSchedule` keeps one entry per date and the FIRST wins,
 * so pushing a second entry for a date that already has one would be silently discarded — the
 * admin would be told it saved and nothing would change. An existing entry for the same date
 * is updated in place instead, with the new times winning field by field.
 */
export function mergeScheduleEntry(existing: IqamahScheduleEntry[] | undefined, entry: IqamahScheduleEntry): IqamahScheduleEntry[] {
  const rows = [...(existing ?? [])];
  const at = rows.findIndex((r) => r.from === entry.from);
  if (at >= 0) rows[at] = { ...rows[at], ...entry };
  else rows.push(entry);
  return normalizeIqamahSchedule(rows);
}

/** What the admin is told once it is written — the whole change, in the masjid's own format,
 *  so the last message they see is the thing that is now true. */
export function savedText(tt: Timetable, entry: IqamahScheduleEntry): string {
  const lines = WIZARD_PRAYERS.filter((p) => (p.key === 'jumuah' ? entry.jumuah?.length : entry[p.key as 'fajr']))
    .map((p) =>
      p.key === 'jumuah'
        ? `${p.label} — ${entry.jumuah!.map((t) => show(tt, t)).join(', ')}`
        : `${p.label} — ${show(tt, entry[p.key as 'fajr']!)}`,
    );
  return [`*Saved.* From ${longDate(entry.from)}:`, '', ...lines, '', 'The screens are updating now.'].join('\n');
}

/** The timetable a WhatsApp command acts on — the same one the announcer posts about, so an
 *  admin cannot add a change to one timetable and have the notice go out about another. */
export function commandTimetable(db: DB): Timetable | null {
  return announceTimetable(db);
}

/** Today in the timetable's own zone, "YYYY-MM-DD" — a change "from today" must mean the
 *  masjid's today, not the server's. */
export function timetableToday(tt: Timetable, nowMs: number): string {
  const p = localParts(new Date(nowMs), tt.timezone || undefined);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/**
 * The whole command, from the platform's payload to the text an admin reads.
 *
 * Holds the single session (see the file header) and does the write, so the HTTP layer above
 * only has to authenticate and hand over the text.
 */
export class IqamahCommand {
  private session: WizardSession | null = null;

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {}

  run(text: string): WizardReply {
    const tt = commandTimetable(this.store.db);
    if (!tt) return { ok: false, text: 'There is no timetable to add a change to yet.' };
    if (tt.latitude == null || tt.longitude == null) {
      return { ok: false, text: 'Add the masjid location to the timetable in the panel first.' };
    }
    const nowMs = this.now();
    const out = stepWizard(this.session, text ?? '', tt, nowMs, timetableToday(tt, nowMs));
    this.session = out.session;
    if (!out.commit) return out.reply;

    const entry = out.commit;
    this.store.update((db) => {
      const idx = db.timetables.findIndex((t) => t.id === tt.id);
      if (idx >= 0) db.timetables[idx].iqamahSchedule = mergeScheduleEntry(db.timetables[idx].iqamahSchedule, entry);
    });
    return { ok: true, text: savedText(tt, entry) };
  }

  /** Test seam / teardown. */
  reset(): void {
    this.session = null;
  }
}
