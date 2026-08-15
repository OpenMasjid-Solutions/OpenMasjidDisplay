// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import test from 'node:test';
import assert from 'node:assert/strict';
import { normTimetable } from '../validate';
import { normalizeIqamahSchedule } from '../iqamahSchedule';
import { nextIqamahChange, upcomingIqamahChange } from './svg';
import { posterModel, renderAnnounceSvg, POSTER_W, POSTER_H } from './announce';
import { encoderArgs, encoderPixFmt } from './encoder';
import type { Timetable } from '../types';

const NOW = new Date('2026-08-15T15:00:00Z');

function ttWith(schedule: unknown[], over: Record<string, unknown> = {}): Timetable {
  const tt = normTimetable({
    masjidName: 'Madani Academy Masjid',
    location: 'Lansdale, Pennsylvania',
    latitude: 40.2415,
    longitude: -75.2838,
    method: 'ISNA',
    asrMadhab: 'Hanafi',
    timezone: 'America/New_York',
    timeFormat: '12h',
    ...over,
  });
  tt.iqamahSchedule = normalizeIqamahSchedule(schedule);
  return tt;
}

// ── The detection, now shared by the band and the poster ──────────────────────

test('nextIqamahChange reports the date, the days until, and which prayers moved', () => {
  const tt = ttWith([{ from: '2026-09-01', fajr: '05:45', asr: '17:15' }]);
  const c = nextIqamahChange(tt, NOW, 400);
  assert.ok(c, 'a change 17 days out must be found within a 400-day window');
  assert.deepEqual([c!.year, c!.month, c!.day], [2026, 9, 1]);
  assert.equal(c!.daysUntil, 17);
  assert.deepEqual(c!.changed.map((x) => x.key).sort(), ['asr', 'fajr']);
});

test('the window is respected — a change beyond it is not reported', () => {
  const tt = ttWith([{ from: '2026-09-01', fajr: '05:45' }]);
  assert.equal(nextIqamahChange(tt, NOW, 7), null, '17 days away, 7-day window');
  assert.ok(nextIqamahChange(tt, NOW, 20), '17 days away, 20-day window');
});

// The sentence and the poster must never disagree about whether there IS a change: they are
// the same masjid telling the same congregation the same thing through two channels.
test('the on-screen sentence and the structured result agree', () => {
  for (const sched of [
    [{ from: '2026-09-01', fajr: '05:45' }],
    [{ from: '2026-08-16', isha: '20:15' }],
    [],
  ]) {
    const tt = ttWith(sched);
    const structured = nextIqamahChange(tt, NOW, 60);
    const sentence = upcomingIqamahChange(tt, NOW, 60);
    assert.equal(!!structured, !!sentence, `disagreement for ${JSON.stringify(sched)}`);
  }
});

// A masjid that sets exact times for the whole year by CSV never touches the "scheduled
// changes" list, and its poster has to work all the same. This is inherited rather than
// added: the detector considers BOTH sources, and the poster reuses it. These tests exist so
// that stays true — a future "simplification" of the poster to read only iqamahSchedule
// would silently give every CSV masjid a dead button.
test('a CSV-only timetable (no schedule at all) still produces a change', () => {
  const tt = ttWith([]);
  tt.iqamahYear = { '09-01': { fajr: '05:45', asr: '17:15' } };
  const c = nextIqamahChange(tt, NOW, 400);
  assert.ok(c, 'the CSV date must be found with no iqamahSchedule present');
  assert.deepEqual([c!.month, c!.day], [9, 1]);
  assert.deepEqual(c!.changed.map((x) => x.key).sort(), ['asr', 'fajr']);
});

test('with several CSV dates ahead, the SOONEST one is announced', () => {
  const tt = ttWith([]);
  tt.iqamahYear = { '10-15': { fajr: '06:15' }, '09-01': { fajr: '05:45' } };
  const c = nextIqamahChange(tt, NOW, 400)!;
  assert.deepEqual([c.month, c.day], [9, 1], 'October must not win over September');
});

