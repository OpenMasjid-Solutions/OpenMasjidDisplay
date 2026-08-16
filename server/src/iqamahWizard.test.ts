// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Adding a scheduled Iqāmah change from WhatsApp.
 *
 * This is the first thing in the app that WRITES prayer times without a screen in front of
 * the person doing it. Three of these tests exist because of that, not for coverage:
 *
 *  - **An ambiguous date is refused, not guessed.** `1/9/2026` is 9 January to an American
 *    and 1 September to everyone else, and the cost of guessing is a masjid praying at the
 *    wrong time on a day nobody thought to check.
 *  - **A bare time is resolved against its prayer** — "5:45" is morning for Fajr and evening
 *    for Asr — and the resolved value is echoed before anything is written.
 *  - **Saving MERGES.** `normalizeIqamahSchedule` keeps one entry per date and the first
 *    wins, so appending a second entry for an existing date would be dropped on the floor
 *    while the admin was told it saved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normTimetable } from './validate';
import { normalizeIqamahSchedule } from './iqamahSchedule';
import {
  stepWizard,
  parseWizardDate,
  parseWizardTime,
  parseWizardTimes,
  mergeScheduleEntry,
  savedText,
  timetableToday,
  SESSION_TTL_MS,
  type WizardSession,
} from './iqamahWizard';
import type { IqamahScheduleEntry, Timetable } from './types';

const NOW = new Date('2026-08-15T15:00:00Z').getTime();
const TODAY = '2026-08-15';

function tt(over: Record<string, unknown> = {}): Timetable {
  return normTimetable({
    name: 'Main hall',
    masjidName: 'Madani Academy Masjid',
    latitude: 40.2415,
    longitude: -75.2838,
    method: 'ISNA',
    asrMadhab: 'Hanafi',
    timezone: 'America/New_York',
    timeFormat: '12h',
    ...over,
  });
}

/** Drive the wizard the way an admin does: one message at a time. */
function run(inputs: string[], t = tt()) {
  let s: WizardSession | null = null;
  const replies: string[] = [];
  let commit: IqamahScheduleEntry | undefined;
  for (const i of inputs) {
    const out = stepWizard(s, i, t, NOW, TODAY);
    s = out.session;
    replies.push(out.reply.text);
    if (out.commit) commit = out.commit;
  }
  return { session: s, replies, last: replies[replies.length - 1], commit };
}

// ── the whole flow ───────────────────────────────────────────────────────────

