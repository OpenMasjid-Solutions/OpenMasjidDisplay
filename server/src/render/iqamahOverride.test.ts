// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import assert from 'node:assert';
import test from 'node:test';
import { normTimetable } from '../validate';
import { normalizeIqamahYear } from '../iqamahCsv';
import { widgetData, widgetPayload, renderDisplaySvg } from './svg';
import { localParts, zonedNoon, dayOfWeek } from '../prayer/engine';

function ttFor(tz: string | undefined) {
  return normTimetable({
    masjidName: 'Test',
    latitude: 40.7128,
    longitude: -74.006,
    method: 'ISNA',
    asrMadhab: 'Standard',
    timezone: tz,
    timeFormat: '24h',
  });
}
function mmdd(now: Date, tz: string | undefined) {
  const p = localParts(now, tz);
  return `${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
const fajrOf = (tt: ReturnType<typeof normTimetable>, now: Date) =>
  widgetData(tt, now).rows.find((r) => r.key === 'fajr')?.iqamah;

test('per-day Iqamah override applies on the day (the core feature must not regress)', () => {
  const tz = 'America/New_York';
  const now = new Date('2026-07-16T17:00:00Z');
  const tt = ttFor(tz);
  const rule = fajrOf(ttFor(tz), now);
  tt.iqamahYear = normalizeIqamahYear({ [mmdd(now, tz)]: { fajr: '05:00' } });
  assert.equal(fajrOf(tt, now), '05:00');
  assert.notEqual(fajrOf(tt, now), rule);
  // …and it reaches the actual TV SVG, not just the widget model.
  assert.ok(renderDisplaySvg(tt, now, {}).includes('05:00'));
});

test('override applies even in far-east timezones (UTC+13/+14)', () => {
  for (const tz of ['Pacific/Auckland', 'Pacific/Kiritimati']) {
    const now = new Date('2026-07-16T00:30:00Z'); // afternoon in the far east
    const tt = ttFor(tz);
    tt.iqamahYear = normalizeIqamahYear({ [mmdd(now, tz)]: { fajr: '05:00' } });
    assert.equal(fajrOf(tt, now), '05:00', `override missed in ${tz}`);
  }
});

test('zonedNoon lands on the intended calendar date in every timezone', () => {
  for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Auckland', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    const p = localParts(zonedNoon(2026, 7, 16, tz), tz);
    assert.equal(`${p.month}-${p.day}`, '7-16', `zonedNoon off in ${tz}`);
    assert.ok(p.hour >= 10 && p.hour <= 14, `not near noon in ${tz}: ${p.hour}`);
  }
});

test('widget focus card applies a future-dated override for its date (all zones)', () => {
  for (const tz of ['America/New_York', 'Pacific/Auckland']) {
    const now = new Date('2026-07-13T17:00:00Z');
    const tt = ttFor(tz);
    tt.iqamahYear = normalizeIqamahYear({ '07-16': { fajr: '05:00' } });
    const wp = widgetPayload(tt, now, { date: '2026-07-16' });
    assert.equal(wp.focus.iso, '2026-07-16', `focus.iso off in ${tz}: ${wp.focus.iso}`);
    const f = wp.focus.rows.find((r) => r.key === 'fajr')?.iqamah;
    assert.equal(f, '05:00', `widget focus override missed in ${tz}: ${f}`);
  }
});

test('dayOfWeek falls back to the host zone on an invalid IANA timezone (no crash)', () => {
  assert.doesNotThrow(() => dayOfWeek(new Date('2026-07-16T12:00:00Z'), 'Not/AZone'));
  // A whole render with a broken stored timezone must not throw.
  const tt = ttFor('Not/AZone');
  assert.doesNotThrow(() => renderDisplaySvg(tt, new Date('2026-07-16T12:00:00Z'), {}));
});
