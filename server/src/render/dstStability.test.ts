// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A day's prayer times must not depend on WHEN in that day the screen was drawn.
 *
 * `prayerTimes` applies one fixed UTC offset to a whole day, so whichever instant `buildModel`
 * takes its offset from decides the answer — and on a DST-transition day those instants disagree.
 * Before this was fixed, America/New_York on 2026-03-08 (02:00 -> 03:00) read Fajr 04:53 /
 * Dhuhr 12:11 / Maghrib 18:00 when drawn between midnight and 02:00, and 05:53 / 13:11 / 19:00
 * from 03:30 onward. The later set is the correct one — every prayer that day falls after the
 * clock moves — so the board was exactly an hour wrong for the two hours ending at Fajr, twice a
 * year, with the countdown, the Iqamah countdown and the adhan popup all firing against it.
 *
 * The fix anchors the offset at local NOON of the day being drawn, which is what `zonedNoon`
 * exists for and what `posterModel` and the Fabric timetable feed already did — so before this
 * the wall and a musalli's phone disagreed on exactly those nights.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-dst-'));

const { normTimetable } = require('../validate') as typeof import('../validate');
const { buildModel } = require('./svg') as typeof import('./svg');
const { localParts, zonedNoon } = require('../prayer/engine') as typeof import('../prayer/engine');

function tt(timezone: string) {
  return normTimetable({
    name: 'DST',
    latitude: 40.2415,
    longitude: -75.2838,
    timezone,
    timeFormat: '24h',
  });
}

/**
 * The instant at a given local wall clock, found by search so no offset is assumed.
 *
 * The window starts a full day BEFORE midnight UTC on the date, because it has to: in UTC+13
 * (Auckland in spring) local noon on the 27th is 23:00 UTC on the 26th, so a search beginning at
 * midnight UTC finds neither that nor any earlier local hour — and a helper that silently returns
 * null there makes this whole file pass by testing nothing.
 */
function at(tz: string, y: number, mo: number, d: number, hh: number, mm: number): Date | null {
  for (let k = -24 * 60; k < 48 * 60; k++) {
    const c = new Date(Date.UTC(y, mo - 1, d, 0, 0) + k * 60_000);
    const p = localParts(c, tz);
    if (p.year === y && p.month === mo && p.day === d && p.hour === hh && p.minute === mm) return c;
  }
  return null;
}

const KEYS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const;

function dayTimes(tz: string, y: number, mo: number, d: number, hh: number, mm: number): string {
  const when = at(tz, y, mo, d, hh, mm);
  if (!when) return '(no such local time)';
  const m = buildModel(tt(tz), when);
  return KEYS.map((k) => `${k}=${m.rows.find((r) => r.key === k)?.adhan?.toFixed(4)}`).join(' ');
}

/** Every transition this app is likely to meet: north, south, and a half-hour zone. */
const TRANSITIONS: [string, number, number, number][] = [
  ['America/New_York', 2026, 3, 8],   // spring forward, 02:00 -> 03:00
  ['America/New_York', 2026, 11, 1],  // fall back, 02:00 -> 01:00
  ['Europe/London', 2026, 3, 29],
  ['Europe/London', 2026, 10, 25],
  ['Australia/Sydney', 2026, 4, 5],   // southern hemisphere, the other way round
  ['Australia/Sydney', 2026, 10, 4],
  ['Australia/Adelaide', 2026, 4, 5], // +9:30/+10:30 — a half-hour zone transitioning
  ['Pacific/Auckland', 2026, 9, 27],
];

test('a transition day reads the same whenever the screen is drawn', () => {
  for (const [tz, y, mo, d] of TRANSITIONS) {
    // Local noon is the reference: it is unambiguous on every transition day.
    const want = dayTimes(tz, y, mo, d, 12, 0);
    for (const [hh, mm] of [[0, 30], [1, 30], [3, 30], [6, 0], [12, 0], [18, 0], [23, 30]] as const) {
      const got = dayTimes(tz, y, mo, d, hh, mm);
      if (got === '(no such local time)') continue; // the hour that does not exist
      assert.equal(got, want, `${tz} ${y}-${mo}-${d} drawn at ${hh}:${mm} must match local noon`);
    }
  }
});

test('an ordinary day is unaffected', () => {
  // The fix must not have moved the times on the 363 days that were already right.
  for (const tz of ['America/New_York', 'Asia/Karachi', 'Asia/Kathmandu', 'UTC']) {
    const want = dayTimes(tz, 2026, 6, 15, 12, 0);
    for (const [hh, mm] of [[0, 30], [7, 0], [19, 45]] as const) {
      assert.equal(dayTimes(tz, 2026, 6, 15, hh, mm), want, `${tz} mid-June must be stable`);
    }
  }
});

test('tomorrow is the next CALENDAR day, not now plus 24 hours', () => {
  // A DST day is not 86,400,000 ms long. 2026-03-07 23:30 EST + 24h is 2026-03-09 00:30 EDT —
  // it SKIPS 03-08 — so the post-Isha "next prayer is tomorrow's Fajr" countdown was counting to
  // the wrong day. Pinned as the premise, then as the behaviour.
  const tz = 'America/New_York';
  const late = at(tz, 2026, 3, 7, 23, 30)!;
  assert.equal(localParts(new Date(late.getTime() + 86_400_000), tz).day, 9, 'the premise: +24h skips a day');
  const p = localParts(late, tz);
  assert.equal(localParts(zonedNoon(p.year, p.month, p.day + 1, tz), tz).day, 8, 'zonedNoon does not');

  // And buildModel must use the latter. Drawn at 23:30 on the 7th, the Fajr it counts down to is
  // the 8th's — which after the transition is an hour later than the 7th's own Fajr.
  const src = fs.readFileSync(path.join(__dirname, 'svg.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export function buildModel'));
  const fnBody = fn.slice(0, fn.indexOf(String.fromCharCode(10) + '}'));
  assert.ok(
    !fnBody.includes('now.getTime() + 86400000'),
    'buildModel must not derive tomorrow by adding 24 hours',
  );
  assert.match(fnBody, /zonedNoon\(parts\.year, parts\.month, parts\.day \+ 1, tz\)/, 'it uses the calendar');
  assert.match(fnBody, /timezoneOffsetHours\(zonedNoon\(parts\.year, parts\.month, parts\.day, tz\), tz\)/,
    "and takes the day's offset at local noon, not at the render instant");
});
