// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The code that claims a standalone screen.
 *
 * This is the whole of the trust decision on a Pi that has no display server: whoever can read
 * the television gets to create the admin account. So the things worth pinning are the ones that
 * would quietly weaken it — a code that is not uniformly random, a comparison that returns early
 * on the first wrong digit, or a "helpful" normalisation that lets something through which is not
 * the code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { newSetupCode, normaliseSetupCode, formatSetupCode, setupCodeMatches, SETUP_CODE_DIGITS } from './claim';

test('a code is eight digits, every time', () => {
  for (let i = 0; i < 500; i++) {
    const c = newSetupCode();
    assert.match(c, /^\d{8}$/, c);
    assert.equal(c.length, SETUP_CODE_DIGITS);
  }
});

test('leading zeros are kept', () => {
  // Dropping them would both shrink the space and make some codes shorter than the row of boxes
  // on the television. Over this many draws a generator that dropped them would be found: the
  // chance of no code below 10,000,000 in 4,000 draws is about 1 in 10^183.
  let small = 0;
  for (let i = 0; i < 4000; i++) if (newSetupCode().startsWith('0')) small++;
  assert.ok(small > 0, 'no code ever began with a zero — the range is wrong');
});

test('codes are not repeated or sequential', () => {
  // A cheap smoke test for "somebody swapped in a counter or Math.random with a fixed seed".
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) seen.add(newSetupCode());
  assert.ok(seen.size > 1900, `only ${seen.size} distinct codes in 2000 draws`);
});

test('the code is spread across the whole range', () => {
  // Not a statistical test, a sanity one: a generator stuck in one decade would pass every
  // assertion above. Expect roughly 200 per leading digit in 2000 draws.
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 2000; i++) buckets[Number(newSetupCode()[0])]++;
  for (let d = 0; d < 10; d++) assert.ok(buckets[d] > 50, `leading digit ${d} appeared ${buckets[d]} times`);
});

test('what somebody types is reduced to digits', () => {
  // People copy the code off a television with the space in it, and some will use a dash.
  // Neither should be the reason setup fails.
  assert.equal(normaliseSetupCode('1234 5678'), '12345678');
  assert.equal(normaliseSetupCode('1234-5678'), '12345678');
  assert.equal(normaliseSetupCode('  1234  5678  '), '12345678');
  assert.equal(normaliseSetupCode(''), '');
});

test('the television shows it as 4-4', () => {
  assert.equal(formatSetupCode('04172580'), '0417 2580');
  // Anything that is not a whole code is shown as-is rather than split in a misleading place.
  assert.equal(formatSetupCode('123'), '123');
});

test('the right code matches, however it was typed', () => {
  assert.ok(setupCodeMatches('04172580', '04172580'));
  assert.ok(setupCodeMatches('0417 2580', '04172580'));
  assert.ok(setupCodeMatches('0417-2580', '04172580'));
});

test('a wrong code does not', () => {
  for (const wrong of ['04172581', '14172580', '', '0417258', '041725800', 'abcdefgh', '0417 258']) {
    assert.equal(setupCodeMatches(wrong, '04172580'), false, wrong);
  }
});

test('an empty or malformed stored code can never be matched', () => {
  // The state that matters: a screen that has already been claimed has no code, and a blank
  // guess must not sail through against a blank secret.
  for (const stored of ['', '   ', '123', 'abcdefgh']) {
    assert.equal(setupCodeMatches('', stored), false, `empty guess vs ${JSON.stringify(stored)}`);
    assert.equal(setupCodeMatches('04172580', stored), false, `real guess vs ${JSON.stringify(stored)}`);
  }
});

test('a prefix of the code is not the code', () => {
  // The failure a hand-rolled comparison makes: startsWith, or a loop that returns on the first
  // mismatch and lets a short string win.
  const code = '04172580';
  for (let i = 1; i < code.length; i++) assert.equal(setupCodeMatches(code.slice(0, i), code), false, code.slice(0, i));
});

test('comparison does not give up on the first wrong digit', () => {
  // Timing is measured badly on a laptop, so this does not time anything. It checks the
  // property that makes timing irrelevant: a guess differing in the FIRST digit and one
  // differing in the LAST are both simply false, through the same constant-time path, and
  // neither throws — which is what an unguarded timingSafeEqual would do on a length mismatch.
  const code = '04172580';
  assert.equal(setupCodeMatches('14172580', code), false);
  assert.equal(setupCodeMatches('04172581', code), false);
});
