// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * What this app is allowed to draw on top of a masjid's own announcement artwork.
 *
 * A slideshow image is somebody's poster: it has its own footer, its own type, its own idea of
 * where the bottom edge is. The calculation-method footnote — "Custom 18° / 15° · Asr: Hanafi" —
 * was drawn across it, half-overlapping the address bar the masjid had put in their own design. It
 * read exactly like a watermark, because that is what it was.
 *
 * The footnote had one guard, `!bandShown`, on the reasoning that the bottom band is the footnote's
 * spot. An announcement is not a band, so nothing stopped it.
 *
 * The bottom BAND is the deliberate exception and is pinned here too, because the two look alike
 * and the difference is easy to lose: a red "Iqāmah times are changing" reminder is this app
 * speaking about today, and it has to be readable whatever the slideshow happens to be showing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDisplaySvg } from './svg';
import { normTimetable } from '../validate';
import { normalizeIqamahSchedule } from '../iqamahSchedule';
import type { Timetable } from '../types';

const NOW = new Date('2026-08-22T20:11:00-04:00');
/** A one-pixel PNG: this is about what is drawn AROUND the image, never the image itself. */
const IMG = 'data:image/png;base64,iVBORw0KGgo=';
const NOTE = 'Custom 18° / 15° · Asr: Hanafi';

function tt(over: Record<string, unknown> = {}): Timetable {
  return normTimetable({
    masjidName: 'An-Noor Institute',
    latitude: 40.7498,
    longitude: -73.8831,
    timezone: 'America/New_York',
    method: 'Custom',
    fajrAngle: 18,
    ishaAngle: 15,
    asrMadhab: 'Hanafi',
    showFooter: true,
    ...over,
  });
}

test('the method footnote is not drawn over an announcement', () => {
  assert.ok(renderDisplaySvg(tt(), NOW, {}).includes(NOTE), 'it is still shown normally');
  assert.ok(!renderDisplaySvg(tt(), NOW, { announcement: IMG }).includes(NOTE));
});

test('…in either orientation, and under either design', () => {
  for (const over of [
    { orientation: 'portrait' },
    { orientation: 'landscape' },
    { layout: 'simple' },
    { layout: 'modern' },
  ]) {
    const svg = renderDisplaySvg(tt(over), NOW, { announcement: IMG });
    assert.ok(!svg.includes(NOTE), `${JSON.stringify(over)} still drew the footnote`);
  }
});

test("a masjid's own footer line is suppressed too — it is the same element", () => {
  // `footerNote` replaces the method note in that slot. Suppressing only the computed one would
  // have left every masjid that typed their own line with the watermark they had actually noticed.
  const own = tt({ footerNote: 'Ramadan timetable — please check weekly' });
  assert.ok(renderDisplaySvg(own, NOW, {}).includes('please check weekly'));
  assert.ok(!renderDisplaySvg(own, NOW, { announcement: IMG }).includes('please check weekly'));
});

test('the strip the footnote reserved goes back to the image', () => {
  // The layout area was shortened to make room for the footnote whether or not one was going to be
  // drawn, so suppressing the text alone would have left an empty band under the picture. With an
  // announcement showing, `showFooter` should now make no difference to the frame at all.
  const on = renderDisplaySvg(tt({ showFooter: true }), NOW, { announcement: IMG });
  const off = renderDisplaySvg(tt({ showFooter: false }), NOW, { announcement: IMG });
  assert.equal(on, off, 'showFooter must not change an announcing frame in any way');
});

test('the Iqāmah-change reminder DOES still draw over an announcement', () => {
  // The deliberate exception. Note the wording carries neither "Iqāmah" nor "changing" — it reads
  // "From Tuesday, Asr will be at 5:30 PM" — which is what made this easy to mis-test.
  const withChange = tt();
  withChange.iqamahSchedule = normalizeIqamahSchedule([{ from: '2026-08-25', asr: '17:30' }]);
  withChange.iqamahChangeNotice = { enabled: true, daysBefore: 5 };
  const svg = renderDisplaySvg(withChange, NOW, { announcement: IMG });
  assert.match(svg, /Asr will be at/, 'the reminder has to survive the slideshow');
  // And it must not have brought the footnote back with it.
  assert.ok(!svg.includes(NOTE));
});

test('a ticker also still draws over an announcement', () => {
  const withTicker = tt();
  withTicker.ticker = {
    enabled: true,
    messages: [{ id: 'm1', text: 'Fundraising dinner this Saturday', start: '', end: '' }],
  } as Timetable['ticker'];
  const svg = renderDisplaySvg(withTicker, NOW, { announcement: IMG });
  assert.match(svg, /Fundraising dinner/, 'the ticker is the other thing that outranks the image');
});
