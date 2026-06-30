// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIqamahCsv } from './iqamahCsv';

test('parses plain MM-DD rows', () => {
  const r = parseIqamahCsv('date,fajr,dhuhr,asr,maghrib,isha\n01-01,06:00,13:30,16:00,18:00,19:30');
  assert.equal(r.errors.length, 0);
  assert.equal(r.rows, 1);
  assert.deepEqual(r.data['01-01'], { fajr: '06:00', dhuhr: '13:30', asr: '16:00', maghrib: '18:00', isha: '19:30' });
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

test('reports a friendly error for an unreadable date and skips the row', () => {
  const r = parseIqamahCsv('date,fajr\nnope,06:00\n01-01,06:00');
  assert.equal(r.rows, 1);
  assert.ok(r.errors.some((e) => e.includes('nope')));
});
