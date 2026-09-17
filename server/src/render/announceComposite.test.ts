// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A slideshow image must not cost the screen its prayer times.
 *
 * v0.70.0 made an announcement image full-bleed: it covered the whole frame, cover-fit, and the
 * timetable was simply not drawn for as long as the image was up. The reasoning was about the
 * IMAGE — a poster is designed to be read on its own, and the old sidebar squeezed it beside a
 * shrunk table so that neither half worked. That reasoning is sound and this does not undo it;
 * what it missed is that a prayer screen whose prayer times disappear for twenty seconds in every
 * forty-five is not a prayer screen. Somebody standing in the hall at the wrong moment sees a
 * flyer and no times at all.
 *
 * So the image and the timetable share the frame, and the three things that made the old
 * composite bad are the three things pinned here:
 *
 *  - the times are still drawn — all of them, not a reduced set;
 *  - the image is shown WHOLE (contain-fit), because its box is now close to square and cropping
 *    a masjid's flyer to fill a box that did not need filling is the worse trade; and
 *  - nothing is painted across it — in particular the ticker band, which used to scroll straight
 *    over somebody's poster.
 *
 * Also here: the Simple design finally has a portrait of its own. It used to return the Modern
 * stack, so a masjid that chose Simple and hung the screen portrait got Modern — the setting
 * silently did nothing — and the same narrow arrangement is what the composite's timetable column
 * needs, so the two are one function.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDisplaySvg, approxWidth, bottomBandSplit, dimsFor } from './svg';
import { normTimetable } from '../validate';
import type { Timetable } from '../types';

/** A Friday afternoon, so Jumu'ah is in the table and the countdown has something to count. */
const NOW = new Date('2026-09-11T17:40:00Z');
/** A one-pixel PNG. Every assertion here is about the BOX the image is given, never its pixels. */
const IMG = 'data:image/png;base64,iVBORw0KGgo=';

function tt(over: Record<string, unknown> = {}): Timetable {
  return normTimetable({
    masjidName: 'Madani Academy Masjid',
    latitude: 40.2415,
    longitude: -75.2838,
    timezone: 'America/New_York',
    jumuah: ['13:30', '14:30'],
    ...over,
  });
}

const TICKER = {
  enabled: true,
  messages: [{ id: 't1', text: 'Fundraising dinner this Saturday after Isha', start: '', end: '' }],
} as Timetable['ticker'];

/** The announcement image's own box, read back off the rendered document. */
function pic(svg: string): { x: number; y: number; w: number; h: number; fit: string } {
  const el = [...svg.matchAll(/<image\b[^>]*>/g)].map((m) => m[0]).find((s) => s.includes(IMG));
  assert.ok(el, 'the announcement image must be in the document at all');
  const num = (k: string) => {
    const hit = new RegExp(`\\s${k}="([-\\d.]+)"`).exec(el!);
    assert.ok(hit, `the image has no ${k}`);
    return Number(hit![1]);
  };
  return {
    x: num('x'),
    y: num('y'),
    w: num('width'),
    h: num('height'),
    fit: /preserveAspectRatio="([^"]*)"/.exec(el!)?.[1] ?? '',
  };
}

/** Every clock time the document draws, e.g. "5:25 AM" — the timetable's whole point. */
function times(svg: string): string[] {
  return [...svg.matchAll(/>(\d{1,2}:\d{2}(?:\s?[AP]M)?)</g)].map((m) => m[1]);
}

// ── the times survive the picture ────────────────────────────────────────────

test('every prayer time still on screen is still on screen with an image up', () => {
  for (const layout of ['modern', 'simple']) {
    for (const orientation of ['landscape', 'portrait']) {
      const t = tt({ layout, orientation });
      const plain = times(renderDisplaySvg(t, NOW, {}));
      const withImg = new Set(times(renderDisplaySvg(t, NOW, { announcement: IMG })));
      assert.ok(plain.length >= 8, `${layout}/${orientation}: the plain frame should have a full table`);
      for (const s of plain) {
        assert.ok(withImg.has(s), `${layout}/${orientation}: ${s} vanished behind the slideshow`);
      }
    }
  }
});

test("Jumu'ah in particular survives — it is the row people came to read on a Friday", () => {
  for (const layout of ['modern', 'simple']) {
    const svg = renderDisplaySvg(tt({ layout }), NOW, { announcement: IMG });
    assert.match(svg, /JUMU|Jumu/, `${layout} lost the Jumu'ah row`);
    assert.ok(svg.includes('1:30 PM') && svg.includes('2:30 PM'), `${layout} lost the Jumu'ah times`);
  }
});

