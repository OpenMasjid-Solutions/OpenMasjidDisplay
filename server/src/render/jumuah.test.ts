// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Friday: the jamā'ah is Jumu'ah, and everything that acts on "a congregation is about to pray"
 * has to know that.
 *
 * Three separate features asked the same wrong question. The full-screen pre-Iqāmah countdown,
 * the salah blackout and the salah hadith all searched `m.rows` — the daily TABLE, which carries
 * Dhuhr every day because a masjid still wants to see the Dhuhr time on a Friday. But on Friday
 * there is no Dhuhr *jamā'ah*, and there may be several Jumu'ah jamā'āt, which are not rows at
 * all. So on a real Friday, measured before this was fixed (Dhuhr adhan 12:57, Dhuhr Iqāmah rule
 * +10 = 13:07, Jumu'ah at 13:15 and 14:00):
 *
 *   * 12:57–13:07 the whole wall counted down to **DHUHR IQĀMAH** — a prayer nobody was about to
 *     pray — while the ring beside it correctly said Jumu'ah. The screen contradicted itself.
 *   * 13:08–13:22 it went **black** for that same phantom Dhuhr jamā'ah.
 *   * The two actual Jumu'ah jamā'āt got **nothing**: no countdown before either of them, and no
 *     blackout during either of them. The fullest the hall gets all week.
 *
 * The fix is one derived list, `Model.jamaah` — today's real jamā'āt, with Dhuhr replaced by the
 * Jumu'ah times on a Friday — and all three features read it. These tests are written against
 * both ends: the list itself, and what the rendered screen actually says, because the original
 * bug was invisible in the model (the ring was right all along) and only showed on the wall.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-jum-'));

const { normTimetable } = require('../validate') as typeof import('../validate');
const { buildModel, renderDisplaySvg, fmtShort } = require('./svg') as typeof import('./svg');
const { localParts, zonedNoon } = require('../prayer/engine') as typeof import('../prayer/engine');

const TZ = 'America/New_York';
/** 2026-09-11 is a Friday; 2026-09-10 the Thursday before it. */
const FRI = [2026, 9, 11] as const;
const THU = [2026, 9, 10] as const;

function timetable(jumuah: string[] = ['13:15', '14:00']) {
  const tt = normTimetable({
    name: 'Jumuah',
    masjidName: 'Madani Academy Masjid',
    latitude: 40.2415,
    longitude: -75.2838,
    timezone: TZ,
    timeFormat: '24h',
    jumuah,
  });
  tt.iqamahCountdown = { enabled: true, minutes: 10 };
  tt.salahBlackout = { enabled: true, minutes: 15 };
  return tt;
}

/**
 * The instant at a local wall clock. Anchored on `zonedNoon` and offset in minutes rather than
 * searched: two tests below sweep every minute of an afternoon, and a linear search per call made
 * them take 48s and 22s on their own. Valid because neither test date is a DST transition — which
 * is asserted, not assumed, so this cannot quietly skew if the dates ever move.
 */
function at(y: number, mo: number, d: number, hh: number, mm: number): Date {
  const noon = zonedNoon(y, mo, d, TZ);
  const when = new Date(noon.getTime() + (hh * 60 + mm - 12 * 60) * 60_000);
  const p = localParts(when, TZ);
  if (p.year !== y || p.month !== mo || p.day !== d || p.hour !== hh || p.minute !== mm) {
    throw new Error(`${y}-${mo}-${d} ${hh}:${mm} is not a plain local time in ${TZ} (DST?)`);
  }
  return when;
}

test('the test dates are not DST transitions, so the helper above is sound', () => {
  for (const [y, mo, d] of [FRI, THU]) {
    const midnight = at(y, mo, d, 0, 0);
    const lateEve = at(y, mo, d, 23, 30);
    assert.equal(
      (lateEve.getTime() - midnight.getTime()) / 60_000,
      23 * 60 + 30,
      `${y}-${mo}-${d} must be a plain 24-hour day`,
    );
  }
});

/** A blackout is EXACTLY one black rect and no text at all. */
const isBlackout = (svg: string) => /<rect[^>]*fill="#000000"[^>]*\/>/.test(svg) && !svg.includes('<text');

/** The full-screen countdown's heading, or '' when no countdown is up. */
function heading(tt: ReturnType<typeof timetable>, when: Date): string {
  const svg = renderDisplaySvg(tt, when, {});
  if (isBlackout(svg)) return '(blackout)';
  const m = /<text[^>]*>([^<]* IN)</.exec(svg);
  return m ? m[1] : '';
}

const keysOf = (tt: ReturnType<typeof timetable>, when: Date) =>
  buildModel(tt, when).jamaah.map((j) => `${j.key}${j.ordinal ?? ''}@${fmtShort(j.at, '24h')}`);

// ── the list itself ─────────────────────────────────────────────────────────────────────

test("on Friday the jamā'ah list replaces Dhuhr with the Jumu'ah times", () => {
  const list = keysOf(timetable(), at(...FRI, 12, 0));
  assert.ok(!list.some((s) => s.startsWith('dhuhr')), 'there is no Dhuhr jamā’ah on a Friday');
  assert.deepEqual(
    list.filter((s) => s.startsWith('jumuah')),
    ['jumuah1@13:15', 'jumuah2@14:00'],
    'every configured Jumu’ah is a jamā’ah, numbered in order',
  );
  // The rest of the day is untouched, and the list is in time order.
  assert.deepEqual(
    list.map((s) => s.split('@')[0]),
    ['fajr', 'jumuah1', 'jumuah2', 'asr', 'maghrib', 'isha'],
  );
  const times = buildModel(timetable(), at(...FRI, 12, 0)).jamaah.map((j) => j.at);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'sorted by when the congregation lines up');
});

