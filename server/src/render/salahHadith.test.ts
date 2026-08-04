// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import assert from 'node:assert';
import test from 'node:test';
import { pickSalahHadith, salahHadithView } from './svg';
import { getPalette } from './theme';
import { DEFAULT_SALAH_HADITH } from './defaultHadith';
import type { SalahHadith } from '../types';

const P = { year: 2026, month: 7, day: 17 };
const ALL_OFF = DEFAULT_SALAH_HADITH.map((d) => d.id); // disable every built-in

function sh(over: Partial<SalahHadith> = {}): SalahHadith {
  return { enabled: true, minutes: 15, items: [], ...over };
}

test('picks ONE hadith, stable for the whole salah window (deterministic per date+prayer)', () => {
  const s = sh();
  const a = pickSalahHadith(s, 'dhuhr', P);
  const b = pickSalahHadith(s, 'dhuhr', P);
  assert.ok(a, 'expected a hadith from the default library');
  assert.deepEqual(a, b); // same occurrence → same hadith (no per-frame rotation/flicker)
});

test('salah-specific ahadith win at their salah; general fills the rest', () => {
  const s = sh({
    disabledDefaults: ALL_OFF, // isolate the pool to our own items
    items: [
      { ar: 'GEN-AR', en: 'GEN-EN', cite: 'g', prayers: [] },
      { ar: 'ASR-AR', en: 'ASR-EN', cite: 'a', prayers: ['asr'] },
      { ar: 'FAJR-AR', en: 'FAJR-EN', cite: 'f', prayers: ['fajr'] },
    ],
  });
  assert.equal(pickSalahHadith(s, 'asr', P)?.en, 'ASR-EN', 'Asr draws from the Asr-specific hadith');
  assert.equal(pickSalahHadith(s, 'fajr', P)?.en, 'FAJR-EN', 'Fajr draws from the Fajr-specific hadith');
  assert.equal(pickSalahHadith(s, 'dhuhr', P)?.en, 'GEN-EN', 'Dhuhr (no specific) falls back to the general one');
  assert.equal(pickSalahHadith(s, 'isha', P)?.en, 'GEN-EN', 'Isha (no specific) falls back to the general one');
});

test('no eligible hadith → null (overlay falls through to the normal display)', () => {
  // Every built-in off, and the only item is Asr-specific → Isha has neither specific nor general.
  const s = sh({ disabledDefaults: ALL_OFF, items: [{ ar: 'A', en: 'A', cite: '', prayers: ['asr'] }] });
  assert.equal(pickSalahHadith(s, 'isha', P), null);
  assert.equal(pickSalahHadith(s, 'asr', P)?.en, 'A'); // but Asr still shows it
});

test('the pick varies across days (not always the same hadith)', () => {
  const s = sh();
  const picks = new Set<string>();
  for (let d = 1; d <= 20; d++) picks.add(pickSalahHadith(s, 'dhuhr', { year: 2026, month: 3, day: d })?.en ?? '');
  assert.ok(picks.size > 1, 'expected different ahadith on different days');
});

test('the card shows Arabic AND English at the SAME time (no alternation)', () => {
  const p = getPalette('emerald');
  const svg = salahHadithView(
    { ar: 'ARABICMARKERZZ', en: 'ENGLISHMARKERZZ', cite: 'SRCZZ' },
    { time: '1:15', period: 'PM' },
    p,
    1280,
    720,
  );
  assert.ok(svg.includes('ARABICMARKERZZ'), 'Arabic must be rendered');
  assert.ok(svg.includes('ENGLISHMARKERZZ'), 'English must be rendered at the same time');
  assert.ok(svg.includes('SRCZZ'), 'citation must be rendered');
});
