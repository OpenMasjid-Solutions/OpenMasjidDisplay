// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The Simple design's left column, and where the seconds go on both designs.
 *
 * Three things a masjid asked for, and each of them is the kind that a screenshot of one screen
 * says nothing about:
 *
 *  - the head of the column read as cluttered, so the sunrise/sunset pair moved under the date as
 *    one small row, and the countdown (a sentence, then a wheel) went altogether — the
 *    highlighted table row already says which prayer is next;
 *  - the seconds, when shown, were two small digits stacked over the AM/PM, and a masjid wanted
 *    them in the clock's own face instead.
 *
 * The last one is a SETTING, so the thing to pin is not how it looks but that the default is
 * unchanged and that the two styles do not both draw. And the clock grows about a third wider
 * with seconds in it, so "does it still fit its column" is arithmetic, not an opinion.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDisplaySvg, approxWidth, dimsFor } from './svg';
import { normTimetable } from '../validate';
import type { Timetable } from '../types';

/** 10:22:05 PM — the widest a 12-hour clock gets, seconds and all. */
const NOW = new Date('2026-09-11T22:22:05-04:00');
/** A Friday afternoon, for the Jumu'ah cases. */
const FRI = new Date('2026-09-11T17:40:00Z');
const IMG = 'data:image/png;base64,iVBORw0KGgo=';

const BASE = {
  masjidName: 'Madani Academy Masjid',
  latitude: 40.2415,
  longitude: -75.2838,
  timezone: 'America/New_York',
  jumuah: ['13:30', '14:30'],
};

function tt(over: Record<string, unknown> = {}): Timetable {
  return normTimetable({ ...BASE, ...over }) as Timetable;
}

type Run = { body: string; size: number; l: number; r: number; t: number; b: number; anchor: string };

function runs(svg: string): Run[] {
  const out: Run[] = [];
  for (const m of svg.matchAll(/<text ([^>]*)>([\s\S]*?)<\/text>/g)) {
    const a = m[1];
    const g = (k: string) => new RegExp(`(?:^|\\s)${k}="([^"]*)"`).exec(a)?.[1] ?? '';
    const body = m[2].replace(/<[^>]*>/g, '');
    if (!body.trim()) continue;
    const size = Number(g('font-size'));
    const w = approxWidth(body, size) + Math.max(0, body.length - 1) * Number(g('letter-spacing') || 0);
    const anchor = g('text-anchor');
    const x = Number(g('x'));
    const l = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
    const y = Number(g('y'));
    out.push({ body, size, l, r: l + w, t: y - size * 0.72, b: y + size * 0.2, anchor });
  }
  return out;
}

/** The biggest clock-shaped run on the frame — the wall clock, not a prayer time. */
function clockRun(svg: string): Run {
  const c = runs(svg)
    .filter((r) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(r.body))
    .sort((a, b) => b.size - a.size)[0];
  assert.ok(c, 'no clock found');
  return c;
}

// ── where the seconds go ─────────────────────────────────────────────────────

test('the seconds setting defaults to what every screen already did', () => {
  // The whole point of adding a style rather than changing the one that existed: a masjid that
  // has the seconds turned on must see exactly what it saw yesterday until it chooses otherwise.
  assert.equal(tt().secondsStyle, 'stacked');
  assert.equal(tt({ secondsStyle: 'inline' }).secondsStyle, 'inline');
  assert.equal(tt({ secondsStyle: 'sideways' }).secondsStyle, 'stacked', 'an unknown value is not a style');
});

