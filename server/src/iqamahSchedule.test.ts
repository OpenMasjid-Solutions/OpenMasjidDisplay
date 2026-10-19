// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import assert from 'node:assert';
import test from 'node:test';
import { resolveSchedule, normalizeIqamahSchedule, keepRuleUnderSchedule } from './iqamahSchedule';
import { normTimetable } from './validate';
import type { Timetable } from './types';

test('resolveSchedule: from-date onward, latest entry wins, holds forward', () => {
  const s = [
    { from: '2026-03-01', fajr: '05:30', dhuhr: '13:15' },
    { from: '2026-06-01', fajr: '05:00' }, // only Fajr changes here
  ];
  // Before any entry → nothing.
  assert.deepEqual(resolveSchedule(s, 2026, 2, 28), {});
  // On/after the first → its values.
  assert.deepEqual(resolveSchedule(s, 2026, 3, 1), { fajr: '05:30', dhuhr: '13:15' });
  assert.deepEqual(resolveSchedule(s, 2026, 5, 31), { fajr: '05:30', dhuhr: '13:15' });
  // After the second → Fajr updates, Dhuhr CARRIES FORWARD from the first entry.
  assert.deepEqual(resolveSchedule(s, 2026, 6, 1), { fajr: '05:00', dhuhr: '13:15' });
  assert.deepEqual(resolveSchedule(s, 2027, 1, 1), { fajr: '05:00', dhuhr: '13:15' }); // holds into next year
});

test('resolveSchedule: Jumu\'ah replaces the base times from its date', () => {
  const s = [{ from: '2026-05-01', jumuah: ['13:30', '14:30'] }];
  assert.equal(resolveSchedule(s, 2026, 4, 30).jumuah, undefined);
  assert.deepEqual(resolveSchedule(s, 2026, 5, 1).jumuah, ['13:30', '14:30']);
});

test('resolveSchedule: unsorted input + missing/invalid entries', () => {
  const s = [
    { from: '2026-06-01', asr: '17:00' },
    { from: '2026-01-01', asr: '16:00' },
  ];
  assert.equal(resolveSchedule(s, 2026, 3, 1).asr, '16:00');
  assert.equal(resolveSchedule(s, 2026, 7, 1).asr, '17:00');
  assert.deepEqual(resolveSchedule(undefined, 2026, 7, 1), {});
  assert.deepEqual(resolveSchedule([], 2026, 7, 1), {});
});

test('normalizeIqamahSchedule: cleans times/dates, sorts, dedups, drops empties', () => {
  const out = normalizeIqamahSchedule([
    { from: '2026-06-01', fajr: '5:00 am', isha: '9:15 pm' }, // 12h → 24h
    { from: '2026-03-01', dhuhr: '13:15', jumuah: ['2:30 pm', '1:30 pm', '1:30 pm'] }, // sorted+deduped
    { from: 'not-a-date', fajr: '05:00' }, // dropped (bad date)
    { from: '2026-09-01' }, // dropped (sets nothing)
    { from: '2026-03-01', asr: '16:00' }, // dropped (duplicate date of the 03-01 above)
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].from, '2026-03-01'); // sorted ascending
  assert.deepEqual(out[0].jumuah, ['13:30', '14:30']);
  assert.equal(out[0].dhuhr, '13:15');
  assert.equal(out[0].asr, undefined); // the duplicate 03-01 entry was dropped, not merged
  assert.equal(out[1].from, '2026-06-01');
  assert.equal(out[1].fajr, '05:00');
  assert.equal(out[1].isha, '21:15');
  // Maghrib is never scheduled (it follows sunset), so the normalizer must not invent the
  // key. The cast has to be on the OBJECT — `out[1].maghrib as unknown` casts the result of
  // an access that doesn't typecheck in the first place, which is why this line only
  // compiled while the test files went unchecked.
  assert.equal((out[1] as unknown as Record<string, unknown>).maghrib, undefined);
});

