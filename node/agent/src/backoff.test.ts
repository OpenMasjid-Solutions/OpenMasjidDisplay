// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBackoff, MIN_DELAY_MS, MAX_DELAY_MS } from './backoff';

test('delays grow but stay inside the bounds, forever', () => {
  const b = makeBackoff(() => 1); // always the top of the range
  const seen: number[] = [];
  for (let i = 0; i < 40; i++) seen.push(b.next());
  assert.equal(seen[0], MIN_DELAY_MS, 'the first retry is immediate-ish — most outages are a restart');
  assert.ok(seen[1] > seen[0], 'it backs off');
  for (const d of seen) {
    assert.ok(d >= MIN_DELAY_MS && d <= MAX_DELAY_MS, `${d} out of bounds`);
  }
  // The cap is what makes it never give up: attempt 40 must still be a sane delay, not
  // hours. A node whose controller is down for a week has to reconnect unattended.
  assert.equal(seen[39], MAX_DELAY_MS);
});

test('jitter spreads a fleet that all failed at the same instant', () => {
  // Twenty nodes lose the controller together (a container update). Without jitter they
  // would all retry in lockstep and hammer it exactly as it tries to start.
  const values = new Set<number>();
  for (let node = 0; node < 20; node++) {
    const b = makeBackoff(() => node / 20);
    b.next();
    b.next();
    b.next();
    values.add(b.next());
  }
  assert.ok(values.size > 10, `expected spread, got ${values.size} distinct delays`);
});

test('a successful connection returns to fast retries', () => {
  const b = makeBackoff(() => 1);
  for (let i = 0; i < 10; i++) b.next();
  assert.equal(b.attempts, 10);
  b.reset();
  assert.equal(b.attempts, 0);
  assert.equal(b.next(), MIN_DELAY_MS, 'after a good connection the next blip retries quickly');
});

test('delays are whole milliseconds', () => {
  const b = makeBackoff(() => 0.3333333);
  for (let i = 0; i < 8; i++) assert.equal(b.next() % 1, 0);
});