test('inline seconds go IN the clock, and stacked ones beside it — never both', () => {
  /**
   * The failure this guards is drawing them twice. The clock string and the little stacked block
   * are produced in two different places — `fmtClock(..., withSeconds)` and `secStr` — and they
   * are switched by one flag each. Set one without the other and the screen reads "10:22:05 05".
   */
  for (const layout of ['simple', 'modern']) {
    const inline = renderDisplaySvg(tt({ layout, showSeconds: true, secondsStyle: 'inline' }), NOW, {});
    const stacked = renderDisplaySvg(tt({ layout, showSeconds: true, secondsStyle: 'stacked' }), NOW, {});
    const off = renderDisplaySvg(tt({ layout, showSeconds: false }), NOW, {});

    assert.match(clockRun(inline).body, /^\d{1,2}:\d{2}:\d{2}$/, `${layout}: inline should put seconds in the face`);
    assert.match(clockRun(stacked).body, /^\d{1,2}:\d{2}$/, `${layout}: stacked should leave the face alone`);
    assert.match(clockRun(off).body, /^\d{1,2}:\d{2}$/, `${layout}: seconds off`);

    // "05" drawn on its own is the stacked block. It belongs to exactly one of the three.
    const loose = (svg: string) => runs(svg).filter((r) => r.body === '05').length;
    assert.equal(loose(stacked), 1, `${layout}: stacked draws the seconds beside the clock`);
    assert.equal(loose(inline), 0, `${layout}: inline must not ALSO draw them beside it`);
    assert.equal(loose(off), 0, `${layout}: seconds off draws none`);
  }
});

test('the inline clock shrinks to keep its column, and keeps the AM/PM', () => {
  // A third more digits in the same box. Nothing clamps the clock for this case specially — the
  // existing fit-to-width does it — so what is asserted is the outcome: smaller, and still inside.
  for (const layout of ['simple', 'modern']) {
    for (const timeFormat of ['12h', '24h']) {
      const inline = renderDisplaySvg(tt({ layout, timeFormat, showSeconds: true, secondsStyle: 'inline' }), NOW, {});
      const stacked = renderDisplaySvg(tt({ layout, timeFormat, showSeconds: true, secondsStyle: 'stacked' }), NOW, {});
      assert.ok(
        clockRun(inline).size < clockRun(stacked).size,
        `${layout}/${timeFormat}: the inline clock should be set smaller, not overflow`,
      );
    }
    const svg = renderDisplaySvg(tt({ layout, showSeconds: true, secondsStyle: 'inline' }), NOW, {});
    assert.ok(runs(svg).some((r) => r.body === 'PM'), `${layout}: the AM/PM is still shown`);
  }
});

test('nothing leaves the frame with the seconds in the clock', () => {
  // The widest clock there is, across every shape the app draws, both formats and both styles.
  const bad: string[] = [];
  for (const layout of ['simple', 'modern']) {
    for (const orientation of ['landscape', 'portrait']) {
      for (const quality of ['1080p', '720p']) {
        for (const timeFormat of ['12h', '24h']) {
          for (const secondsStyle of ['stacked', 'inline']) {
            for (const ann of [null, IMG]) {
              const t = tt({ layout, orientation, quality, timeFormat, showSeconds: true, secondsStyle });
              const svg = renderDisplaySvg(t, NOW, ann ? { announcement: IMG } : {});
              const { width: W, height: H } = dimsFor(orientation, quality);
              for (const r of runs(svg)) {
                if (r.l < -0.5 || r.r > W + 0.5 || r.t < -0.5 || r.b > H + 0.5) {
                  bad.push(`${layout}/${orientation}/${quality}/${timeFormat}/${secondsStyle}: "${r.body}"`);
                }
              }
            }
          }
        }
      }
    }
  }
  assert.deepEqual(bad.slice(0, 6), [], `${bad.length} runs off the frame`);
});

// ── the sunrise/sunset pair ──────────────────────────────────────────────────

