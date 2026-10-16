// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The scenery must not drown the clock.
 *
 * The sun/moon travels an arc across the scene by time of day, drawn behind the glass cards. In
 * the Modern design there is almost no open sky for it to ride in: the arc's midday height puts it
 * inside the header band, and at roughly t=0.6 its x lands exactly where the clock's digits begin.
 * At full strength the body then sat behind the most-read element on the screen and took the
 * contrast out of it — measured on a television, a 24-hour dark-theme screen at 13:58 had the disc
 * covering the "1".
 *
 * ## Why the check is shaped like this
 *
 * The obvious test — "rasterise the clock and measure the contrast of the digits" — is not usable
 * here. This repository vendors two Arabic faces and no Latin one, so the digits rasterise
 * differently on Windows, on a CI runner and on a Pi, and the test would encode the machine that
 * wrote it. `golden.test.ts` pins the SVG rather than pixels for exactly that reason.
 *
 * So the text is STRIPPED and what is measured is the scene behind it. That is font-independent,
 * and it is the thing actually under control: how bright the decoration is allowed to make the
 * area the clock has to be legible against.
 *
 * Nor is "maximum pixel" the right statistic — the body's centre is one small bright spot, a bright
 * card on a light theme is correct and would fail it, and the digits only ever overlap part of it.
 * The mean over the region, compared against the SAME frame with the body removed, isolates the
 * body's own contribution and is the number that moved when this was fixed:
 *
 *       theme      no body    before     after
 *       emerald      0.455     +0.033    +0.013
 *       night        0.462     +0.032    +0.013
 *       ocean        0.500     +0.029    +0.012
 *       light        0.956     -0.001    -0.000
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-js';
import { renderDisplaySvg } from './svg';
import { normTimetable } from '../validate';
import type { Timetable } from '../types';

const BASE = {
  masjidName: 'Madani Academy',
  latitude: 40.2415,
  longitude: -75.2838,
  timezone: 'America/New_York',
  jumuah: ['13:30'],
  footerNote: 'Muslim World League',
};

/** 13:58 in New York — the worst minute, where the arc puts the body on the clock's digits. */
const WORST = new Date('2026-10-16T17:58:00Z');

/**
 * The clock's digits in the 1080p Modern landscape layout.
 *
 * Hardcoded on purpose: this is a specific place on a specific layout, and deriving it from the
 * layout code would make the test agree with that code by construction rather than check it. The
 * guard below fails if it ever stops pointing at the clock card.
 */
const BOX = { x0: 1090, x1: 1430, y0: 90, y1: 230 };

/** Mean relative luminance over the clock's area, with no text drawn. */
function meanLuminance(svg: string): number {
  const png = new Resvg(svg, { font: { loadSystemFonts: false }, fitTo: { mode: 'width', value: 1920 } }).render();
  const px = png.pixels;
  const W = png.width;
  let sum = 0;
  let n = 0;
  for (let y = BOX.y0; y < BOX.y1; y++) {
    for (let x = BOX.x0; x < BOX.x1; x++) {
      const i = (y * W + x) * 4;
      sum += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      n++;
    }
  }
  return sum / n;
}

function sceneFor(themeId: string): { withBody: string; withoutBody: string } {
  const tt = normTimetable({ ...BASE, layout: 'reference', quality: '1080p', themeId, timeFormat: '24h' }) as Timetable;
  // Text stripped: the measurement is of the SCENE the clock has to be read against.
  const withBody = renderDisplaySvg(tt, WORST, {}).replace(/<text[\s\S]*?<\/text>/g, '');
  // The same frame with the hard body gone — the sun's disc, or the moon's group.
  const withoutBody = withBody
    .replace(/<circle [^>]*fill="url\(#sun\)"[^>]*\/>/, '')
    .replace(/<g opacity="[\d.]+">[\s\S]*?fill="url\(#moon\)"[\s\S]*?<\/g>/, '');
  return { withBody, withoutBody };
}

const THEMES_UNDER_TEST = ['emerald', 'night', 'ocean', 'twilight', 'graphite', 'light'];

/**
 * How much the body may add to the scene behind the clock.
 *
 * Sits between what shipped (+0.029 to +0.033) and what the fix produces (+0.012 to +0.013), so
 * restoring the full-strength disc fails and the current value passes with room to move.
 */
const MAX_ADDED_LUMINANCE = 0.02;

test('the sun does not sit on the clock at full strength', () => {
  const report: string[] = [];
  for (const theme of THEMES_UNDER_TEST) {
    const { withBody, withoutBody } = sceneFor(theme);
    assert.notEqual(withBody, withoutBody, `${theme}: the body was not found, so nothing was measured`);
    const added = meanLuminance(withBody) - meanLuminance(withoutBody);
    report.push(`${theme} +${added.toFixed(3)}`);
    assert.ok(
      added <= MAX_ADDED_LUMINANCE,
      `${theme}: the sun/moon adds ${added.toFixed(3)} to the scene behind the clock, over the ` +
        `${MAX_ADDED_LUMINANCE} ceiling. The clock is the most-read thing on a prayer screen and ` +
        `the scenery is decoration; see BODY_THROUGH_GLASS in svg.ts.\n  ${report.join('  ')}`,
    );
  }
});

test('the measurement is actually looking at the clock', () => {
  // A test that measures the wrong rectangle would pass for ever. The clock card is a light glass
  // panel on a dark scene, so its area is markedly brighter than the page behind it.
  const { withBody } = sceneFor('emerald');
  const here = meanLuminance(withBody);
  const png = new Resvg(withBody, { font: { loadSystemFonts: false }, fitTo: { mode: 'width', value: 1920 } }).render();
  const px = png.pixels;
  const W = png.width;
  // A patch of bare scene, outside every card: the strip under the footer.
  let sum = 0;
  let n = 0;
  for (let y = 1045; y < 1075; y++) {
    for (let x = 40; x < 400; x++) {
      const i = (y * W + x) * 4;
      sum += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      n++;
    }
  }
  assert.ok(here > sum / n + 0.1, `the measured box is not on the clock card (box ${here.toFixed(3)} vs scene ${(sum / n).toFixed(3)})`);
});

test('turning the scenery off removes the body entirely', () => {
  // The escape hatch a masjid has today, and the thing that must keep working.
  const tt = normTimetable({ ...BASE, layout: 'reference', quality: '1080p', showCelestial: false }) as Timetable;
  const svg = renderDisplaySvg(tt, WORST, {});
  assert.ok(!svg.includes('url(#sun)'), 'showCelestial: false must not draw the sun');
  assert.ok(!svg.includes('url(#moon)'), 'showCelestial: false must not draw the moon');
});
