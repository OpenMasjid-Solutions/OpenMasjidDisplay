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
import { toForm, followSchedule } from './Timetables';
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

test("saving the schedule moves a fixed time that was showing the schedule's answer", () => {
  // Fajr fixed at 06:00, a change in force has it at 06:30. Edit that change to 06:45, or remove
  // it: the list has to follow, or the next "Save changes" writes 06:30 back over it.
  const tt = timetable([{ from: day(-3), fajr: '06:30' }]);
  const shown = toForm(tt, state).iqamah;
  assert.equal(shown.fajr.fixed, '06:30');
  const edited = followSchedule(shown, tt, tt.iqamahSchedule!, [{ from: day(-3), fajr: '06:45' }]);
  assert.equal(edited.fajr.fixed, '06:45', 'the change was edited');
  const removed = followSchedule(shown, tt, tt.iqamahSchedule!, []);
  assert.equal(removed.fajr.fixed, '06:00', 'the change was removed: back to the time of its own');
  const typed = followSchedule({ ...shown, fajr: { mode: 'fixed', fixed: '07:10' } }, tt, tt.iqamahSchedule!, []);
  assert.equal(typed.fajr.fixed, '07:10', 'a time the admin typed over is theirs');
});
