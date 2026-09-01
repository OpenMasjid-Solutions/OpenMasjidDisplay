// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The frost, and why it is now drawn twice in two places that must agree.
 *
 * A custom background is blurred — an feGaussianBlur across the whole canvas — and that blur is the
 * most expensive thing the renderer does. Measured with resvg on a Raspberry Pi 4, on a real
 * masjid's 1080p timetable and its own wallpaper:
 *
 *   with the frost      4764 ms per frame
 *   frost removed        966 ms
 *   no wallpaper at all  758 ms
 *
 * Nearly four seconds a frame, spent re-blurring a photograph that had not changed. The screen's
 * cadence controller correctly refused to spend the whole board on it and dropped the redraw to once
 * every five seconds — so setting a wallpaper made the clock lurch, and nothing in the panel
 * connected the two. Verified on the board afterwards: 0.9 redraws a second, and the advisory about
 * a slow screen stopped appearing.
 *
 * The fix is to blur once and reuse it, which means the blurred layer is now produced by
 * `frostedBackgroundSvg` and consumed by `renderDisplaySvg` with `bgPreblurred`. Those two have to
 * describe the SAME crop and the SAME filter or a screen shows a background that does not match its
 * own preview. This file is what holds them together.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDisplaySvg, frostedBackgroundSvg, dimsFor } from './svg';
import { normTimetable } from '../validate';

const BG = 'data:image/jpeg;base64,AAAA';
const tt = () =>
  normTimetable({
    masjidName: 'An-Noor Institute',
    latitude: 40.75,
    longitude: -73.88,
    timezone: 'America/New_York',
    themeId: 'cyan',
    quality: '1080p',
    orientation: 'landscape',
  });
const NOW = new Date('2026-08-20T21:46:00Z');

test('a background is normally blurred by the renderer itself', () => {
  const svg = renderDisplaySvg(tt(), NOW, { bg: BG });
  assert.ok(svg.includes('filter="url(#frost)"'), 'the image has to be frosted');
  assert.ok(svg.includes('feGaussianBlur'), 'and the filter has to be defined');
});

test('a pre-blurred background is not blurred a second time', () => {
  const svg = renderDisplaySvg(tt(), NOW, { bg: BG, bgPreblurred: true });
  assert.ok(svg.includes(BG), 'it still draws the image');
  assert.ok(!svg.includes('url(#frost)'), 'nothing may reference the filter');
  assert.ok(!svg.includes('feGaussianBlur'), 'and nothing may define it');
});

test('a pre-blurred background is still scrimmed, and still suppresses the themed texture', () => {
  // The scrim is what makes text readable over a photograph, and the khatam texture belongs to the
  // themed scene only. Skipping the blur must not turn the frame into the no-image frame — that
  // would be a different picture, not a faster one.
  const svg = renderDisplaySvg(tt(), NOW, { bg: BG, bgPreblurred: true });
  assert.ok(svg.includes('url(#scrim)'), 'the readability scrim stays');
  assert.ok(!svg.includes('url(#khatam)'), 'the themed texture must not appear over a photo');
});

test('the standalone frost layer crops the photo exactly as the scene does', () => {
  // Same element, same crop, same filter — otherwise the pre-blurred layer is a differently framed
  // picture and the screen quietly disagrees with the admin's preview.
  const { width, height } = dimsFor('landscape', '1080p');
  const layer = frostedBackgroundSvg(BG, width, height);
  const scene = renderDisplaySvg(tt(), NOW, { bg: BG });

  const el = (s: string): string => {
    const m = /<image href="data:image\/jpeg;base64,AAAA"[^>]*>/.exec(s);
    assert.ok(m, 'no background image element found');
    return m[0];
  };
  assert.ok(el(layer).includes('preserveAspectRatio="xMidYMid slice"'));
  assert.equal(el(layer), el(scene), 'the two background elements have to be identical');

  const filt = (s: string): string => {
    const m = /<filter id="frost"[^>]*>.*?<\/filter>/.exec(s);
    assert.ok(m, 'no frost filter found');
    return m[0];
  };
  assert.equal(filt(layer), filt(scene), 'the two filters have to be identical');
});

test('the frost layer is the size it was asked for, in either orientation', () => {
  for (const [orientation, quality] of [
    ['landscape', '1080p'],
    ['portrait', '1080p'],
    ['landscape', '720p'],
  ] as const) {
    const { width, height } = dimsFor(orientation, quality);
    const layer = frostedBackgroundSvg(BG, width, height);
    assert.ok(layer.includes(`width="${width}" height="${height}"`), `${orientation} ${quality}`);
    assert.ok(layer.includes(`viewBox="0 0 ${width} ${height}"`), 'and it has to have a viewBox, or resvg guesses');
  }
});