test('sunrise and sunset sit side by side, under the date', () => {
  const svg = renderDisplaySvg(tt({ layout: 'simple' }), FRI, {});
  const rs = runs(svg);
  const sun = rs.filter((r) => /^SUN(RISE|SET) /.test(r.body));
  assert.equal(sun.length, 2, 'both are drawn');
  assert.ok(Math.abs(sun[0].size - sun[1].size) < 0.01, 'at the same size — two sizes would read as a mistake');
  assert.ok(Math.abs(sun[0].t - sun[1].t) < 0.5, 'on one row, not stacked');
  assert.ok(sun[0].r <= sun[1].l, 'sunrise first, and the two do not touch');
  const greg = rs.find((r) => /2026/.test(r.body) && /September/.test(r.body));
  assert.ok(greg, 'the Gregorian date is drawn');
  assert.ok(sun[0].t > greg!.b, 'below the date, not above the clock');
  const clock = clockRun(svg);
  assert.ok(sun[0].size < clock.size * 0.25, 'and small — reference, not headline');
});

// ── no countdown on Simple ───────────────────────────────────────────────────

test('the Simple column has no countdown wheel or sentence', () => {
  for (const orientation of ['landscape', 'portrait']) {
    for (const extra of [{}, { announcement: IMG }]) {
      const svg = renderDisplaySvg(tt({ layout: 'simple', orientation }), FRI, extra);
      assert.ok(!/stroke-dasharray/.test(svg), `${orientation}: no arc`);
      assert.ok(!/UNTIL /.test(svg), `${orientation}: no "UNTIL …"`);
      assert.ok(!/Next .* in /.test(svg), `${orientation}: no sentence either`);
    }
  }
});

test('a forty-character prayer name overlaps nothing in the narrowest column', () => {
  // Every prayer name is an admin-editable label and `normLabels` takes forty characters, so the
  // name is shortened rather than drawn over its own times.
  const svg = renderDisplaySvg(tt({ layout: 'simple', quality: '720p', labels: { jumuah: 'J'.repeat(40) } }), FRI, { announcement: IMG });
  const rs = runs(svg);
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const ox = Math.min(rs[i].r, rs[j].r) - Math.max(rs[i].l, rs[j].l);
      const oy = Math.min(rs[i].b, rs[j].b) - Math.max(rs[i].t, rs[j].t);
      assert.ok(!(ox > 0.5 && oy > 0.5), `"${rs[i].body}" over "${rs[j].body}"`);
    }
  }
});

// ── the invariants the first version of these tests could not see ────────────

test('no empty <text> element is ever emitted', () => {
  /**
   * The lesson from the review, and the reason this is its own test rather than a stronger
   * version of the overlap sweep.
   *
   * The wheel's centre label was coming out as `<text …></text>` — the prayer name wholly absent
   * from the ring — beside a slideshow image at 720p. The test written to guard that exact
   * string, with that exact configuration, PASSED: its `runs()` helper skips runs with no body,
   * so the one run it existed to check was the one it could not see. A measurement that discards
   * the failure case is not a measurement.
   *
   * An empty text element is never correct. It is what a fit-with-a-floor produces when the floor
   * is still too big for the room, and it is silent on screen and in every geometric check.
   */
  const bad: string[] = [];
  for (const layout of ['simple', 'modern']) {
    for (const quality of ['1080p', '720p']) {
      for (const orientation of ['landscape', 'portrait']) {
        for (const language of ['en', 'ar', 'ur']) {
          for (const ann of [null, IMG]) {
            for (const over of [{}, { showLogo: false, showName: false, showSunrise: false }, { jumuah: ['13:30', '14:30'] }, { jumuah: [] }]) {
              const t = tt({ layout, quality, orientation, language, ...over });
              const svg = renderDisplaySvg(t, FRI, ann ? { announcement: IMG } : {});
              for (const m of svg.matchAll(/<text ([^>]*)>([\s\S]*?)<\/text>/g)) {
                if (!m[2].replace(/<[^>]*>/g, '').trim()) {
                  bad.push(`${layout}/${quality}/${orientation}/${language}${ann ? ' +pic' : ''}`);
                }
              }
            }
          }
        }
      }
    }
  }
  assert.deepEqual(bad.slice(0, 6), [], `${bad.length} empty text elements`);
});