test('normalizeIqamahSchedule: non-array / junk → empty', () => {
  assert.deepEqual(normalizeIqamahSchedule(null), []);
  assert.deepEqual(normalizeIqamahSchedule('x'), []);
  assert.deepEqual(normalizeIqamahSchedule([1, 'a', null]), []);
});

// ── the "Iqamah times" table shows today's fixed time ───────────────────────

/**
 * The panel shows a fixed Iqamah time as it stands today, scheduled changes included, and
 * `keepRuleUnderSchedule` reads the form back against that. Base rule Fajr 06:00; a change moved
 * it to 06:30 on Oct 1, and another moves it to 07:00 on Dec 1.
 */
function stored(): Timetable {
  const t = normTimetable({ latitude: 40.2, longitude: -75.2, timezone: 'America/New_York' });
  t.iqamah = { ...t.iqamah, fajr: { mode: 'fixed', fixed: '06:00' }, isha: { mode: 'offset', offset: 10 } };
  t.iqamahSchedule = [
    { from: '2026-10-01', fajr: '06:30', isha: '20:00' },
    { from: '2026-12-01', fajr: '07:00' },
  ];
  return t;
}
const OCT19 = new Date('2026-10-19T16:00:00Z');
const form = (base: Timetable, fajr: string) => ({ ...base, iqamah: { ...base.iqamah, fajr: { mode: 'fixed', fixed: fajr } } });

test('the time the table shows today is not an edit — the stored rule keeps its own value', () => {
  const base = stored();
  const next = form(base, '06:30') as Timetable;
  keepRuleUnderSchedule(next, base, OCT19);
  assert.equal(next.iqamah.fajr.fixed, '06:00', 'the pre-change time is history, and stays');
  assert.strictEqual(next.iqamahSchedule, base.iqamahSchedule, 'nothing to change');
});

test('editing the table changes the time from now on, through the change that set it', () => {
  const base = stored();
  const next = form(base, '06:45') as Timetable;
  keepRuleUnderSchedule(next, base, OCT19);
  assert.equal(next.iqamah.fajr.fixed, '06:00');
  assert.deepEqual(next.iqamahSchedule, [
    { from: '2026-10-01', fajr: '06:45', isha: '20:00' },
    { from: '2026-12-01', fajr: '07:00' },
  ], 'the one in force today, not the coming one');
  assert.equal(base.iqamahSchedule![0].fajr, '06:30', 'the stored schedule is not mutated — the preview reads through here');
});

test('a form that never showed the scheduled time cannot undo the change', () => {
  // A panel opened before this existed sends the old rule back. Read as an edit it would write
  // 06:00 over the October change and every screen would go back a month.
  const base = stored();
  const next = form(base, '06:00') as Timetable;
  keepRuleUnderSchedule(next, base, OCT19);
  assert.strictEqual(next.iqamahSchedule, base.iqamahSchedule);
  assert.equal(next.iqamah.fajr.fixed, '06:00');
});

test('before any change is in force, the table is the rule and edits go to it', () => {
  const base = stored();
  const next = form(base, '05:50') as Timetable;
  keepRuleUnderSchedule(next, base, new Date('2026-09-20T16:00:00Z'));
  assert.equal(next.iqamah.fajr.fixed, '05:50');
  assert.strictEqual(next.iqamahSchedule, base.iqamahSchedule);
});

test('only fixed times: an offset rule is left exactly as sent', () => {
  const base = stored();
  const next = { ...base, iqamah: { ...base.iqamah, isha: { mode: 'offset', offset: 15 } } } as Timetable;
  keepRuleUnderSchedule(next, base, OCT19);
  assert.deepEqual(next.iqamah.isha, { mode: 'offset', offset: 15 });
  assert.strictEqual(next.iqamahSchedule, base.iqamahSchedule);
});

test('normTimetable reads a saved form this way', () => {
  const base = stored();
  const saved = normTimetable({ ...base, iqamah: { ...base.iqamah, fajr: { mode: 'fixed', fixed: '06:30' } } }, base);
  assert.equal(saved.iqamah.fajr.fixed, '06:00');
});