// ── the picture keeps its own shape, and its own box ─────────────────────────

test('the image is shown whole, not cropped to fill', () => {
  // Cover-fit ("slice") is right when the image owns the entire screen and was measured to be
  // right there. Beside the timetable the box is close to square, so a portrait poster fits it
  // nearly whole — cropping it would be throwing away a flyer's edges for nothing.
  for (const orientation of ['landscape', 'portrait']) {
    const p = pic(renderDisplaySvg(tt({ orientation }), NOW, { announcement: IMG }));
    assert.equal(p.fit, 'xMidYMid meet', `${orientation} must contain-fit`);
  }
});

test('the image gets a large box beside the timetable, not the whole frame', () => {
  const land = dimsFor('landscape', '1080p');
  const landW = land.width;
  const p = pic(renderDisplaySvg(tt({ orientation: 'landscape' }), NOW, { announcement: IMG }));
  assert.ok(p.x > landW * 0.15, 'the timetable column comes first');
  assert.ok(p.w > landW * 0.5, `the picture still gets the larger share, had ${p.w} of ${landW}`);
  assert.ok(p.x + p.w <= landW + 0.5, 'and stays on screen');

  const port = dimsFor('portrait', '1080p');
  const portW = port.width;
  const portH = port.height;
  const q = pic(renderDisplaySvg(tt({ orientation: 'portrait' }), NOW, { announcement: IMG }));
  assert.ok(q.y + q.h < portH * 0.6, 'portrait stacks the picture on top, timetable beneath');
  assert.ok(q.w > portW * 0.8, 'across the full width, since that is the axis with no room to spare');
});

// ── nothing is painted across it ─────────────────────────────────────────────

test('the ticker band does not run across the picture', () => {
  // This is the reported fault, and the fix is NOT to silence the ticker while an image is up:
  // on a decoder screen the moving text is an ffmpeg drawtext filter, so changing it every time
  // the slideshow phase flips (about twice a minute) would respawn ffmpeg and drop the RTSP
  // stream with it. The picture is kept out of the band's strip instead.
  for (const orientation of ['landscape', 'portrait']) {
    const t = tt({ orientation, ticker: TICKER });
    const { width: W, height: H } = dimsFor(orientation, '1080p');
    const band = bottomBandSplit(t, NOW, W, H, true);
    const p = pic(renderDisplaySvg(t, NOW, { announcement: IMG }));
    assert.ok(
      p.y + p.h <= band.y + 0.5,
      `${orientation}: the image reaches ${(p.y + p.h).toFixed(0)}, the band starts at ${band.y.toFixed(0)}`,
    );
  }
});

test('a ticker costs the picture height rather than being drawn over it', () => {
  // The observable other half: turning the ticker on must MOVE the image, not just leave it
  // where it was with a strip painted on top.
  const withTicker = pic(renderDisplaySvg(tt({ ticker: TICKER }), NOW, { announcement: IMG }));
  const without = pic(renderDisplaySvg(tt(), NOW, { announcement: IMG }));
  assert.ok(withTicker.h < without.h, 'the band has to come out of the image, not sit on it');
});

// ── Simple's own portrait ────────────────────────────────────────────────────

test('Simple in portrait is Simple, not Modern wearing its colours', () => {
  // `layoutSimple` used to hand portrait straight to the Modern stack, so this was Modern in
  // every particular except the palette — the countdown ring included.
  const simple = renderDisplaySvg(tt({ layout: 'simple', orientation: 'portrait' }), NOW);
  const modern = renderDisplaySvg(tt({ layout: 'modern', orientation: 'portrait' }), NOW);
  assert.ok(modern.includes('stroke-dasharray'), 'Modern portrait keeps its countdown ring');
  assert.ok(!simple.includes('stroke-dasharray'), 'Simple has no ring, in any orientation');
  assert.ok(simple.includes('PRAYER TIMES'), "and it has Simple's banded table");
  assert.match(simple, /Next .* in /, 'plus the plain sentence Simple uses instead of the ring');
});

test("the composite's timetable column follows the design the masjid chose", () => {
  const simple = renderDisplaySvg(tt({ layout: 'simple' }), NOW, { announcement: IMG });
  const modern = renderDisplaySvg(tt({ layout: 'modern' }), NOW, { announcement: IMG });
  assert.ok(!simple.includes('stroke-dasharray'), 'a Simple screen stays Simple beside a picture');
  assert.ok(modern.includes('stroke-dasharray'), 'a Modern one stays Modern');
});

