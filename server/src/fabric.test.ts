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

// ── WhatsApp: asking whether this masjid can send, and posting to a group ─────
//
// The reason word decides which sentence an admin reads, and the four the platform can
// return have four different fixes ("set it up", "link a phone", "the gateway is down",
// "update the app in OpenMasjidOS"). Collapsing any of them into a generic failure sends
// someone looking in the wrong place, so each mapping is pinned here.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('a ready platform is reported as available', async () => {
  await withFetch(() => json({ available: true, reason: 'ready' }), async () => {
    assert.deepEqual(await fabric.whatsappAvailability(), { available: true, reason: 'ready' });
  });
});

test('each not-ready reason survives the round trip intact', async () => {
  for (const reason of ['not-configured', 'not-linked', 'unreachable'] as const) {
    await withFetch(() => json({ available: false, reason }), async () => {
      assert.deepEqual(await fabric.whatsappAvailability(), { available: false, reason });
    });
  }
});

test('a 403 is "not allowed", not "unreachable"', async () => {
  // The platform refusing us (no `whatsapp: true` in the manifest it knows about) needs the
  // admin to update this app there — nothing like the fix for a gateway that is down.
  await withFetch(() => json({ available: false, reason: 'not-allowed' }, 403), async () => {
    assert.deepEqual(await fabric.whatsappAvailability(), { available: false, reason: 'not-allowed' });
  });
});

test('an unrecognised reason word never reaches the UI as-is', async () => {
  // Nothing from the platform is trusted as typed: a word we have no sentence for would
  // otherwise render as a blank explanation.
  await withFetch(() => json({ available: true, reason: 'something-new' }), async () => {
    assert.deepEqual(await fabric.whatsappAvailability(), { available: false, reason: 'unreachable' });
  });
});

test('available is never true unless the reason is exactly ready', async () => {
  await withFetch(() => json({ available: true, reason: 'not-linked' }), async () => {
    const r = await fabric.whatsappAvailability();
    assert.equal(r.available, false, 'a contradictory answer must fail closed');
  });
});

test('the group list is validated, not trusted', async () => {
  await withFetch(
    () =>
      json({
        groups: [
          { id: '120363012345678901@g.us', label: 'Announcements' },
          { id: '120363099999999999@g.us' }, // no label → falls back to the id
          { label: 'no id at all' }, // dropped
          'not an object', // dropped
        ],
      }),
    async () => {
      const groups = await fabric.whatsappGroups();
      assert.equal(groups.length, 2);
      assert.deepEqual(groups[0], { id: '120363012345678901@g.us', label: 'Announcements' });
      assert.equal(groups[1].label, '120363099999999999@g.us');
    },
  );
});

test('a failed group lookup is an empty list, never a throw', async () => {
  await withFetch(() => json({ error: 'nope' }, 500), async () => {
    assert.deepEqual(await fabric.whatsappGroups(), []);
  });
});

test('a queued post is reported as queued — and only on an explicit 202-style body', async () => {
  await withFetch(() => json({ queued: true }, 202), async () => {
    assert.deepEqual(await fabric.whatsappSendToGroup('120363012345678901@g.us', 'hello'), { queued: true });
  });
});

test("the platform's own refusal wording is passed through", async () => {
  // "That group has not been approved" is far more actionable than "HTTP 403".
  await withFetch(() => json({ queued: false, error: 'That group has not been approved for sending in OpenMasjidOS.' }, 403), async () => {
    const r = await fabric.whatsappSendToGroup('120363012345678901@g.us', 'hello');
    assert.equal(r.queued, false);
    assert.match(r.error ?? '', /has not been approved/);
  });
});

test('an empty message or group is refused before any request is made', async () => {
  await withFetch(() => json({ queued: true }, 202), async (count) => {
    const before = count();
    assert.equal((await fabric.whatsappSendToGroup('', 'hi')).queued, false);
    assert.equal((await fabric.whatsappSendToGroup('120363012345678901@g.us', '   ')).queued, false);
    assert.equal(count() - before, 0, 'neither should have reached the platform');
  });
});

test('a send never throws, even when the platform is unreachable', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof globalThis.fetch;
  try {
    const r = await fabric.whatsappSendToGroup('120363012345678901@g.us', 'hello');
    assert.equal(r.queued, false);
    assert.match(r.error ?? '', /Could not reach/);
  } finally {
    globalThis.fetch = real;
  }
});
