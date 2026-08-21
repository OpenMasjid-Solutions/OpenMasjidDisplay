// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** The "simple" layout's row icons are hand-built SVG paths, not asset files — cheap to draw
 *  and free to recolour/rescale, but with no format to validate them for you. The crescent
 *  moon (Isha) once went invisible this way: a single path tried to share one chord between
 *  an outer arc and an inner "bite" arc of a smaller radius, and that chord was exactly the
 *  outer circle's diameter — too long for the smaller radius to span. SVG doesn't reject that;
 *  it silently scales the radius up until it fits, which made the "bite" the same size as the
 *  disc and erased the crescent. It shipped and looked fine in every code review because
 *  nobody rendered it. These tests render every icon and check the geometry a reviewer can't
 *  eyeball from the source. */
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

/** The bug class this file exists for: a "bite" circle that isn't fully inside the outer
 *  circle doesn't subtract cleanly under fill-rule="evenodd" — it can poke out the far side,
 *  or (the actual incident) get silently rescaled by the SVG arc engine into matching the
 *  outer circle exactly, erasing the crescent. Parsing the two circles back out of the path
 *  and checking containment catches both failure modes without a renderer in the loop. */
test('the crescent moon\'s bite circle is fully inside its disc, at every size', () => {
  for (const r of [3, 4.9, 12, 37.5, 90]) {
    const svg = prayerIcon('isha', 200, 150, r);
    const circles = [...svg.matchAll(/M([\d.-]+) ([\d.-]+) A([\d.-]+) [\d.-]+ 0 1 0/g)].map((m) => ({
      // A circle drawn as `M(x-r) y A r r 0 1 0 ...` — the start point is the LEFT edge,
      // so its own centre is (startX + r, startY).
      cx: Number(m[1]) + Number(m[3]),
      cy: Number(m[2]),
      r: Number(m[3]),
    }));
    assert.equal(circles.length, 2, `expected exactly 2 full-circle subpaths, found ${circles.length}: ${svg}`);
    const [outer, bite] = circles.sort((a, b) => b.r - a.r);
    const centreDist = Math.hypot(outer.cx - bite.cx, outer.cy - bite.cy);
    assert.ok(
      centreDist + bite.r <= outer.r + 1e-6,
      `at r=${r}: the bite circle (r=${bite.r}) isn't fully inside the outer disc (r=${outer.r}) — ` +
        `centre distance ${centreDist} + bite radius ${bite.r} = ${centreDist + bite.r} > ${outer.r}`,
    );
    // And not degenerate the other way — a bite that's nearly the whole disc reproduces the
    // original bug's symptom (nothing visibly left of the crescent) even when it's technically
    // "contained".
    assert.ok(bite.r < outer.r * 0.95, `at r=${r}: the bite (r=${bite.r}) is almost the whole disc (r=${outer.r}) — no crescent would show`);
  }
});