// ── the date line, which is what "the date gets cut off" was ─────────────────

/**
 * The two halves of Simple's combined date line, with the extent each one actually occupies.
 *
 * They are the only pair of `<text>` elements sharing a baseline with anchors `end` then `start`
 * — the sunrise/sunset pair above them are both `start`. Identifying them that way rather than by
 * their content keeps this test working in every language, which matters because Urdu and Arabic
 * are where it overflowed.
 */
function dateExtent(svg: string): { left: number; right: number; y: number } {
  const rows = new Map<string, { x: number; y: number; size: number; anchor: string; body: string }[]>();
  for (const m of svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)) {
    const at = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(m[1])?.[1] ?? '';
    const y = at('y');
    const row = rows.get(y) ?? [];
    row.push({ x: Number(at('x')), y: Number(y), size: Number(at('font-size')), anchor: at('text-anchor'), body: m[2] });
    rows.set(y, row);
  }
  for (const row of rows.values()) {
    if (row.length !== 2 || row[0].anchor !== 'end' || row[1].anchor !== 'start') continue;
    return {
      left: row[0].x - approxWidth(row[0].body, row[0].size),
      right: row[1].x + approxWidth(row[1].body, row[1].size),
      y: row[0].y,
    };
  }
  assert.fail('no Hijri-bar-Gregorian date line found');
}

test('the date line stays inside the brand column in every language', () => {
  // It was never clipped — it OVERFLOWED, and only in Simple, because only Simple centres a long
  // date under a narrow column. The bar sat on the column's centre line, which centres the
  // divider rather than the line: the two halves are nowhere near equal in width, so the whole
  // line hung off-centre by half their difference and ran out past the edge into the table.
  const { width: W, height: H } = dimsFor('landscape', '1080p');
  const P = Math.round(Math.min(W, H) * 0.05);
  const area = { x: P, w: W - 2 * P };
  const gap = Math.min(area.w, H - 2 * P) * 0.03;
  const colW = (area.w - gap) * 0.3; // layoutSimple's own split
  for (const language of ['en', 'ar', 'ur']) {
    const svg = renderDisplaySvg(tt({ layout: 'simple', language }), NOW, {});
    const d = dateExtent(svg);
    assert.ok(d.left >= area.x - 1, `${language}: the date starts at ${d.left.toFixed(0)}, box starts at ${area.x}`);
    assert.ok(
      d.right <= area.x + colW + 1,
      `${language}: the date ends at ${d.right.toFixed(0)}, the column ends at ${(area.x + colW).toFixed(0)}`,
    );
  }
});

test('…and in the narrower column it gets beside a picture', () => {
  for (const language of ['en', 'ur']) {
    const svg = renderDisplaySvg(tt({ layout: 'simple', language }), NOW, { announcement: IMG });
    const p = pic(svg);
    const d = dateExtent(svg);
    assert.ok(d.right <= p.x + 1, `${language}: the date runs to ${d.right.toFixed(0)}, under the picture at ${p.x}`);
  }
});

// ── the brand block fits the box it is given ─────────────────────────────────

test('the brand block never runs through the table below it', () => {
  // Its sizes all come from the box WIDTH, which was right while it was the full height of a
  // landscape screen and wrong the moment it had to head a portrait one or a short column: it
  // simply ran off the bottom, through the "PRAYER TIMES" band, with the date drawn over rows.
  // The band is drawn before the text that sits on it, so "the title bar is below everything the
  // brand block drew" is the observable form of "the block fits".
  for (const orientation of ['landscape', 'portrait']) {
    const svg = renderDisplaySvg(tt({ layout: 'simple', orientation }), NOW, { announcement: IMG });
    const i = svg.indexOf('PRAYER TIMES');
    assert.ok(i > 0, `${orientation}: the table title is missing`);
    const bandY = Number(/y="([-\d.]+)"/.exec(svg.slice(svg.lastIndexOf('<rect', i), i))![1]);
    // The date is the lowest thing the brand block draws that is easy to find again, and it is
    // the line that actually landed on the table when the block overflowed.
    const dateY = dateExtent(svg).y;
    assert.ok(dateY < bandY, `${orientation}: the date is drawn at ${dateY}, over a band at ${bandY}`);
  }
});
