// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import assert from 'node:assert';
import test from 'node:test';
import { resolveSchedule, normalizeIqamahSchedule } from './iqamahSchedule';

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
  assert.equal(out[1].maghrib as unknown, undefined); // Maghrib is never scheduled
});

test('normalizeIqamahSchedule: non-array / junk → empty', () => {
  assert.deepEqual(normalizeIqamahSchedule(null), []);
  assert.deepEqual(normalizeIqamahSchedule('x'), []);
  assert.deepEqual(normalizeIqamahSchedule([1, 'a', null]), []);
});
