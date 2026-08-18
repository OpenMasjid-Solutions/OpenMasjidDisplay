// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * iqamahWizard.ts — adding a scheduled Iqāmah change by WhatsApp, one question at a time.
 *
 * ## The platform asks the questions; we decide what they are
 *
 * OpenMasjidOS 0.51 lets a command hold a conversation: reply with a `followUp` token and the
 * sender's next plain message comes straight back to us with that token attached. So an admin
 * types `!display`, picks 1, and then just answers — no `!` on every line. The token is ours
 * to choose and the platform keeps no other state about the flow, so everything below the
 * token is this module.
 *
 * It still works on an older platform, where each answer arrives as its own
 * `!display 1 <answer>`: that is what the legacy session slot is for, and why the manifest
 * declares `argument.required: false` (which is what makes a bare `!display 1` legal).
 *
 * ## Two rules the platform imposes, both easy to get wrong
 *
 * **An `ok: false` ends the exchange.** So a misread date or a time with no am/pm replies
 * `ok: true` and asks again — answering "that was wrong" with a failure would drop the admin
 * out of the conversation for a typo.
 *
 * **The exchange can end without us**: three minutes idle, fifteen total, twelve turns, an
 * exit word, or the sender starting any other `!` command. We are not told. Nothing is applied
 * until `save`, so an abandoned flow leaves a draft that expires — never a half-written change.
 *
 * ## Nothing is written until "save"
 *
 * `confirm: true` in the manifest would make the platform demand a code before **every** step
 * of the wizard, which is unusable. So the command declares `confirm: false` and this owns its
 * own confirmation: the times are gathered, echoed back in full and in the masjid's own time
 * format, and only written when the admin sends `save`.
 */
import crypto from 'node:crypto';
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
  /** The timetable this draft was started against. The setting that picks it can be edited
   *  mid-conversation, and the change must land on the timetable the admin was actually shown
   *  in the first reply — not on whichever one the setting names by the time they send `save`. */
  timetableId?: string;
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

/** The platform ends an exchange itself on exit/quit/done/cancel/stop/nevermind, and we are
 *  not told. Ours are kept in step for the case where no follow-up exchange is running (an
 *  older platform, where every answer arrives as `!display 1 <answer>`). */
const EXIT_WORDS = new Set(['exit', 'quit', 'stop', 'cancel', 'nevermind', 'never mind']);

/**
 * "done" is NOT here, and must never be added.
 *
 * It is one of the platform's own exit words, so a sender typing it mid-exchange has the
 * conversation ended above us and this app is never called — the change would be silently
 * dropped while the admin believed they had saved it. `save` is the word we ask for.
 */
const SAVE_WORDS = new Set(['save', 'finish']);
const BACK_WORDS = new Set(['back', 'menu']);

const pad2 = (n: number) => String(n).padStart(2, '0');

// ── parsing ──────────────────────────────────────────────────────────────────

/**
 * A date, read **month first**: `9/1/2026` is 1 September 2026.
 *
 * That order is a deliberate choice, not a default — `1/9/2026` genuinely means two different
 * days on two sides of an ocean, and nothing in the payload says which the sender meant. What
 * makes it safe is the echo: the very next message reads "From Tuesday, September 1, 2026" in
 * full, and nothing is written until the admin sends `save`. A misread date is visible before
 * it can move a prayer.
 *
 * ISO (`2026-09-01`) and month-name forms (`1 Sep 2026`) are still accepted and are never
 * ambiguous, so they remain the better thing to type.
 */
export function parseWizardDate(raw: string): string | null {
  const s = raw.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
  // A four-digit year FIRST is ISO, and is checked before the month-first rule so
  // "2026-09-01" can never be read as month 2026.
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (iso) return validDate(+iso[1], +iso[2], +iso[3]);

  // Month first: 9/1/2026, 09/01/2026, 9-1-2026.
  const mdy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (mdy) return validDate(+mdy[3], +mdy[1], +mdy[2]);

  const monthOf = (w: string): number => {
    const i = MONTH_NAMES.findIndex((m) => m.toLowerCase().startsWith(w.toLowerCase().slice(0, 3)));
    return i < 0 ? 0 : i + 1;
  };
  // "1 Sep 2026" / "1 September 2026"
  const dmy = /^(\d{1,2}) ([A-Za-z]{3,9}) (\d{4})$/.exec(s);
  if (dmy) return validDate(+dmy[3], monthOf(dmy[2]), +dmy[1]);
  // "Sep 1 2026" / "September 1 2026"
  const nameFirst = /^([A-Za-z]{3,9}) (\d{1,2}) (\d{4})$/.exec(s);
  if (nameFirst) return validDate(+nameFirst[3], monthOf(nameFirst[1]), +nameFirst[2]);
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
 * A time on a 12-hour clock **must** say am or pm.
 *
 * This used to infer it from the prayer — morning for Fajr, evening for the rest — which is
 * right almost always and catastrophic the one time it is not. A prayer time is the single
 * piece of data in this app that a whole congregation acts on, and "almost always" is not the
 * standard for it. So a bare "5:45" is refused and the admin is asked to say which.
 *
 * A 24-hour time (13:00–23:59, or 00:xx) is unambiguous and is taken as written.
 */
export function parseWizardTime(raw: string): string | null {
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
    if (h > 23) return null; // unambiguous 24-hour
  } else if (h === 0) {
    // 00:15 — 24-hour midnight hour, unambiguous.
  } else {
    // 1–12 with nothing after it. Refused rather than guessed.
    return null;
  }
  if (h < 0 || h > 23) return null;
  return `${pad2(h)}:${pad2(min)}`;
}

