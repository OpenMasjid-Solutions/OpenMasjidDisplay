// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prayerTimes,
  iqamahHours,
  parseHHMM,
  dayOfWeek,
  timezoneOffsetHours,
  METHODS,
} from './engine';

test('prayer times are ordered and within the day (NYC, equinox)', () => {
  // New York City, spring equinox, EST (UTC-5), MWL, Standard Asr.
  const t = prayerTimes({ year: 2024, month: 3, day: 20 }, 40.7128, -74.006, -5, 'MWL', 'Standard');
  for (const v of Object.values(t)) {
    assert.ok(v >= 0 && v < 24, `time ${v} out of range`);
  }
  assert.ok(t.fajr < t.sunrise, 'fajr before sunrise');
  assert.ok(t.sunrise < t.dhuhr, 'sunrise before dhuhr');
  assert.ok(t.dhuhr < t.asr, 'dhuhr before asr');
  assert.ok(t.asr < t.maghrib, 'asr before maghrib');
  assert.ok(t.maghrib < t.isha, 'maghrib before isha');
  // Dhuhr is solar noon-ish: roughly midday local time.
  assert.ok(t.dhuhr > 11.5 && t.dhuhr < 13.0, `dhuhr ~ noon, got ${t.dhuhr}`);
  // At the equinox in NYC sunrise/sunset are close to 06:00/18:00 local.
  assert.ok(Math.abs(t.sunrise - 6) < 0.75, `sunrise near 6, got ${t.sunrise}`);
  assert.ok(Math.abs(t.sunset - 18) < 0.75, `sunset near 18, got ${t.sunset}`);
});

test('Hanafi Asr is later than Standard Asr', () => {
  const std = prayerTimes({ year: 2024, month: 6, day: 21 }, 51.5, -0.12, 0, 'MWL', 'Standard');
  const hanafi = prayerTimes({ year: 2024, month: 6, day: 21 }, 51.5, -0.12, 0, 'MWL', 'Hanafi');
  assert.ok(hanafi.asr > std.asr, 'hanafi asr later');
});

test('Makkah method uses a fixed Isha interval after Maghrib', () => {
  const t = prayerTimes({ year: 2024, month: 1, day: 15 }, 21.42, 39.83, 3, 'Makkah', 'Standard');
  assert.ok(Math.abs(t.isha - t.maghrib - 1.5) < 0.01, 'isha = maghrib + 90min');
  assert.equal(METHODS.Makkah.ishaMinutes, 90);
});

test('iqamahHours: offset and fixed', () => {
  assert.equal(iqamahHours(5.0, { mode: 'offset', offset: 20 }), 5 + 20 / 60);
  assert.equal(iqamahHours(13.0, { mode: 'fixed', fixed: '13:30' }), 13.5);
  assert.equal(iqamahHours(13.0, { mode: 'none' }), null);
});

test('parseHHMM', () => {
  assert.equal(parseHHMM('05:30'), 5.5);
  assert.equal(parseHHMM('23:59'), 23 + 59 / 60);
  assert.equal(parseHHMM('24:00'), null);
  assert.equal(parseHHMM('nope'), null);
});

test('dayOfWeek + timezoneOffsetHours for a known instant', () => {
  // 2024-03-20T12:00:00Z — a Wednesday.
  const inst = new Date('2024-03-20T12:00:00Z');
  assert.equal(dayOfWeek(inst, 'UTC'), 3);
  assert.equal(timezoneOffsetHours(inst, 'UTC'), 0);
  // New York in March is on DST (UTC-4).
  assert.equal(timezoneOffsetHours(inst, 'America/New_York'), -4);
});