test('the poster renders from a CSV change, with the times the CSV sets', () => {
  const tt = ttWith([]);
  tt.iqamahYear = { '09-01': { fajr: '05:45', asr: '17:15' } };
  const m = posterModel(tt, nextIqamahChange(tt, NOW, 400)!);
  assert.equal(m.rows.find((r) => r.name === 'Fajr')!.iqamah, '5:45 AM');
  assert.equal(m.rows.find((r) => r.name === 'Asr')!.iqamah, '5:15 PM');
  assert.equal(m.changedCount, 2);
  assert.ok(m.rows.find((r) => r.name === 'Fajr')!.was, 'it still shows what it replaces');
});

test('when a CSV day and a scheduled change collide, the CSV wins — as it does on screen', () => {
  const tt = ttWith([{ from: '2026-09-01', fajr: '05:30' }]);
  tt.iqamahYear = { '09-01': { fajr: '05:45' } };
  const m = posterModel(tt, nextIqamahChange(tt, NOW, 400)!);
  assert.equal(m.rows.find((r) => r.name === 'Fajr')!.iqamah, '5:45 AM', 'the per-day CSV overrides the schedule');
});

// ── The poster model ──────────────────────────────────────────────────────────

test('the poster carries the whole timetable, not only the prayers that moved', () => {
  const tt = ttWith([{ from: '2026-09-01', fajr: '05:45', asr: '17:15' }]);
  const m = posterModel(tt, nextIqamahChange(tt, NOW, 400)!);
  const names = m.rows.map((r) => r.name);
  for (const p of ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']) {
    assert.ok(names.includes(p), `${p} must be on the poster — it is the whole timetable`);
  }
  // Every row has an Iqamah except Sunrise, which is not a jamā'ah.
  for (const r of m.rows) {
    if (r.minor) assert.equal(r.iqamah, '', 'Sunrise has no Iqamah');
    else assert.notEqual(r.iqamah, '', `${r.name} should show an Iqamah`);
  }
});

test('only the changed rows are marked, and they carry the time they are replacing', () => {
  const tt = ttWith([{ from: '2026-09-01', fajr: '05:45', asr: '17:15' }]);
  const m = posterModel(tt, nextIqamahChange(tt, NOW, 400)!);
  const changed = m.rows.filter((r) => r.changed).map((r) => r.name);
  assert.deepEqual(changed.sort(), ['Asr', 'Fajr']);
  assert.equal(m.changedCount, 2);
  for (const r of m.rows) {
    if (r.changed) {
      assert.ok(r.was, `${r.name} must show what it is changing FROM`);
      assert.notEqual(r.was, r.iqamah, 'a "was" identical to the new time says nothing');
    } else {
      assert.equal(r.was, null, `${r.name} did not change, so it must not show a "was"`);
    }
  }
});

test('the new Iqamah on the poster is the time the schedule actually sets', () => {
  const tt = ttWith([{ from: '2026-09-01', fajr: '05:45', asr: '17:15' }]);
  const m = posterModel(tt, nextIqamahChange(tt, NOW, 400)!);
  assert.equal(m.rows.find((r) => r.name === 'Fajr')!.iqamah, '5:45 AM');
  assert.equal(m.rows.find((r) => r.name === 'Asr')!.iqamah, '5:15 PM');
});

test('a scheduled Jumu’ah change reaches the poster', () => {
  const tt = ttWith([{ from: '2026-09-01', fajr: '05:45', jumuah: ['13:45', '14:45'] }]);
  const m = posterModel(tt, nextIqamahChange(tt, NOW, 400)!);
  assert.deepEqual(m.jumuah, ['1:45 PM', '2:45 PM']);
});

test('24-hour masjids get 24-hour times on the poster', () => {
  const tt = ttWith([{ from: '2026-09-01', isha: '20:30' }], { timeFormat: '24h' });
  const m = posterModel(tt, nextIqamahChange(tt, NOW, 400)!);
  assert.equal(m.rows.find((r) => r.name === 'Isha')!.iqamah, '20:30');
});

// ── The rendered SVG ──────────────────────────────────────────────────────────