test('on any other day Dhuhr keeps its jamā’ah and no Jumu’ah appears', () => {
  const list = keysOf(timetable(), at(...THU, 12, 0));
  assert.deepEqual(
    list.map((s) => s.split('@')[0]),
    ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'],
  );
});

test('one Jumu’ah is not numbered; several are', () => {
  const one = buildModel(timetable(['13:30']), at(...FRI, 12, 0)).jamaah.filter((j) => j.key === 'jumuah');
  assert.equal(one.length, 1);
  assert.equal(one[0].ordinal, undefined, 'a single Jumu’ah needs no number');

  const many = buildModel(timetable(['12:30', '13:15', '14:00']), at(...FRI, 12, 0)).jamaah
    .filter((j) => j.key === 'jumuah');
  assert.deepEqual(many.map((j) => j.ordinal), [1, 2, 3]);
});

test('a Friday with NO Jumu’ah configured still prays Dhuhr', () => {
  // Reachable from a restored db.json whose jumuah list is empty or all unparseable. Dropping
  // Dhuhr there would leave the masjid with no midday jamā'ah at all.
  const tt = timetable();
  tt.jumuah = [];
  const list = keysOf(tt, at(...FRI, 12, 0));
  assert.ok(list.some((s) => s.startsWith('dhuhr')), 'Dhuhr is only stood down when something stands in');
  assert.ok(!list.some((s) => s.startsWith('jumuah')));
});

test('a scheduled Jumu’ah change moves the jamā’ah', () => {
  const tt = timetable(['13:15', '14:00']);
  tt.iqamahSchedule = [{ from: '2026-09-01', jumuah: ['13:45'] }];
  assert.deepEqual(
    keysOf(tt, at(...FRI, 12, 0)).filter((s) => s.startsWith('jumuah')),
    ['jumuah@13:45'],
    'the scheduled list replaces the base one, and one time is not numbered',
  );
});

test("Jumu’ah's preceding call is the DHUHR adhan", () => {
  // It is what is actually called on a Friday, and the countdown must not open before it.
  const m = buildModel(timetable(), at(...FRI, 12, 0));
  const dhuhrAdhan = m.rows.find((r) => r.key === 'dhuhr')!.adhan!;
  for (const j of m.jamaah.filter((x) => x.key === 'jumuah')) {
    assert.equal(j.adhan, dhuhrAdhan, 'every Jumu’ah is preceded by the Dhuhr adhan');
  }
});

// ── what the wall actually says ─────────────────────────────────────────────────────────

test('THE BUG: no Dhuhr countdown on a Friday, at any moment of the day', () => {
  const tt = timetable();
  // Every minute from just before the Dhuhr adhan to well past Asr — the window the old code
  // announced DHUHR IQĀMAH in was only ten minutes wide, so a sampled test could walk past it.
  for (let mins = 12 * 60 + 40; mins <= 18 * 60; mins++) {
    const h = heading(tt, at(...FRI, Math.floor(mins / 60), mins % 60));
    assert.ok(
      !/DHUHR/i.test(h),
      `at ${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')} the screen said "${h}"`,
    );
  }
});

test("the countdown runs before EVERY Jumu’ah, and says which one", () => {
  const tt = timetable(); // 13:15 and 14:00, ten-minute window
  assert.equal(heading(tt, at(...FRI, 13, 4)), '', 'more than ten minutes out: nothing');
  assert.equal(heading(tt, at(...FRI, 13, 6)), "JUMU'AH 1 IN");
  assert.equal(heading(tt, at(...FRI, 13, 14)), "JUMU'AH 1 IN");
  assert.equal(heading(tt, at(...FRI, 13, 40)), '', 'between the two: nothing');
  assert.equal(heading(tt, at(...FRI, 13, 52)), "JUMU'AH 2 IN");
  assert.equal(heading(tt, at(...FRI, 13, 59)), "JUMU'AH 2 IN");
});

test('a single Jumu’ah counts down without a number', () => {
  assert.equal(heading(timetable(['13:30']), at(...FRI, 13, 25)), "JUMU'AH IN");
});