/** Jumu'ah can have several jamā'ahs, so it takes a list. */
export function parseWizardTimes(raw: string): string[] | null {
  const parts = raw
    .split(/[,;]|\band\b/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length || parts.length > 6) return null;
  const out: string[] = [];
  for (const p of parts) {
    const t = parseWizardTime(p);
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
          'Send it as *9/1/2026* (month first), *2026-09-01* or *1 Sep 2026*.',
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
          // ok:true even though the answer was wrong: an ok:false ENDS the platform's
          // follow-up exchange, so a typo would drop the admin out of the flow entirely.
          ok: true,
          text: ["I couldn't read that as a date.", '', 'Send it as *9/1/2026* (month first), *2026-09-01* or *1 Sep 2026*.'].join('\n'),
        },
      };
    }
    if (iso < todayIso) {
      return {
        session: s,
        reply: { ok: true, text: `${longDate(iso)} has already passed. Send a date from today onwards.` },
      };
    }
    const next: WizardSession = { ...s, step: 'prayer', date: iso };
    return { session: next, reply: { ok: true, text: askPrayer(tt, next, `*From ${longDate(iso)}*\nWhich prayer is changing?`) } };
  }

  if (s.step === 'prayer') {
    if (SAVE_WORDS.has(word)) {
      if (!chosenCount(s)) {
        return { session: s, reply: { ok: true, text: askPrayer(tt, s, 'Nothing has been set yet, so there is nothing to save.') } };
      }
      const entry: IqamahScheduleEntry = { from: s.date!, ...s.times, ...(s.jumuah?.length ? { jumuah: s.jumuah } : {}) };
      return { session: null, reply: { ok: true, text: '' }, commit: entry };
    }
    const n = /^\d{1,2}$/.test(word) ? Number(word) : 0;
    const picked = WIZARD_PRAYERS[n - 1];
    if (!picked) {
      return { session: s, reply: { ok: true, text: askPrayer(tt, s, "That isn't one of the numbers.") } };
    }
    const next: WizardSession = { ...s, step: 'time', awaiting: picked.key };
    return {
      session: next,
      reply: {
        ok: true,
        text: [
          `*${picked.label}* — what time?`,
          picked.key === 'jumuah'
            ? "Include *am* or *pm* — e.g. *1:30 pm*, or *1:30 pm, 2:30 pm* for two jamā'ahs."
            : 'Include *am* or *pm* — e.g. *5:45 am* or *5:45 pm*. 24-hour time works too (*17:15*).',
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
    const times = parseWizardTimes(text);
    if (!times) {
        return {
        session: s,
        reply: {
          ok: true,
          text: "I need to know am or pm. Send *1:30 pm*, or *1:30 pm, 2:30 pm* for two jamā'ahs.",
        },
      };
    }
    const next: WizardSession = { ...s, step: 'prayer', awaiting: undefined, jumuah: times };
    const set = times.map((t) => show(tt, t)).join(', ');
    return { session: next, reply: { ok: true, text: askPrayer(tt, next, `Jumu'ah set to *${set}*.`) } };
  }
  const t = parseWizardTime(text);
  if (!t) {
    return {
      session: s,
      reply: { ok: true, text: 'I need to know am or pm. Send *5:45 am* or *5:45 pm* — or 24-hour time like *17:15*.' },
    };
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

/** The platform's token charset. Ours are minted, not parsed, but an invalid one would be
 *  dropped silently and the flow would restart on every answer — so it is asserted. */
const TOKEN_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Sessions are cheap and short-lived; this only bounds a pathological case. */
const MAX_SESSIONS = 32;

/**
 * A call with NO token is always a fresh start, never a continuation.
 *
 * There is no way to tell an older platform's `!display 1 <answer>` from a second admin
 * beginning their own change — both arrive tokenless — and picking wrong means one person's
 * answers landing in someone else's draft. Commands only exist from OpenMasjidOS 0.51, and
 * follow-ups arrived in 0.51.0-dev.11, so the platforms that would need the other reading are
 * a handful of prerelease builds. On those the wizard restarts on each answer, which is
 * visibly broken rather than quietly wrong, and the fix is updating the platform.
 */

export interface CommandResult extends WizardReply {
  /** Present while the wizard wants another answer. Handing this back is what makes the
   *  sender's next plain message come to us, instead of them typing `!display 1` again. */
  followUpToken?: string;
}

/**
 * The whole command, from the platform's payload to the text an admin reads.
 *
 * ## The token is what gives us a sender
 *
 * The request body still carries no phone number, but the platform binds a follow-up token to
 * exactly one sender and hands it back on their next message. So keying sessions by token is
 * keying them by person — two admins mid-flow no longer collide, which the first version of
 * this could not avoid.
 *
 * ## The exchange can end without us
 *
 * Three minutes idle, fifteen total, twelve turns, an exit word, or the sender starting any
 * other `!` command — and we are simply never called again, with no notification. That is why
 * nothing is applied until `save`: an abandoned flow leaves a draft that expires, never a
 * half-written change. The sweep here is ours; the platform's timers are its own.
 */
export class IqamahCommand {
  private readonly sessions = new Map<string, WizardSession>();

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {}

  run(text: string, followUpToken?: string): CommandResult {
    const nowMs = this.now();
    this.sweep(nowMs);
    const presented = followUpToken && TOKEN_RE.test(followUpToken) ? followUpToken : '';
    // An unknown token is treated as no token: the exchange it belonged to is gone (expired,
    // or ended by the platform without telling us), so the sender starts again rather than
    // answering into nothing.
    const draft = presented ? (this.sessions.get(presented) ?? null) : null;

    // A draft stays with the timetable it was started against. `commandTimetable` reads a
    // SETTING, and an admin editing that setting mid-conversation would otherwise redirect an
    // in-flight change onto a different timetable than the one named in the first reply.
    const tt = draft?.timetableId
      ? (this.store.db.timetables.find((t) => t.id === draft.timetableId) ?? null)
      : commandTimetable(this.store.db);
    // Terminal failures, and they must be ok:false — there is nothing to answer.
    if (!tt) return { ok: false, text: 'There is no timetable to add a change to yet.' };
    if (tt.latitude == null || tt.longitude == null) {
      return { ok: false, text: 'Add the masjid location to the timetable in the panel first.' };
    }

    const out = stepWizard(draft, text ?? '', tt, nowMs, timetableToday(tt, nowMs));

    if (!out.session && presented) this.sessions.delete(presented);

    if (out.commit) {
      const entry = out.commit;
      let saved: IqamahScheduleEntry | undefined;
      this.store.update((db) => {
        const idx = db.timetables.findIndex((t) => t.id === tt.id);
        if (idx < 0) return;
        const rows = mergeScheduleEntry(db.timetables[idx].iqamahSchedule, entry);
        db.timetables[idx].iqamahSchedule = rows;
        saved = rows.find((r) => r.from === entry.from);
      });
      // normalizeIqamahSchedule caps the list, so on a timetable already at the maximum the
      // appended entry is dropped. Telling someone their prayer times are saved when they are
      // not is the worst answer available.
      if (!saved) {
        return {
          ok: false,
          text: 'That timetable already holds the maximum number of scheduled changes, so this one was not added. Remove an old one in the control panel first.',
        };
      }
      // Report the MERGED row, not just the fields typed now: adding a time to a date that
      // already had one would otherwise read back as though the earlier times had gone.
      return { ok: true, text: savedText(tt, saved) };
    }

    if (!out.session) return out.reply;

    // Still going: reuse the sender's own token, or mint one to bind this exchange to them.
    const token = presented || this.mint();
    this.sessions.set(token, { ...out.session, timetableId: tt.id });
    return { ...out.reply, followUpToken: token };
  }

  private mint(): string {
    // base64url is inside the platform's charset, and a random token means one sender's
    // answers can never land on another's draft.
    return `iq.${crypto.randomBytes(12).toString('base64url')}`;
  }

  private sweep(nowMs: number): void {
    for (const [k, s] of this.sessions) if (nowMs - s.touchedAt > SESSION_TTL_MS) this.sessions.delete(k);
    if (this.sessions.size <= MAX_SESSIONS) return;
    const oldest = [...this.sessions.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    for (const [k] of oldest.slice(0, this.sessions.size - MAX_SESSIONS)) this.sessions.delete(k);
  }

  /** Test seam / teardown. */
  reset(): void {
    this.sessions.clear();
  }
}