test('the flow an admin actually types: start, date, prayer, time, save', () => {
  const r = run(['', '2026-09-01', '1', '5:45', 'save']);

  assert.match(r.replies[0], /What date does it start\?/);
  assert.match(r.replies[0], /exit/, 'the way out is offered at the first step');

  assert.match(r.replies[1], /From Tuesday, September 1, 2026/);
  assert.match(r.replies[1], /1 {2}Fajr/, 'the prayers are numbered');
  assert.match(r.replies[1], /5 {2}Jumu'ah/);
  assert.ok(!/Maghrib/.test(r.replies[1]), 'Maghrib is never schedulable, so it is not offered');

  assert.match(r.replies[2], /\*Fajr\* — what time\?/);
  // The resolved time is echoed BEFORE the save, which is what makes inferring am/pm safe.
  assert.match(r.replies[3], /Fajr set to \*5:45 AM\*/);
  assert.match(r.replies[3], /1 {2}Fajr — 5:45 AM/, 'the menu carries what has been set so far');

  assert.deepEqual(r.commit, { from: '2026-09-01', fajr: '05:45' });
  assert.equal(r.session, null, 'the session ends on save');
});

test('several prayers in one change', () => {
  const r = run(['', '1 Sep 2026', '1', '5:45', '3', '5:15', '5', '1:30, 2:30', 'save']);
  assert.deepEqual(r.commit, { from: '2026-09-01', fajr: '05:45', asr: '17:15', jumuah: ['13:30', '14:30'] });
});

test('the date can be typed on the same line as the command', () => {
  // "!display 1 2026-09-01" — the platform passes the argument straight through.
  const r = run(['2026-09-01']);
  assert.match(r.last, /From Tuesday, September 1, 2026/);
});

test('exit stops at any point and writes nothing', () => {
  for (const at of [1, 2, 3, 4]) {
    const inputs = ['', '2026-09-01', '1', '5:45'].slice(0, at).concat('exit');
    const r = run(inputs);
    assert.equal(r.session, null);
    assert.equal(r.commit, undefined);
    assert.match(r.last, /Nothing was changed/);
  }
});

test('back returns to the prayer list without setting a time', () => {
  const r = run(['', '2026-09-01', '1', 'back']);
  assert.match(r.last, /Which prayer is changing\?/);
  assert.ok(!/Fajr — /.test(r.last), 'nothing was set');
});

test('save with nothing chosen refuses rather than writing an empty change', () => {
  const r = run(['', '2026-09-01', 'save']);
  assert.equal(r.commit, undefined);
  assert.match(r.last, /nothing to save/i);
});

test('a stale session does not absorb an answer meant to start a new change', () => {
  const started = stepWizard(null, '', tt(), NOW, TODAY);
  const later = stepWizard(started.session, '2026-09-01', tt(), NOW + SESSION_TTL_MS + 1000, TODAY);
  // It starts over rather than treating the date as an answer to a question asked an hour ago.
  assert.match(later.reply.text, /From Tuesday, September 1, 2026/);
  assert.equal(later.session?.step, 'prayer');
});

// ── dates ────────────────────────────────────────────────────────────────────

test('unambiguous date forms are accepted', () => {
  assert.equal(parseWizardDate('2026-09-01'), '2026-09-01');
  assert.equal(parseWizardDate('2026-9-1'), '2026-09-01');
  assert.equal(parseWizardDate('1 Sep 2026'), '2026-09-01');
  assert.equal(parseWizardDate('1 September 2026'), '2026-09-01');
  assert.equal(parseWizardDate('Sep 1 2026'), '2026-09-01');
  assert.equal(parseWizardDate('September 1, 2026'), '2026-09-01');
});

test('a slash date is REFUSED, because it means two different days', () => {
  // The whole point: 1/9/2026 is 9 January in the US and 1 September elsewhere. Guessing puts
  // a masjid at the wrong time on a day nobody checked.
  for (const bad of ['1/9/2026', '01/09/2026', '9-1-2026', '1.9.2026']) {
    assert.equal(parseWizardDate(bad), null, bad);
  }
  const r = run(['', '1/9/2026']);
  assert.match(r.last, /two different days/);
  assert.match(r.last, /month in words/);
});

test('impossible dates are refused', () => {
  assert.equal(parseWizardDate('2026-02-31'), null);
  assert.equal(parseWizardDate('29 Feb 2026'), null, '2026 is not a leap year');
  assert.equal(parseWizardDate('29 Feb 2028'), '2028-02-29', 'but 2028 is');
  assert.equal(parseWizardDate('2026-13-01'), null);
});

test('a date in the past is refused', () => {
  const r = run(['', '2026-08-14']);
  assert.match(r.last, /already passed/);
  assert.equal(r.session?.step, 'date', 'and it keeps asking');
});

test('today is allowed — a change starting today is the whole last-minute case', () => {
  const r = run(['', TODAY]);
  assert.match(r.last, /Which prayer is changing\?/);
});

// ── times ────────────────────────────────────────────────────────────────────

test('a bare time is resolved against the prayer it belongs to', () => {
  assert.equal(parseWizardTime('fajr', '5:45'), '05:45');
  assert.equal(parseWizardTime('asr', '5:15'), '17:15');
  assert.equal(parseWizardTime('isha', '8:00'), '20:00');
  assert.equal(parseWizardTime('dhuhr', '1:15'), '13:15');
  assert.equal(parseWizardTime('jumuah', '1:30'), '13:30');
});

test('an explicit am/pm always wins over the inference', () => {
  assert.equal(parseWizardTime('asr', '5:15 am'), '05:15');
  assert.equal(parseWizardTime('fajr', '5:45 pm'), '17:45');
  assert.equal(parseWizardTime('isha', '12:15 am'), '00:15');
  assert.equal(parseWizardTime('dhuhr', '12:15 pm'), '12:15');
});

test('24-hour times are taken as written', () => {
  assert.equal(parseWizardTime('asr', '17:15'), '17:15');
  assert.equal(parseWizardTime('fajr', '05:45'), '05:45');
  assert.equal(parseWizardTime('isha', '20:00'), '20:00');
});

test('nonsense times are refused', () => {
  for (const bad of ['545', 'half five', '5:75', '25:00', '13:00 pm', '', 'pm']) {
    assert.equal(parseWizardTime('asr', bad), null, bad);
  }
});

test("Jumu'ah takes several jamaahs, de-duped and ordered", () => {
  assert.deepEqual(parseWizardTimes('jumuah', '1:30, 2:30'), ['13:30', '14:30']);
  assert.deepEqual(parseWizardTimes('jumuah', '2:30 and 1:30'), ['13:30', '14:30']);
  assert.deepEqual(parseWizardTimes('jumuah', '1:30; 1:30'), ['13:30']);
  assert.equal(parseWizardTimes('jumuah', '1:30, nope'), null);
});

test('the echo uses the masjid’s own time format', () => {
  const r24 = run(['', '2026-09-01', '3', '5:15'], tt({ timeFormat: '24h' }));
  assert.match(r24.last, /Asr set to \*17:15\*/);
  const r12 = run(['', '2026-09-01', '3', '5:15']);
  assert.match(r12.last, /Asr set to \*5:15 PM\*/);
});

// ── saving ───────────────────────────────────────────────────────────────────

test('saving MERGES into an existing entry for the same date', () => {
  // normalizeIqamahSchedule keeps one entry per date, first wins — appending would be
  // silently dropped while the admin was told it saved.
  const existing = normalizeIqamahSchedule([{ from: '2026-09-01', fajr: '05:30', isha: '21:00' }]);
  const merged = mergeScheduleEntry(existing, { from: '2026-09-01', asr: '17:15' });
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], { from: '2026-09-01', fajr: '05:30', asr: '17:15', isha: '21:00' });
});

