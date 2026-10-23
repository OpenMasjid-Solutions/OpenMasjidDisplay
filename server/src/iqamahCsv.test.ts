// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIqamahCsv, templateCsv } from './iqamahCsv';

test('parses plain MM-DD rows and IGNORES the Maghrib column', () => {
  const r = parseIqamahCsv('date,fajr,dhuhr,asr,maghrib,isha\n01-01,06:00,13:30,16:00,18:00,19:30');
  assert.equal(r.errors.length, 0);
  assert.equal(r.rows, 1);
  // Maghrib is thrown out (always calculated sunset + its offset); everything else kept.
  assert.deepEqual(r.data['01-01'], { fajr: '06:00', dhuhr: '13:30', asr: '16:00', isha: '19:30' });
});

test('a Maghrib-only row yields nothing (its column is ignored)', () => {
  const r = parseIqamahCsv('date,maghrib\n01-01,18:00');
  assert.equal(r.rows, 0);
  assert.equal(r.data['01-01'], undefined);
});

test('accepts Excel-mangled month-name dates (the "1-Jan" bug)', () => {
  // Excel rewrites "01-01" → "1-Jan"; this used to error on every upload.
  const r = parseIqamahCsv('date,fajr\n1-Jan,06:00\n2-Feb,06:05\n15-Dec,05:40');
  assert.equal(r.errors.length, 0, r.errors.join('; '));
  assert.equal(r.rows, 3);
  assert.ok(r.data['01-01'] && r.data['02-02'] && r.data['12-15']);
});

test('accepts Mon-D, full month names, and trailing years', () => {
  const r = parseIqamahCsv('date,fajr\nJan-1,06:00\n"January 2",06:01\n01-Mar-2024,05:55');
  assert.equal(r.errors.length, 0, r.errors.join('; '));
  assert.deepEqual(Object.keys(r.data).sort(), ['01-01', '01-02', '03-01']);
});

test('accepts YYYY-MM-DD and M/D', () => {
  const r = parseIqamahCsv('date,fajr\n2024-03-15,05:30\n3/16,05:29');
  assert.equal(r.errors.length, 0, r.errors.join('; '));
  assert.ok(r.data['03-15'] && r.data['03-16']);
});

test('parses 12-hour am/pm times', () => {
  const r = parseIqamahCsv('date,fajr,isha\n01-01,6:00 am,7:30 pm');
  assert.equal(r.data['01-01'].fajr, '06:00');
  assert.equal(r.data['01-01'].isha, '19:30');
});

test('one unreadable date and nothing is imported — it says which, and why', () => {
  const r = parseIqamahCsv('date,fajr\nnope,06:00\n01-01,06:00');
  assert.equal(r.rows, 0, 'the readable row is not kept either');
  assert.ok(r.errors[0].includes('nope') && r.errors[0].includes('Nothing was imported'));
});

test('a day-first file is refused rather than stored at the wrong dates', () => {
  // 03/08 would be read as the 8th of March; 13/03 gives the file away.
  const r = parseIqamahCsv('date,fajr\n03/08/2026,05:30\n13/03/2026,05:31');
  assert.equal(r.rows, 0);
  assert.deepEqual(r.data, {}, 'not even the row that happened to parse');
});

// ── the template ─────────────────────────────────────────────────────────────

test('the template is what the screen shows from the rules, on every day of this year', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildModel, findIqamahChange, fmtShort } = require('./render/svg') as typeof import('./render/svg');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { zonedNoon, localParts } = require('./prayer/engine') as typeof import('./prayer/engine');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { normTimetable } = require('./validate') as typeof import('./validate');
  // New York (two daylight-saving changes), with Adhan delays, which the old template ignored.
  const tt = normTimetable({ latitude: 40.75, longitude: -73.99, timezone: 'America/New_York', timeFormat: '24h' });
  tt.adhanOffsets = { fajr: 5, dhuhr: 3, asr: 7, isha: 4 };
  const now = new Date('2026-01-15T12:00:00Z');
  const csv = templateCsv(tt, buildModel, now);
  const year = localParts(now, tt.timezone).year;
  const wrong: string[] = [];
  for (const line of csv.trim().split('\n').slice(1)) {
    const [key, fajr, dhuhr, asr, isha] = line.split(',');
    const [mo, da] = key.split('-').map(Number);
    if (mo === 2 && da === 29) continue;
    const m = buildModel(tt, zonedNoon(year, mo, da, tt.timezone));
    const want = (k: string) => fmtShort(m.rows.find((r) => r.key === k)?.iqamah ?? null, '24h');
    for (const [k, got] of [['fajr', fajr], ['dhuhr', dhuhr], ['asr', asr], ['isha', isha]] as const) {
      if (got !== want(k)) wrong.push(`${key} ${k}: template ${got}, screen ${want(k)}`);
    }
  }
  assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} template times disagree with the screen`);

  // Uploaded unchanged, it is the rules again — so nothing is announced as a change all year.
  tt.iqamahYear = parseIqamahCsv(csv).data;
  assert.equal(findIqamahChange(tt, now, { minDays: 1, maxDays: 360 }), null, 'an unedited template announced a change');
});
