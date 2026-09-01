// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Everything that shows a prayer time must show the SAME prayer time.
 *
 * This app renders the same day through four different surfaces — the TV screen, the public
 * website widget (a "today" card plus a week table), the printable month calendar, and the Fabric
 * feed another app reads — and until the 0.70.0 audit three of them quietly disagreed with the
 * screen, because each had grown its own copy of the computation:
 *
 *   * `print.ts` never consulted `iqamahSchedule`, so a masjid that scheduled a change — the
 *     whole point of the WhatsApp wizard — printed the OLD Iqamah times indefinitely;
 *   * `print.ts` never applied `adhanOffsets`, and ROUNDED the minute where everything else
 *     floors, so about half the rows on a sheet were a minute later than the board beside it;
 *   * the widget's week table never applied `adhanOffsets` either, so one page showed 5:14 and
 *     5:19 for the same prayer on the same day, side by side.
 *
 * None of those is the kind of bug a reader finds by looking at one file, and none of them would
 * fail a test of that file alone. What catches them is comparing the surfaces to each other, so
 * that is what this does. `buildModel` is the reference — the screens are what a masjid checks
 * against — and the fixture deliberately turns on every override at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-agree-'));

const { normTimetable } = require('../validate') as typeof import('../validate');
const { buildModel, widgetPayload, fmtShort } = require('./svg') as typeof import('./svg');
const { renderMonthPrintHtml } = require('../print') as typeof import('../print');
const { zonedNoon } = require('../prayer/engine') as typeof import('../prayer/engine');
const { buildFeed } = require('../fabricTimetable') as typeof import('../fabricTimetable');

const KEYS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const;

/** Every override switched on at once — offsets, a scheduled change, and a CSV day. */
function fixture() {
  const tt = normTimetable({
    name: 'Agreement',
    masjidName: 'Madani Academy Masjid',
    latitude: 40.2415,
    longitude: -75.2838,
    timezone: 'America/New_York',
    timeFormat: '24h',
    jumuah: ['13:15', '14:00'],
  });
  // A masjid that calls the Adhan a few minutes late — the setting all three bugs ignored.
  tt.adhanOffsets = { fajr: 5, dhuhr: 3, asr: 7, maghrib: 2, isha: 4 };
  tt.iqamahSchedule = [{ from: '2026-03-10', fajr: '05:45', isha: '21:15', jumuah: ['13:45'] }];
  tt.iqamahYear = { '03-18': { fajr: '05:05', asr: '17:20' } };
  return tt;
}

/** The screen's own answer for a date, as "HH:mm" 24-hour. */
function screenDay(tt: ReturnType<typeof fixture>, y: number, mo: number, d: number) {
  const m = buildModel(tt, zonedNoon(y, mo, d, tt.timezone || undefined));
  const out: Record<string, { adhan: string; iqamah: string }> = {};
  for (const k of KEYS) {
    const r = m.rows.find((x) => x.key === k);
    out[k] = { adhan: fmtShort(r?.adhan ?? null, '24h'), iqamah: fmtShort(r?.iqamah ?? null, '24h') };
  }
  return { rows: out, jumuah: m.jumuah.map((h) => fmtShort(h, '24h')), isFriday: m.isFriday };
}

test('the printable month calendar agrees with the screen, every day and every prayer', () => {
  const tt = fixture();
  const html = renderMonthPrintHtml(tt, 2026, 3);
  // One <span class="pt"> per prayer, holding "adhan / iqamah" (or just the adhan when there is
  // no Iqamah). Asserting the PAIR is what makes this strict: a right Adhan beside a wrong
  // Iqamah — exactly what the missing iqamahSchedule produced — would pass a check on either
  // number alone.
  for (let d = 1; d <= 31; d++) {
    const want = screenDay(tt, 2026, 3, d);
    for (const k of KEYS) {
      const { adhan, iqamah } = want.rows[k];
      if (adhan === '—') continue;
      const cell = iqamah === '—' ? `>${adhan}<` : `>${adhan} / ${iqamah}<`;
      assert.ok(
        html.includes(cell),
        `2026-03-${String(d).padStart(2, '0')} ${k} should print as ${cell}, and does not appear`,
      );
    }
  }
});