test('a new time for a prayer already scheduled on that date replaces it', () => {
  const existing = normalizeIqamahSchedule([{ from: '2026-09-01', fajr: '05:30' }]);
  const merged = mergeScheduleEntry(existing, { from: '2026-09-01', fajr: '05:45' });
  assert.equal(merged[0].fajr, '05:45');
});

test('a different date is a separate entry, kept in order', () => {
  const existing = normalizeIqamahSchedule([{ from: '2026-10-01', fajr: '06:00' }]);
  const merged = mergeScheduleEntry(existing, { from: '2026-09-01', fajr: '05:45' });
  assert.deepEqual(merged.map((r) => r.from), ['2026-09-01', '2026-10-01']);
});

test('the saved message restates the whole change in the masjid’s format', () => {
  const text = savedText(tt(), { from: '2026-09-01', fajr: '05:45', jumuah: ['13:30', '14:30'] });
  assert.match(text, /From Tuesday, September 1, 2026/);
  assert.match(text, /Fajr — 5:45 AM/);
  assert.match(text, /Jumu'ah — 1:30 PM, 2:30 PM/);
});

test('"today" is the masjid’s today, not the server’s', () => {
  // 2026-08-16T02:00Z is still the 15th in New York, and a change "from today" must mean the
  // masjid's day or an admin in the small hours is refused their own date.
  const at = new Date('2026-08-16T02:00:00Z').getTime();
  assert.equal(timetableToday(tt(), at), '2026-08-15');
  assert.equal(timetableToday(tt({ timezone: 'Asia/Karachi' }), at), '2026-08-16');
});
