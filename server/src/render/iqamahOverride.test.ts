// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import assert from 'node:assert';
import test from 'node:test';
import { normTimetable } from '../validate';
import { normalizeIqamahYear } from '../iqamahCsv';
import { normalizeIqamahSchedule } from '../iqamahSchedule';
import { widgetData, widgetPayload, renderDisplaySvg, buildModel, upcomingIqamahChange } from './svg';
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

// ── Scheduled "from this date onward" Iqamah changes (render) ─────────────────
test('scheduled change applies from its date and holds afterward', () => {
  const tz = 'America/New_York';
  const tt = ttFor(tz);
  tt.iqamahSchedule = normalizeIqamahSchedule([{ from: '2026-06-15', fajr: '05:00' }]);
  // Day before the schedule → rule (not 05:00).
  assert.notEqual(fajrOf(tt, new Date('2026-06-14T16:00:00Z')), '05:00');
  // On the date and long after → the scheduled time holds.
  assert.equal(fajrOf(tt, new Date('2026-06-15T16:00:00Z')), '05:00');
  assert.equal(fajrOf(tt, new Date('2026-09-20T16:00:00Z')), '05:00');
});

test('a per-day CSV entry wins over a scheduled change on that exact day', () => {
  const tz = 'America/New_York';
  const tt = ttFor(tz);
  tt.iqamahSchedule = normalizeIqamahSchedule([{ from: '2026-06-01', fajr: '05:00' }]);
  tt.iqamahYear = normalizeIqamahYear({ '06-20': { fajr: '04:45' } });
  assert.equal(fajrOf(tt, new Date('2026-06-19T16:00:00Z')), '05:00'); // schedule
  assert.equal(fajrOf(tt, new Date('2026-06-20T16:00:00Z')), '04:45'); // CSV wins that day
  assert.equal(fajrOf(tt, new Date('2026-06-21T16:00:00Z')), '05:00'); // back to schedule
});

test('a scheduled Jumu\'ah change replaces the Friday times from its date', () => {
  const tz = 'America/New_York';
  const tt = ttFor(tz);
  tt.jumuah = ['13:30'];
  tt.iqamahSchedule = normalizeIqamahSchedule([{ from: '2026-07-10', jumuah: ['13:00', '14:00'] }]);
  // Friday 2026-07-17 is after the change → two Jumu'ah rows at the new times.
  const m = buildModel(tt, new Date('2026-07-17T18:30:00Z')); // ~2:30pm EDT, after both jumuah
  assert.deepEqual(m.jumuah.map((h) => Math.round(h * 60)), [13 * 60, 14 * 60]);
});

test('the reminder announces an upcoming SCHEDULED change', () => {
  const tz = 'America/New_York';
  const tt = ttFor(tz);
  tt.iqamahSchedule = normalizeIqamahSchedule([{ from: '2026-06-15', fajr: '05:00' }]);
  // 4 days before, within a 10-day window → a "will be at" sentence naming Fajr.
  const msg = upcomingIqamahChange(tt, new Date('2026-06-11T16:00:00Z'), 10);
  assert.ok(msg && /will be at/i.test(msg) && /Fajr/i.test(msg), `got: ${msg}`);
  // Far outside the window → nothing.
  assert.equal(upcomingIqamahChange(tt, new Date('2026-05-01T16:00:00Z'), 10), null);
});

// ── Friday countdown ring: Adhan (as "Jumu'ah") → 1st Jumu'ah → 2nd → Asr ────
function friTT() {
  const tt = ttFor('America/New_York'); // Fri 2026-07-17: Dhuhr adhan ~13:02, Asr ~17:00
  tt.jumuah = ['13:30', '14:30'];
  return tt;
}
const friAt = (hhmmZ: string) => new Date(`2026-07-17T${hhmmZ}:00Z`);

