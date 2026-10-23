// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Every `url(#id)` the renderer emits must resolve to something it also defined.
 *
 * A dangling reference is a shape with no fill. resvg does not complain: it draws the element with
 * nothing in it, so the symptom is a panel, a glow or a whole background that is simply absent from
 * a masjid's wall — and absent in a way that looks like a design choice rather than a fault.
 *
 * ## Why this is not already covered by golden.test.ts
 *
 * That test pins every byte of the output for thirty configurations, so renaming a gradient and
 * missing a reference WOULD fail it. But its escape hatch is `OMD_GOLDEN_UPDATE=1`, and its own
 * header says regenerating is a decision rather than a fix. The failure mode this file exists for
 * is somebody breaking a reference, seeing the golden move, and accepting the new hash — at which
 * point the broken output becomes the pinned output. A hash cannot tell "moved" from "broken".
 * This can.
 *
 * It deliberately does NOT assert anything about *unused* definitions. The Simple layout defines
 * all twelve and uses none, which looks like waste and is not: resvg does not rasterise an
 * unreferenced def, and parsing the whole SVG without fonts costs 1.7 ms on a Pi 4. Measured —
 * see docs/RENDER_PERFORMANCE.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDisplaySvg } from './svg';
import { normTimetable } from '../validate';
import type { Timetable } from '../types';

/** A 1x1 PNG, enough to take the logo and slideshow paths without a fixture file. */
const IMG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const BASE = {
  masjidName: 'Madani Academy Masjid',
  latitude: 40.2415,
  longitude: -75.2838,
  timezone: 'America/New_York',
  jumuah: ['13:30', '14:30'],
  footerNote: 'Muslim World League',
};
const tt = (over: Record<string, unknown> = {}): Timetable => normTimetable({ ...BASE, ...over }) as Timetable;

const THU_AM = new Date('2026-09-10T09:14:03Z');
const FRI_PM = new Date('2026-09-11T17:40:00Z');
const FRI_ZAWAL = new Date('2026-09-11T16:52:00Z');
const NIGHT = new Date('2026-09-10T02:14:03Z');

/**
 * The spread, chosen so each one reaches definitions the others do not: the celestial glow differs
 * between day and night, the sun gradients only appear by day, the Friday table and the prohibited
 * window add their own panels, and a background photo switches the scrim on.
 */
const SHOTS: [name: string, over: Record<string, unknown>, now: Date][] = [
  ['modern', { layout: 'reference' }, THU_AM],
  ['modern at night', { layout: 'reference' }, NIGHT],
  ['modern portrait', { layout: 'reference', orientation: 'portrait' }, THU_AM],
  ['modern 720p', { layout: 'reference', quality: '720p' }, THU_AM],
  ['modern on a Friday', { layout: 'reference' }, FRI_PM],
  ['modern in the prohibited window', { layout: 'reference' }, FRI_ZAWAL],
  ['modern in Arabic', { layout: 'reference', language: 'Arabic' }, THU_AM],
  ['modern with a background photo', { layout: 'reference', backgroundImage: IMG }, THU_AM],
  ['modern with a logo', { layout: 'reference', logoImage: IMG }, THU_AM],
  [
    'modern with the slideshow up',
    {
      layout: 'reference',
      announcements: { enabled: true, images: [IMG], start: '', end: '', everySeconds: 1, forSeconds: 60, imageSeconds: 8 },
    },
    THU_AM,
  ],
  ['modern with a ticker', { layout: 'reference', ticker: { enabled: true, text: 'Jumu’ah at 1:30' } }, THU_AM],
  ['simple', { layout: 'simple' }, THU_AM],
  ['simple portrait', { layout: 'simple', orientation: 'portrait' }, THU_AM],
  ['simple in Urdu', { layout: 'simple', language: 'Urdu' }, THU_AM],
];

test('every paint reference resolves, in every configuration', () => {
  const broken: string[] = [];
  let checked = 0;
  for (const [name, over, now] of SHOTS) {
    const svg = renderDisplaySvg(tt(over), now, {});
    const defined = new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const used = [...new Set([...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]))];
    checked += used.length;
    const dangling = used.filter((u) => !defined.has(u));
    if (dangling.length) broken.push(`${name}: ${dangling.join(', ')}`);
  }
  assert.ok(checked > 0, 'no references were examined at all — the fixtures have stopped rendering');
  assert.deepEqual(
    broken,
    [],
    `a fill refers to a definition that is not in the output, so it draws as nothing:\n  ${broken.join('\n  ')}`,
  );
});

test('the check can see a reference that does not resolve', () => {
  // Otherwise this is a test that passes because it looks at nothing.
  const svg = renderDisplaySvg(tt({ layout: 'reference' }), THU_AM, {}).replace('id="scene"', 'id="scene-renamed"');
  const defined = new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const dangling = [...new Set([...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]))].filter((u) => !defined.has(u));
  assert.deepEqual(dangling, ['scene'], 'renaming a definition must show up as a dangling reference');
});