test('the printable calendar shows a scheduled Iqamah change from the right day', () => {
  // The regression that mattered most: this used to print pre-change times for ever.
  const tt = fixture();
  const html = renderMonthPrintHtml(tt, 2026, 3);
  assert.ok(html.includes(' / 05:45<'), 'the scheduled 05:45 Fajr Iqamah must appear on the sheet');
  assert.ok(html.includes(' / 21:15<'), 'and the scheduled 21:15 Isha Iqamah');
  assert.ok(html.includes(' / 05:05<'), 'and a CSV per-day override still wins where set');
  // Before the change it must NOT be 05:45.
  assert.notEqual(screenDay(tt, 2026, 3, 9).rows.fajr.iqamah, '05:45', 'premise: the 9th predates it');
  assert.equal(screenDay(tt, 2026, 3, 10).rows.fajr.iqamah, '05:45');
});

test('the printable calendar floors the minute, like every other clock here', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'print.ts'), 'utf8');
  const fn = src.slice(src.indexOf('function fmt('));
  const body = fn.slice(0, fn.indexOf(String.fromCharCode(10) + '}'));
  assert.ok(!body.includes('Math.round'), 'print must not round the minute — the screens floor');
  assert.match(body, /Math\.floor\(hours \* 60\)/, 'same expression as fmtClock');
});

test('the printable calendar has no computation of its own left to drift', () => {
  // The root cause was a second implementation of the precedence chain, not any one of its bugs.
  const raw = fs.readFileSync(path.join(__dirname, '..', 'print.ts'), 'utf8');
  assert.match(raw, /buildModel\(tt, zonedNoon\(year, month, day, tz\)\)/, 'it must go through buildModel');
  // Comments stripped — the note explaining WHY this file no longer computes anything has to
  // name the things it used to reach for.
  const code = raw
    .split(String.fromCharCode(10))
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join(String.fromCharCode(10));
  for (const own of ['prayerTimes(', 'iqamahHours(', 'iqamahYear', 'iqamahSchedule', 'adhanOffsets']) {
    assert.ok(!code.includes(own), `print.ts must not reach for ${own} itself`);
  }
});

test('the widget card and the widget week table agree with each other and the screen', () => {
  const tt = fixture();
  // A Wednesday, so nothing about Jumu'ah is involved, and a date inside the scheduled change.
  const p = widgetPayload(tt, new Date('2026-03-18T16:00:00Z'), { date: '2026-03-18', weekStart: '2026-03-18' });
  const want = screenDay(tt, 2026, 3, 18);
  const day = p.week.days.find((d) => d.iso === '2026-03-18');
  assert.ok(day, 'the week table must contain the focus day');
  for (const k of KEYS) {
    const card = p.focus.rows.find((r) => r.key === k);
    assert.ok(card, `the card must have a ${k} row`);
    assert.equal(card!.adhan, want.rows[k].adhan, `${k}: the card must match the screen`);
    assert.equal(
      day![k],
      want.rows[k].adhan,
      `${k}: the week table must match the screen — this is where adhanOffsets went missing`,
    );
  }
});

test('a masjid with no Adhan offsets is unaffected by all of it', () => {
  // The fixes must not have moved times for the masjids that had nothing set.
  const tt = fixture();
  tt.adhanOffsets = {};
  const p = widgetPayload(tt, new Date('2026-03-18T16:00:00Z'), { date: '2026-03-18', weekStart: '2026-03-18' });
  const want = screenDay(tt, 2026, 3, 18);
  const day = p.week.days.find((d) => d.iso === '2026-03-18')!;
  for (const k of KEYS) assert.equal(day[k], want.rows[k].adhan, k);
});

test('the Fabric feed another app reads agrees with the screen too', () => {
  // It already did — it was written against buildModel from the start — but it is the surface a
  // musalli's phone shows, so a divergence here is the one nobody in the masjid could explain.
  const tt = fixture();
  const feed = buildFeed(tt, { y: 2026, m: 3, d: 8 }, 20);
  for (const d of feed.days) {
    const [y, mo, dd] = d.date.split('-').map(Number);
    const want = screenDay(tt, y, mo, dd);
    for (const k of KEYS) {
      assert.equal(d.prayers[k].adhan, want.rows[k].adhan === '—' ? null : want.rows[k].adhan, `${d.date} ${k} adhan`);
      assert.equal(d.prayers[k].iqamah, want.rows[k].iqamah === '—' ? null : want.rows[k].iqamah, `${d.date} ${k} iqamah`);
    }
    assert.deepEqual(d.jumuah.map((j) => j.iqamah), want.isFriday ? want.jumuah : [], `${d.date} jumuah`);
  }
});