test('Friday phase 1: before the Dhuhr adhan, ring counts to the ADHAN labeled Jumu\'ah (never Dhuhr)', () => {
  const m = buildModel(friTT(), friAt('15:00')); // 11:00 EDT, before Dhuhr adhan
  assert.ok(m.nextJumuah, 'expected a Jumu\'ah countdown');
  assert.equal(m.nextJumuah!.adhan, true);
  assert.equal(Math.round(m.nextHours * 60), 13 * 60 + 2); // counts to the Dhuhr adhan (~13:02)
  // The ring renders from nextJumuah, so no daily row (incl. Dhuhr) is the "next" highlight.
  assert.ok(!m.rows.some((r) => r.next)); // Dhuhr is never shown as the ring's next prayer
});

test('Friday phase 2/3: after the adhan, ring counts to 1st then 2nd Jumu\'ah', () => {
  const m2 = buildModel(friTT(), friAt('17:10')); // 13:10 EDT: after adhan, before 1st Jumu'ah 13:30
  assert.equal(m2.nextJumuah!.adhan, false);
  assert.equal(m2.nextJumuah!.ordinal, 1);
  assert.equal(Math.round(m2.nextHours * 60), 13 * 60 + 30);

  const m3 = buildModel(friTT(), friAt('17:45')); // 13:45 EDT: after 1st, before 2nd Jumu'ah 14:30
  assert.equal(m3.nextJumuah!.adhan, false);
  assert.equal(m3.nextJumuah!.ordinal, 2);
  assert.equal(Math.round(m3.nextHours * 60), 14 * 60 + 30);
});

test('Friday phase 4: after the last Jumu\'ah, ring moves on to Asr (never Dhuhr)', () => {
  const m = buildModel(friTT(), friAt('19:00')); // 15:00 EDT: after both Jumu\'ahs, before Asr ~17:00
  assert.equal(m.nextJumuah, null);
  assert.equal(m.nextKey, 'asr');
});

test('Friday label rendering: ADHAN phase says "UNTIL ADHAN"; jamā\'ah phase says "UNTIL JUMU\'AH"', () => {
  const svg1 = renderDisplaySvg(friTT(), friAt('15:00'), {}); // adhan phase
  assert.ok(svg1.includes('UNTIL ADHAN'), 'adhan phase should read UNTIL ADHAN');
  const svg2 = renderDisplaySvg(friTT(), friAt('17:10'), {}); // jamā'ah phase
  assert.ok(svg2.includes("UNTIL JUMU'AH") || svg2.includes('UNTIL JUMU’AH'), 'jamā\'ah phase should read UNTIL JUMU\'AH');
});

test('non-Friday still counts to Dhuhr normally (no Jumu\'ah takeover)', () => {
  const tt = friTT();
  const m = buildModel(tt, new Date('2026-07-16T15:00:00Z')); // Thursday 11:00 EDT
  assert.equal(m.nextJumuah, null);
  assert.equal(m.nextKey, 'dhuhr');
});

test('Friday zawāl (prohibited) window keeps the Jumu\'ah label — never "Dhuhr" (regression)', () => {
  const tt = friTT();
  tt.prohibitedNotice = { enabled: true, minutes: 10, ticker: false };
  // 12:55 EDT is inside the 12:52–13:02 zawāl window before the Dhuhr adhan.
  const m = buildModel(tt, friAt('16:55'));
  assert.ok(m.nextJumuah && m.nextJumuah.adhan, 'ring stays the Jumu\'ah adhan phase during zawāl');
  const svg = renderDisplaySvg(tt, friAt('16:55'), {});
  assert.ok(!svg.includes('UNTIL DHUHR ADHAN'), 'must NOT read "UNTIL DHUHR ADHAN" on Friday');
  assert.ok(svg.includes("UNTIL JUMU'AH ADHAN") || svg.includes('UNTIL JUMU’AH ADHAN'), 'reads "UNTIL JUMU\'AH ADHAN"');
});

test('Friday: a Jumu\'ah after Asr does NOT hijack the ring (regression)', () => {
  const tt = ttFor('America/New_York');
  tt.jumuah = ['17:30']; // after Asr ~17:00, before Maghrib ~20:25 — a typo, not the jamā'ah
  const m = buildModel(tt, friAt('21:15')); // 17:15 EDT, after Asr
  assert.equal(m.nextJumuah, null);
  assert.equal(m.nextKey, 'maghrib');
});
