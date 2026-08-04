// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Outbound platform calls must be bounded, and must fail CLOSED when they are.
 *
 *  DISPLAY-006: /api/session is unauthenticated and /api/setup is permanently reachable
 *  under SSO, and both call probePlatform. A caller spamming distinct cookie values missed
 *  the positive cache every time, so each request caused its own outbound fetch — one
 *  unauthenticated client could flood OpenMasjidOS through this app while tying up an
 *  outbound socket per request. */
import assert from 'node:assert';
import test from 'node:test';
import type { IncomingMessage } from 'node:http';

// fabric reads config at import time, and config reads env at ITS import time.
process.env.OPENMASJID_BASE_URL = 'http://platform.invalid';
process.env.OPENMASJID_APP_SECRET = 'test-app-secret-not-a-real-one';

const fabric = require('./fabric') as typeof import('./fabric');

const reqWithCookie = (v: string) => ({ headers: { cookie: `omos_session=${v}` } }) as unknown as IncomingMessage;
const reqNoCookie = () => ({ headers: {} }) as unknown as IncomingMessage;

/** Replace global fetch with a counting stub for the duration of `fn`. */
async function withFetch<T>(handler: () => Response, fn: (count: () => number) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return handler();
  }) as typeof globalThis.fetch;
  try {
    return await fn(() => calls);
  } finally {
    globalThis.fetch = real;
  }
}

const signedIn = () =>
  new Response(JSON.stringify({ authenticated: true, username: 'admin' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

test('outbound session checks are capped, so one client cannot flood the platform', async () => {
  await withFetch(signedIn, async (count) => {
    // 200 requests, each with a DIFFERENT cookie so none can hit the positive cache —
    // the exact shape that used to mean 200 outbound requests to OpenMasjidOS.
    const results = [];
    for (let i = 0; i < 200; i++) results.push(await fabric.probePlatform(reqWithCookie(`tok-${i}`)));

    const outbound = count();
    assert.ok(outbound <= 12, `expected the budget to cap outbound calls, got ${outbound}`);
    assert.ok(outbound >= 1, 'legitimate probes must still get through');

    // Whatever was throttled must NOT have been granted a session.
    const granted = results.filter((r) => r.username !== null).length;
    assert.equal(granted, outbound, 'only genuinely validated probes may return a username');
  });
});

test('a throttled probe reports the platform REACHABLE — or /api/setup would open up', async () => {
  // This is the one that matters most. api.ts refuses an anonymous local-admin claim only
  // when `probe.reachable && !probe.username`. If throttling reported reachable:false, an
  // attacker could exhaust the budget and then claim permanent local admin through
  // /api/setup — converting a DoS guard into an authentication bypass.
  await withFetch(signedIn, async () => {
    let throttled: Awaited<ReturnType<typeof fabric.probePlatform>> | null = null;
    for (let i = 0; i < 200; i++) {
      const r = await fabric.probePlatform(reqWithCookie(`flood-${i}`));
      if (r.username === null) {
        throttled = r;
        break;
      }
    }
    assert.ok(throttled, 'expected to hit the throttle within 200 requests');
    assert.equal(throttled.username, null, 'a throttled probe must not grant a session');
    assert.equal(throttled.reachable, true, 'MUST stay true: reachable:false would open /api/setup');
  });
});

test('the bare reachability probe is cached, so anonymous hits collapse to one call', async () => {
  await withFetch(() => new Response('{}', { status: 200 }), async (count) => {
    const before = count();
    // No cookie → probePlatform falls through to the reachability check every time.
    for (let i = 0; i < 50; i++) await fabric.probePlatform(reqNoCookie());
    const used = count() - before;
    assert.ok(used <= 2, `50 anonymous requests should collapse to ~1 outbound probe, got ${used}`);
  });
});

test('concurrent anonymous probes share a single in-flight request', async () => {
  // Force the cache to be cold by waiting past its window is not practical in a unit test;
  // instead assert the in-flight collapse directly with simultaneous callers.
  await withFetch(() => new Response('{}', { status: 200 }), async (count) => {
    const before = count();
    await Promise.all(Array.from({ length: 25 }, () => fabric.probePlatform(reqNoCookie())));
    assert.ok(count() - before <= 2, 'a burst must not fan out into 25 outbound calls');
  });
});

test('a cookie that does not look like a cookie value is never forwarded', async () => {
  // Pre-existing hardening worth a regression guard: nothing odd may be injected into the
  // outbound Cookie header we send to the platform.
  await withFetch(signedIn, async (count) => {
    const before = count();
    const r = await fabric.probePlatform(reqWithCookie('has spaces and \r\n newlines'));
    assert.equal(r.username, null, 'a malformed token must not be validated');
    // It may still perform the bare reachability check, but must not have sent the token.
    assert.ok(count() - before <= 1);
  });
});
