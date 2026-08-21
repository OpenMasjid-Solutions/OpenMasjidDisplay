// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** The "simple" layout's row icons are hand-built SVG paths, not asset files — cheap to draw
 *  and free to recolour/rescale, but with no format to validate them for you. The crescent
 *  moon (Isha) took three attempts to get right, and none of the ways it was wrong would have
 *  been obvious from reading the source:
 *
 *  1. One path shared a single chord between an outer arc and a smaller-radius "bite" arc.
 *     That chord was exactly the outer circle's diameter — too long for the smaller radius to
 *     span — so SVG silently rescaled the bite arc to match the outer one, erasing the
 *     crescent entirely ("Isha lost its moon icon").
 *  2. Switched to evenodd-subtracting two independent FULL circles, valid only when the bite
 *     circle is entirely contained in the outer one. That constraint caps how deep the cut can
 *     go, so every proportion within it still read as "a circle with a dent", not a crescent
 *     ("still circular" / "still closes").
 *  3. A true boolean subtraction: the outer and bite circles genuinely intersect (the bite is
 *     mostly past the far edge, not contained), and the crescent is bounded by the outer
 *     circle's major arc plus the bite circle's major arc, one closed path, no fill-rule. The
 *     proportions (offset 0.33, bite radius 0.84, both of the outer radius) are fitted from a
 *     real reference crescent-moon icon (measured via its actual pixel mask), not guessed —
 *     and verified by rendering this exact path and checking its filled area against the
 *     analytic area of a circle-minus-circle lune with these proportions: they should (and do)
 *     match to within rounding.
 *
 *  These tests render every icon and check the geometry a reviewer can't eyeball from the
 *  source. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { prayerIcon } from './svg';

const KEYS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha', 'jumuah'];

test('every prayer icon renders something, at a few sizes', () => {
  for (const key of KEYS) {
    for (const r of [4, 12, 40]) {
      const svg = prayerIcon(key, 100, 100, r);
      assert.ok(svg.length > 20, `${key} at r=${r} rendered almost nothing: ${svg}`);
      assert.ok(!/NaN|Infinity|undefined/.test(svg), `${key} at r=${r} produced a bad number: ${svg}`);
    }
  }
});

/** Parse the crescent's single path back into its two arcs' endpoints/radii/flags, at a given
 *  icon radius. Throws (via the assertions) if the path isn't shaped the way `isha` builds it —
 *  which is itself part of what this file is guarding. */
function parseCrescent(svg: string) {
  const m = /^<path d="M([\d.-]+) ([\d.-]+) A([\d.-]+) [\d.-]+ 0 (\d) (\d) ([\d.-]+) ([\d.-]+) A([\d.-]+) [\d.-]+ 0 (\d) (\d) ([\d.-]+) ([\d.-]+) Z" fill="[^"]+"\/>$/.exec(svg);
  assert.ok(m, `crescent path did not match the expected M-A-A-Z shape: ${svg}`);
  const [, h1x, h1y, outerR, outerLarge, outerSweep, h2x, h2y, biteR, biteLarge, biteSweep, h1x2, h1y2] = m!;
  return {
    h1: { x: Number(h1x), y: Number(h1y) },
    h2: { x: Number(h2x), y: Number(h2y) },
    h1closing: { x: Number(h1x2), y: Number(h1y2) },
    outerR: Number(outerR),
    outerFlags: [outerLarge, outerSweep],
    biteR: Number(biteR),
    biteFlags: [biteLarge, biteSweep],
  };
}

test('the crescent moon is a true subtraction, not two full circles under evenodd', () => {
  for (let r = 2; r <= 200; r += 5.3) {
    const svg = prayerIcon('isha', 200, 150, r);
    assert.ok(!/fill-rule/.test(svg), `at r=${r}: no fill-rule should be needed for a real boolean subtraction: ${svg}`);
    const p = parseCrescent(svg);
    // The path must close back to exactly where it started.
    assert.equal(p.h1.x, p.h1closing.x);
    assert.equal(p.h1.y, p.h1closing.y);
    // This EXACT flag pairing is the thing three attempts got wrong in three different ways —
    // see the file header. Pin it so a future edit that changes it has to explain why.
    assert.deepEqual(p.outerFlags, ['1', '1'], `at r=${r}: outer arc flags changed — re-read why they're [1,1]`);
    assert.deepEqual(p.biteFlags, ['1', '0'], `at r=${r}: bite arc flags changed — re-read why they're [1,0]`);
  }
});

test("the crescent's two horn points are exactly where the outer and bite circles cross", () => {
  // Recomputing the intersection independently (rather than trusting the same formula the
  // renderer used) and checking the parsed horn points land on it is what actually catches a
  // wrong radius/offset — the flag check above only catches a wrong ARC CHOICE.
  for (let r = 3; r <= 150; r += 7.1) {
    const cx = 50, cy = 80;
    const svg = prayerIcon('isha', cx, cy, r);
    const p = parseCrescent(svg);
    const moonR = r * 0.95;
    const off = moonR * 0.33;
    const biteR = moonR * 0.84;
    const biteCx = cx + off;
    const biteCy = cy;
    for (const horn of [p.h1, p.h2]) {
      const distOuter = Math.hypot(horn.x - cx, horn.y - cy);
      const distBite = Math.hypot(horn.x - biteCx, horn.y - biteCy);
      assert.ok(Math.abs(distOuter - p.outerR) < 0.2, `at r=${r}: horn (${horn.x},${horn.y}) is ${distOuter} from outer centre, expected ${p.outerR}`);
      assert.ok(Math.abs(distBite - biteR) < 0.2, `at r=${r}: horn (${horn.x},${horn.y}) is ${distBite} from bite centre, expected ${biteR}`);
    }
    assert.ok(Math.abs(p.outerR - moonR) < 0.2);
    assert.ok(Math.abs(p.biteR - biteR) < 0.2);
  }
});

test('the crescent renders as an actual crescent, not a sliver or a near-full disc', () => {
  // The outer/bite circles must genuinely intersect — neither disjoint nor one containing the
  // other — or there'd be no real horns and the "arcs" degenerate. Checked analytically via the
  // standard circle-circle intersection existence condition: |R - r2| < offset < R + r2.
  const offFrac = 0.33, biteFrac = 0.84;
  assert.ok(Math.abs(1 - biteFrac) < offFrac && offFrac < 1 + biteFrac, 'outer and bite circles must actually intersect');

  // And the resulting lune shouldn't be too fat (reads as a dented circle) or too thin (barely
  // visible) — computed analytically (circle-circle lens area) rather than by rasterising, so
  // this runs with no renderer. A real reference crescent icon measured ~0.35 (see file header).
  const R = 1, r2 = biteFrac, d = offFrac;
  const lens =
    R * R * Math.acos((d * d + R * R - r2 * r2) / (2 * d * R)) +
    r2 * r2 * Math.acos((d * d + r2 * r2 - R * R) / (2 * d * r2)) -
    0.5 * Math.sqrt((-d + R + r2) * (d + R - r2) * (d - R + r2) * (d + R + r2));
  const crescentRatio = (Math.PI * R * R - lens) / (Math.PI * R * R);
  assert.ok(crescentRatio > 0.2 && crescentRatio < 0.6, `crescent area ratio ${crescentRatio} is outside a sane "looks like a crescent" range`);
});
