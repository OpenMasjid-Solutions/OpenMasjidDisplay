// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The "Iqamah times" table shows a fixed time as it stands TODAY.
 *
 * It used to show the time typed before any scheduled change, for ever: Fajr moved from 6:00 to
 * 6:30 on the 1st, every screen went to 6:30, and the panel still said 6:00. `toForm` is where the
 * panel decides what the table shows, so it is what is tested. The other half — reading the form
 * back without rewriting history — is `keepRuleUnderSchedule` on the server, tested there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toForm } from './Timetables';
import type { AppState, Timetable } from '../types';

/** Dates relative to the real today, so the test means the same thing whenever it runs. */
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

function timetable(schedule: Timetable['iqamahSchedule']): Timetable {
  return {
    timezone: 'UTC',
    iqamah: {
      fajr: { mode: 'fixed', fixed: '06:00' },
      dhuhr: { mode: 'fixed', fixed: '13:15' },
      asr: { mode: 'offset', offset: 10 },
      maghrib: { mode: 'offset', offset: 5 },
      isha: { mode: 'fixed', fixed: '20:30' },
    },
    iqamahSchedule: schedule,
    latitude: 40,
    longitude: -75,
  } as unknown as Timetable;
}
const state = {} as AppState;

test('a scheduled change that has taken effect is what the table shows', () => {
  const f = toForm(timetable([{ from: day(-10), fajr: '06:30', asr: '17:00' }, { from: day(-3), fajr: '06:45' }]), state);
  assert.equal(f.iqamah.fajr.fixed, '06:45', 'the latest change in force, not the first');
  assert.equal(f.iqamah.dhuhr.fixed, '13:15', 'a prayer no change has touched keeps its own time');
});

test('a change that has not happened yet is not shown', () => {
  const f = toForm(timetable([{ from: day(5), fajr: '07:00', isha: '19:45' }]), state);
  assert.equal(f.iqamah.fajr.fixed, '06:00');
  assert.equal(f.iqamah.isha.fixed, '20:30');
});

test('only fixed times: an offset rule is still an offset', () => {
  const f = toForm(timetable([{ from: day(-1), asr: '17:00' }]), state);
  assert.deepEqual(f.iqamah.asr, { mode: 'offset', offset: 10 });
});
