// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The full date, on a panel that draws it as one line.
 *
 * Reported as text spilling out of its box on a screen, and it only happened sometimes — which is
 * what made it hard to pin down. It needs BOTH the narrow clock panel (the burn-in rotation changes
 * layout every five minutes) AND a long date. "Sunday, May 3, 2026" is nineteen characters and
 * fits; "Wednesday, September 30, 2026" is twenty-nine and did not.
 *
 * The clock in that same panel had always shrunk itself to fit. The date lines simply never did.
 *
 * Worth a test of its own because this is the SHARED renderer: the same overflow was on every
 * screen type, not just the Raspberry Pi where it happened to be noticed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { approxWidth } from './svg';

/** The measurement the renderer itself uses, and the shrink it now applies. */
function fittedSize(greg: string, hij: string, panelW: number, panelH: number): number {
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  const pad = panelW * 0.06;
  const avail = panelW - 2 * pad;
  let ds = clamp(panelH * 0.11, 12, 26);
  const widest = Math.max(approxWidth(greg, ds), approxWidth(hij, ds * 0.98));
  if (widest > avail) ds *= avail / widest;
  return ds;
}

const HIJRI = 'Rabi` I 6, 1448 AH';
const LONG = 'Wednesday, September 30, 2026'; // the longest English form
const SHORT = 'Sunday, May 3, 2026';

test('the longest date fits a narrow panel', () => {
  const w = 360;
  const h = 300;
  const avail = w - 2 * (w * 0.06);
  const size = fittedSize(LONG, HIJRI, w, h);
  assert.ok(
    approxWidth(LONG, size) <= avail + 0.5,
    `still ${approxWidth(LONG, size).toFixed(0)} wide in ${avail.toFixed(0)} of space`,
  );
});

test('a date that already fits is not shrunk', () => {
  // The other half of the fix. Scaling text that had room would make every wide screen worse in
  // order to help one narrow one.
  const w = 460;
  const h = 340;
  assert.equal(fittedSize(SHORT, HIJRI, w, h), 26, 'a short date on a wide panel keeps full size');
});

test('a long date is drawn smaller than a short one on the same panel', () => {
  // The observable consequence: the layout gives way, not the box.
  const w = 340;
  const h = 280;
  assert.ok(fittedSize(LONG, HIJRI, w, h) < fittedSize(SHORT, HIJRI, w, h));
});

test('the Hijri line is measured too, so the two lines stay the same size', () => {
  // Shrinking only the offending line would read as a mistake rather than a fit.
  const w = 300;
  const h = 260;
  const avail = w - 2 * (w * 0.06);
  const size = fittedSize(LONG, HIJRI, w, h);
  assert.ok(approxWidth(HIJRI, size * 0.98) <= avail + 0.5);
});

test('every weekday and month combination fits', () => {
  // Rather than trusting the one date that was reported, walk the whole space: 7 weekdays x 12
  // months x a two-digit day is the worst case for each.
  const w = 320;
  const h = 270;
  const avail = w - 2 * (w * 0.06);
  const fmt = new Intl.DateTimeFormat('en', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
  let worst = '';
  let worstW = 0;
  for (let m = 0; m < 12; m++) {
    for (let d = 20; d <= 28; d++) {
      const s = fmt.format(new Date(Date.UTC(2026, m, d, 12)));
      const size = fittedSize(s, HIJRI, w, h);
      const drawn = approxWidth(s, size);
      if (drawn > worstW) {
        worstW = drawn;
        worst = s;
      }
      assert.ok(drawn <= avail + 0.5, `${s} overflows: ${drawn.toFixed(0)} > ${avail.toFixed(0)}`);
    }
  }
  assert.ok(worst.length > 0);
});