test("the labels this app ships with are never shortened", () => {
  // Shortening is the backstop for a forty-character rename, not something a masjid that has
  // changed nothing should ever see. "MAGHRIB" was coming out as "MAGHR..." inside the wheel on
  // every shape but one, because the label's budget was a guess at the ring's chord that fell 14%
  // short of it.
  const bad: string[] = [];
  for (const quality of ['1080p', '720p']) {
    for (const orientation of ['landscape', 'portrait']) {
      for (const language of ['en', 'ar', 'ur']) {
        for (const ann of [null, IMG]) {
          const svg = renderDisplaySvg(tt({ layout: 'simple', quality, orientation, language }), FRI, ann ? { announcement: IMG } : {});
          for (const r of runs(svg)) {
            if (r.body.endsWith('...')) bad.push(`${quality}/${orientation}/${language}${ann ? ' +pic' : ''}: "${r.body}"`);
          }
        }
      }
    }
  }
  assert.deepEqual(bad.slice(0, 6), [], `${bad.length} default labels shortened`);
});

test('the prohibited window still says so in words, not only in red', () => {
  // With the countdown gone, the one red line in its place is the only thing that names the
  // window when the ticker is off — a red tint alone does not tell a volunteer what is happening.
  for (const quality of ['1080p', '720p']) {
    for (const orientation of ['landscape', 'portrait']) {
      const svg = renderDisplaySvg(
        tt({ layout: 'simple', quality, orientation, prohibitedNotice: { enabled: true, minutes: 10 } }),
        new Date('2026-09-11T16:52:00Z'),
        {},
      );
      assert.match(svg, /PROHIBITED|Prohibited/, `${quality}/${orientation}: the state is not named`);
    }
  }
});

test('the clock shows the second it is actually on', () => {
  /**
   * `nowHours` is `hour + minute/60 + second/3600`, and multiplying that float back up lands a
   * hair BELOW the whole number about one second in twenty-five. Flooring it then showed the
   * PREVIOUS second: a wall clock whose seconds digit repeats and then skips, twice a minute.
   *
   * It is tested over a whole hour because the error depends on which minute and second the
   * float happens to land on, so a handful of samples proves nothing.
   */
  const t = tt({ layout: 'simple', showSeconds: true, secondsStyle: 'inline' });
  let wrong = 0;
  for (let s = 0; s < 3600; s++) {
    const svg = renderDisplaySvg(t, new Date(Date.UTC(2026, 8, 11, 14, 0, s)), {}).replace(/<\/?tspan[^>]*>/g, '');
    const m = /<text [^>]*>(\d{1,2}:\d{2}:\d{2})<\/text>/.exec(svg);
    if (!m || m[1].slice(-2) !== String(s % 60).padStart(2, '0')) wrong++;
  }
  assert.equal(wrong, 0, `${wrong} of 3600 seconds showed the wrong value`);
});

// ── and the thing that broke while this was being built ──────────────────────

test('a prayer name is never shortened to save a fraction of a pixel', () => {
  /**
   * "JUMU'AH" was coming out as "JUMU'..." on a portrait screen — not because it did not fit, but
   * because it missed by 0.2px. The table's type solve converges iteratively and stopped within a
   * tenth of a percent of its budget, and the shortener acted on the remainder. Shortening is a
   * CLIFF: the ellipsis costs about three characters, so a fifth of a pixel took two letters off
   * the word Jumu'ah.
   */
  const bad: string[] = [];
  for (const orientation of ['landscape', 'portrait']) {
    for (const quality of ['1080p', '720p']) {
      for (const ann of [null, IMG]) {
        const svg = renderDisplaySvg(tt({ layout: 'simple', orientation, quality }), FRI, ann ? { announcement: IMG } : {});
        // The TABLE's row, not the wheel's label: the table's is left-anchored.
        const name = runs(svg).find((r) => r.anchor === 'start' && /^JUMU/.test(r.body));
        if (name && name.body.endsWith('...')) bad.push(`${orientation}/${quality}${ann ? ' +pic' : ''}: ${name.body}`);
      }
    }
  }
  assert.deepEqual(bad, [], 'the default label should fit every shape this app draws');
});
