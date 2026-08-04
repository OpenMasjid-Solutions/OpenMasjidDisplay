// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** The login limiter must throttle brute force AND be able to forget people.
 *
 *  DISPLAY-011: the sweep condition was `e.lockedUntil < now - 3600000 && e.fails === 0`.
 *  Entries are only created in fail(), which increments `fails` before storing, so every
 *  entry had fails >= 1 and the predicate was unsatisfiable — nothing was ever evicted and
 *  one entry accumulated per distinct client IP for the life of the process. */
import assert from 'node:assert';
import test from 'node:test';
import type { IncomingMessage } from 'node:http';
import { LoginLimiter, RequestLimiter } from './rateLimit';

const from = (ip: string) => ({ socket: { remoteAddress: ip } }) as unknown as IncomingMessage;
const HOUR = 3_600_000;

test('an idle client is eventually forgotten (the map must not grow forever)', () => {
  const lim = new LoginLimiter();
  const now = Date.now();

  lim.fail(from('203.0.113.7'));
  assert.equal(lim.tracked, 1, 'a failed attempt should be tracked');

  // Recently seen → kept. This is the regression guard: pruning must not amnesty someone
  // who is actively guessing.
  lim.prune(now);
  assert.equal(lim.tracked, 1, 'a client seen just now must not be forgotten');

  // Idle for over an hour → dropped. Under the old predicate this stayed forever.
  lim.prune(now + HOUR + 1000);
  assert.equal(lim.tracked, 0, 'an idle client must be evicted');
});

test('many distinct IPs do not accumulate indefinitely', () => {
  const lim = new LoginLimiter();
  for (let i = 0; i < 500; i++) lim.fail(from(`2001:db8::${i.toString(16)}`));
  assert.equal(lim.tracked, 500);
  lim.prune(Date.now() + HOUR + 1000);
  assert.equal(lim.tracked, 0, 'IPv6 gives an effectively unbounded key space — all must clear');
});

test('a client still inside its lockout is never pruned', () => {
  const lim = new LoginLimiter();
  const req = from('198.51.100.9');
  // Past MAX_FREE, so a lockout is in force.
  for (let i = 0; i < 8; i++) lim.fail(req);
  assert.ok(lim.retryAfterMs(req) > 0, 'expected to be locked out after 8 failures');

  // Even pruning far in the future must not release a client whose lockout is still live.
  // (lastSeen is old, but lockedUntil has not passed at that instant.)
  const lockedUntil = Date.now() + lim.retryAfterMs(req);
  lim.prune(lockedUntil - 1);
  assert.equal(lim.tracked, 1, 'pruning must not hand a locked-out client a fresh allowance');
});

test('backoff engages only after MAX_FREE, and a success clears the record', () => {
  const lim = new LoginLimiter();
  const req = from('192.0.2.44');
  for (let i = 0; i < 5; i++) {
    lim.fail(req);
    assert.equal(lim.retryAfterMs(req), 0, `attempt ${i + 1} should still be free`);
  }
  lim.fail(req); // 6th
  const wait = lim.retryAfterMs(req);
  assert.ok(wait > 0, 'the 6th failure should start the backoff');
  assert.ok(wait <= 5 * 60 * 1000, 'a single lockout is capped at 5 minutes');

  lim.succeed(req);
  assert.equal(lim.tracked, 0, 'a successful login forgets the client');
  assert.equal(lim.retryAfterMs(req), 0);
});

// ── RequestLimiter: the public widget's volume cap (DISPLAY-017) ──────────────
test('the request limiter allows a normal viewer and stops a flood', () => {
  const lim = new RequestLimiter(90, 60_000);
  const viewer = from('203.0.113.20');
  // A real embedded widget polls every 30s → ~2 requests a minute.
  for (let i = 0; i < 90; i++) assert.equal(lim.allow(viewer), true, `request ${i + 1} should be allowed`);
  assert.equal(lim.allow(viewer), false, 'the 91st in one window must be refused');
});

// Regression guard: keying the PUBLIC widget on the socket meant every visitor arriving
// through the OpenMasjidOS remote-access tunnel shared ONE bucket, so a masjid's own
// website visitors throttled each other off their own prayer times.
test('visitors behind a shared ingress IP get their own budgets', () => {
  const lim = new RequestLimiter(5, 60_000);
  const ingress = '198.51.100.7'; // every tunnelled request arrives from here
  const behind = (client: string) =>
    ({ headers: { 'x-forwarded-for': `${client}, ${ingress}` }, socket: { remoteAddress: ingress } }) as unknown as IncomingMessage;

  // Exhaust one real visitor's budget.
  const a = behind('203.0.113.10');
  for (let i = 0; i < 5; i++) assert.equal(lim.allow(a), true);
  assert.equal(lim.allow(a), false, 'that visitor is over budget');

  // A DIFFERENT visitor behind the same ingress must be unaffected.
  for (const ip of ['203.0.113.11', '203.0.113.12', '2001:db8::99']) {
    assert.equal(lim.allow(behind(ip)), true, `${ip} must not inherit another visitor's budget`);
  }
});

test('the limiter still works with no forwarding header, and survives a missing socket', () => {
  const lim = new RequestLimiter(2, 60_000);
  const direct = ({ headers: {}, socket: { remoteAddress: '192.0.2.5' } }) as unknown as IncomingMessage;
  assert.equal(lim.allow(direct), true);
  assert.equal(lim.allow(direct), true);
  assert.equal(lim.allow(direct), false, 'a direct LAN hit is still capped');
  // A destroyed socket must not throw (req.socket can be null).
  const noSocket = ({ headers: {} }) as unknown as IncomingMessage;
  assert.doesNotThrow(() => lim.allow(noSocket));
});

test('the request limiter is per IP and its window resets', () => {
  const lim = new RequestLimiter(2, 60_000);
  const a = from('198.51.100.1');
  const b = from('198.51.100.2');
  assert.equal(lim.allow(a), true);
  assert.equal(lim.allow(a), true);
  assert.equal(lim.allow(a), false, 'a is over budget');
  assert.equal(lim.allow(b), true, 'b must be unaffected by a');

  // Pruning expired windows must free the entry (same lesson as DISPLAY-011).
  lim.prune(Date.now() + 60_001);
  assert.equal(lim.tracked, 0, 'expired windows must be evicted');
  assert.equal(lim.allow(a), true, 'a gets a fresh window after it expires');
});

test('clients are tracked separately, so one attacker cannot lock out another IP', () => {
  const lim = new LoginLimiter();
  const attacker = from('203.0.113.1');
  const admin = from('192.168.1.50');
  for (let i = 0; i < 10; i++) lim.fail(attacker);
  assert.ok(lim.retryAfterMs(attacker) > 0);
  assert.equal(lim.retryAfterMs(admin), 0, 'a different IP must be unaffected');
});