test('the heading says JUMU’AH IN, never JUMU’AH IQĀMAH IN', () => {
  // A Jumu'ah time IS the jamā'ah — nobody in a masjid says "the Jumu'ah Iqamah". A daily
  // prayer keeps its "IQĀMAH", because there the Iqāmah is a separate moment from the Adhan.
  const h = heading(timetable(), at(...FRI, 13, 10));
  assert.match(h, /JUMU'AH/, 'there must BE a heading — an empty one would pass the next line');
  assert.ok(!/IQ/i.test(h), `expected no Iqāmah in "${h}"`);
  assert.match(heading(timetable(), at(...THU, 13, 2)), /DHUHR IQĀMAH IN/);
  assert.match(heading(timetable(), at(...FRI, 17, 30)), /ASR IQĀMAH IN/, 'Asr is unaffected on a Friday');
});

test('the countdown does not open before the adhan is called', () => {
  // A Jumu'ah close behind the adhan: the ten-minute window would otherwise start before the
  // call, telling a hall to line up for a prayer whose adhan has not sounded.
  const tt = timetable(['13:00']); // Dhuhr adhan is 12:57 on this date
  const dhuhrAdhan = buildModel(tt, at(...FRI, 12, 0)).rows.find((r) => r.key === 'dhuhr')!.adhan!;
  assert.ok(dhuhrAdhan > 12.83 && dhuhrAdhan < 13, 'premise: the adhan falls inside the window');
  assert.equal(heading(tt, at(...FRI, 12, 55)), '', 'before the adhan: nothing');
  assert.equal(heading(tt, at(...FRI, 12, 58)), "JUMU'AH IN", 'after it: counting');
});

test('the salah window belongs to Jumu’ah, and there is one per jamā’ah', () => {
  const tt = timetable(); // blackout 15 min
  assert.equal(heading(tt, at(...FRI, 13, 16)), '(blackout)', 'during the 1st Jumu’ah');
  assert.equal(heading(tt, at(...FRI, 13, 29)), '(blackout)');
  assert.equal(heading(tt, at(...FRI, 13, 31)), '', 'and it ends');
  assert.equal(heading(tt, at(...FRI, 14, 1)), '(blackout)', 'during the 2nd Jumu’ah');
  assert.equal(heading(tt, at(...FRI, 14, 14)), '(blackout)');
  assert.equal(heading(tt, at(...FRI, 14, 16)), '');
  // And never for the Dhuhr Iqāmah that is not being prayed: 13:07 + 15 min would have blacked
  // the wall out to 13:22, which is how the old code accidentally covered the 1st Jumu'ah.
  assert.equal(heading(tt, at(...FRI, 13, 8)), "JUMU'AH 1 IN", 'still counting, not blacked out');
});

test("a hadith can be targeted AT Jumu'ah, which proves the window's key", () => {
  // The text is deliberately free of curly punctuation: the renderer normalises U+2019 to a
  // straight apostrophe, so an assertion containing one never matches the SVG.
  // Prayer-specific ahadith beat the general pool (pickSalahHadith), so an item aimed at
  // `jumuah` is only reachable if the salah window really carries that key — which is the thing
  // this change introduced. A general item would have proved nothing: the built-in pool is
  // general too, and the first version of this test picked a built-in and read as a failure.
  const tt = timetable();
  tt.salahBlackout = { enabled: false, minutes: 15 };
  tt.salahHadith = {
    enabled: true,
    minutes: 15,
    items: [{ ar: 'عربي', en: 'A hadith only for Jumuah', cite: 'test:1', prayers: ['jumuah'] }],
  };
  assert.ok(
    renderDisplaySvg(tt, at(...FRI, 13, 20), {}).includes('A hadith only for Jumuah'),
    'during the 1st Jumu’ah',
  );
  assert.ok(
    renderDisplaySvg(tt, at(...FRI, 14, 5), {}).includes('A hadith only for Jumuah'),
    'and during the 2nd',
  );
  // On Thursday that same item must NOT be reachable — there is no Jumu'ah to target.
  assert.ok(!renderDisplaySvg(tt, at(...THU, 13, 20), {}).includes('A hadith only for Jumuah'));
});

test('Thursday is completely unchanged', () => {
  const tt = timetable();
  assert.equal(heading(tt, at(...THU, 13, 2)).replace(/Ā/, 'A'), 'DHUHR IQAMAH IN');
  assert.equal(heading(tt, at(...THU, 13, 20)), '(blackout)', 'and the Dhuhr salah window still runs');
  assert.equal(heading(tt, at(...THU, 13, 25)), '');
});

test('the screen never contradicts itself: the ring and the overlay name the same thing', () => {
  // This is the shape of the original bug, and the only test here that would have caught it
  // without knowing where to look: the ring said Jumu'ah while the full-screen overlay said
  // Dhuhr, on the same frame.
  const tt = timetable();
  for (let mins = 12 * 60 + 30; mins <= 15 * 60; mins++) {
    const when = at(...FRI, Math.floor(mins / 60), mins % 60);
    const m = buildModel(tt, when);
    const h = heading(tt, when);
    if (!h || h === '(blackout)') continue;
    if (m.nextJumuah) {
      assert.match(h, /JUMU'AH/, `the ring is on Jumu’ah but the overlay said "${h}"`);
    }
  }
});
