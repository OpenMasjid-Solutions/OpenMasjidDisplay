// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normTimetable } from './validate';

test('adhan delay offsets: clamped to 0–60, zeros omitted', () => {
  const tt = normTimetable({ adhanOffsets: { fajr: 5, dhuhr: 200, asr: 0, maghrib: -10 } });
  assert.equal(tt.adhanOffsets?.fajr, 5); // in range
  assert.equal(tt.adhanOffsets?.dhuhr, 60); // clamped to max
  assert.equal(tt.adhanOffsets?.asr, undefined); // zero omitted
  assert.equal(tt.adhanOffsets?.maghrib, undefined); // negative → 0 → omitted
});

test('adhan pop-up: seconds clamped to 3–120', () => {
  assert.equal(normTimetable({ adhanPopup: { enabled: true, seconds: 500 } }).adhanPopup?.seconds, 120);
  assert.equal(normTimetable({ adhanPopup: { enabled: true, seconds: 1 } }).adhanPopup?.seconds, 3);
  const off = normTimetable({ adhanPopup: { enabled: false, seconds: 15 } }).adhanPopup;
  assert.equal(off?.enabled, false);
  assert.equal(off?.seconds, 15);
});