test('the poster renders at the intended size and says the essential things', () => {
  const tt = ttWith([{ from: '2026-09-01', fajr: '05:45' }]);
  const svg = renderAnnounceSvg(tt, posterModel(tt, nextIqamahChange(tt, NOW, 400)!), null);
  assert.match(svg, new RegExp(`width="${POSTER_W}" height="${POSTER_H}"`));
  assert.ok(svg.includes('Madani Academy Masjid'), 'the masjid name');
  assert.ok(svg.includes('IQĀMAH TIME IS CHANGING'), 'singular heading for one change');
  assert.ok(svg.includes('1 September 2026'), 'the date it takes effect');
  assert.ok(svg.trim().endsWith('</svg>'), 'well-formed');
});

test('the heading is plural when more than one prayer moves', () => {
  const tt = ttWith([{ from: '2026-09-01', fajr: '05:45', asr: '17:15' }]);
  const svg = renderAnnounceSvg(tt, posterModel(tt, nextIqamahChange(tt, NOW, 400)!), null);
  assert.ok(svg.includes('IQĀMAH TIMES ARE CHANGING'));
});

test('a masjid name with markup characters cannot break the SVG', () => {
  const tt = ttWith([{ from: '2026-09-01', fajr: '05:45' }], { masjidName: 'A<b>&"\'' });
  const svg = renderAnnounceSvg(tt, posterModel(tt, nextIqamahChange(tt, NOW, 400)!), null);
  assert.ok(!svg.includes('<b>'), 'raw markup must not reach the document');
  assert.ok(svg.includes('&lt;b&gt;'), 'it should appear escaped instead');
});

test('the theme is followed — a different palette produces different colours', () => {
  const sched = [{ from: '2026-09-01', fajr: '05:45' }];
  const a = ttWith(sched, { themeId: 'emerald' });
  const b = ttWith(sched, { themeId: 'berry' });
  const svgA = renderAnnounceSvg(a, posterModel(a, nextIqamahChange(a, NOW, 400)!), null);
  const svgB = renderAnnounceSvg(b, posterModel(b, nextIqamahChange(b, NOW, 400)!), null);
  assert.notEqual(svgA, svgB, 'the poster must follow the timetable theme');
});

// ── Encoder selection ─────────────────────────────────────────────────────────
//
// The property that matters is that turning QSV OFF (the default, and the only thing an
// App Store install can do) leaves the arguments exactly as they were. These were tuned
// against real decoder behaviour, and a drift here is a TV that will not play the stream.

test('the libx264 arguments are unchanged, for both pipelines', () => {
  assert.deepEqual(
    encoderArgs('x264', { level: '4.0', gop: 20, profile: 'baseline', x264Params: 'repeat-headers=1:nal-hrd=cbr' }),
    ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-level', '4.0',
     '-g', '20', '-keyint_min', '20', '-sc_threshold', '0', '-bf', '0', '-x264-params', 'repeat-headers=1:nal-hrd=cbr'],
  );
  assert.deepEqual(
    encoderArgs('x264', { level: '3.1', gop: 30, profile: 'main', x264Params: 'repeat-headers=1' }),
    ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'main', '-level', '3.1',
     '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-bf', '0', '-x264-params', 'repeat-headers=1'],
  );
  assert.equal(encoderPixFmt('x264'), 'yuv420p');
});

test('the QSV arguments drop the x264-only flags rather than passing them on', () => {
  const a = encoderArgs('qsv', { level: '4.0', gop: 20, profile: 'baseline', x264Params: 'repeat-headers=1:nal-hrd=cbr' });
  assert.ok(a.includes('h264_qsv'));
  // ffmpeg EXITS on an unknown option, so a leftover x264 flag is not a cosmetic problem —
  // it is a stream that never starts.
  for (const dead of ['-tune', '-x264-params', '-sc_threshold']) {
    assert.ok(!a.includes(dead), `${dead} is libx264-only and must not be sent to h264_qsv`);
  }
  // The decoder-compatibility guarantees have to survive the switch.
  assert.equal(a[a.indexOf('-profile:v') + 1], 'baseline');
  assert.equal(a[a.indexOf('-g') + 1], '20');
  assert.equal(a[a.indexOf('-bf') + 1], '0');
  // QSV takes NV12; handing it yuv420p makes ffmpeg convert or refuse.
  assert.equal(encoderPixFmt('qsv'), 'nv12');
});
