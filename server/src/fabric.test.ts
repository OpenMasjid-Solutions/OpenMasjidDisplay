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
import fs from 'node:fs';
import path from 'node:path';

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
    assert.deepEqual(await fabric.whatsappAvailability(), { available: true, reason: 'ready', media: false, maxMediaBytes: 0, outcomes: false });
  });
});

test('each not-ready reason survives the round trip intact', async () => {
  for (const reason of ['not-configured', 'not-linked', 'unreachable'] as const) {
    await withFetch(() => json({ available: false, reason }), async () => {
      assert.deepEqual(await fabric.whatsappAvailability(), { available: false, reason, media: false, maxMediaBytes: 0, outcomes: false });
    });
  }
});

test('a 403 is "not allowed", not "unreachable"', async () => {
  // The platform refusing us (no `whatsapp: true` in the manifest it knows about) needs the
  // admin to update this app there — nothing like the fix for a gateway that is down.
  await withFetch(() => json({ available: false, reason: 'not-allowed' }, 403), async () => {
    assert.deepEqual(await fabric.whatsappAvailability(), { available: false, reason: 'not-allowed', media: false, maxMediaBytes: 0, outcomes: false });
  });
});

test('an unrecognised reason word never reaches the UI as-is', async () => {
  // Nothing from the platform is trusted as typed: a word we have no sentence for would
  // otherwise render as a blank explanation.
  await withFetch(() => json({ available: true, reason: 'something-new' }), async () => {
    assert.deepEqual(await fabric.whatsappAvailability(), { available: false, reason: 'unreachable', media: false, maxMediaBytes: 0, outcomes: false });
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

// ── The media capability ─────────────────────────────────────────────────────

test('media support is only believed when the platform says so', async () => {
  await withFetch(() => json({ available: true, reason: 'ready', media: true, maxMediaBytes: 2097152 }), async () => {
    const r = await fabric.whatsappAvailability();
    assert.equal(r.media, true);
    assert.equal(r.maxMediaBytes, 2097152);
  });
});

test('an older platform, with no media field, reads as no media', async () => {
  // Absent MUST be false. Rendering a poster for a platform that cannot take one wastes real
  // work on a Pi, and attaching it would post nothing at all.
  await withFetch(() => json({ available: true, reason: 'ready' }), async () => {
    const r = await fabric.whatsappAvailability();
    assert.equal(r.media, false);
    assert.equal(r.maxMediaBytes, 0);
  });
});

test('a nonsense size cap is treated as unknown rather than trusted', async () => {
  for (const bad of [-1, 0, 'lots', null, Infinity]) {
    await withFetch(() => json({ available: true, reason: 'ready', media: true, maxMediaBytes: bad }), async () => {
      assert.equal((await fabric.whatsappAvailability()).maxMediaBytes, 0, String(bad));
    });
  }
});

test('media is never reported when the platform cannot send at all', async () => {
  await withFetch(() => json({ available: false, reason: 'not-linked', media: true, maxMediaBytes: 999 }, 200), async () => {
    const r = await fabric.whatsappAvailability();
    assert.equal(r.available, false);
    assert.equal(r.reason, 'not-linked');
  });
});

test('an image is sent as base64 alongside the caption', async () => {
  let body: Record<string, unknown> = {};
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init: { body?: string }) => {
    body = JSON.parse(init.body ?? '{}');
    return json({ queued: true }, 202);
  }) as unknown as typeof globalThis.fetch;
  try {
    const media = { data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png' as const, filename: 'x.png' };
    const r = await fabric.whatsappSendToGroup('120363012345678901@g.us', 'caption', media);
    assert.equal(r.queued, true);
    assert.equal(body.group, '120363012345678901@g.us');
    assert.equal(body.text, 'caption');
    assert.deepEqual(body.media, media);
  } finally {
    globalThis.fetch = real;
  }
});

test('a post with an image but no caption is allowed; one with neither is not', async () => {
  // The platform made text optional when media is present — a poster can speak for itself.
  await withFetch(() => json({ queued: true }, 202), async (count) => {
    const media = { data: 'AAAA', mimeType: 'image/png' as const, filename: 'x.png' };
    assert.equal((await fabric.whatsappSendToGroup('120363012345678901@g.us', '', media)).queued, true);
    const before = count();
    assert.equal((await fabric.whatsappSendToGroup('120363012345678901@g.us', '')).queued, false);
    assert.equal(count() - before, 0, 'a post with nothing in it must not reach the platform');
  });
});

// ── The /api/setup invariant depends on this one ─────────────────────────────

test('a 200 with a non-JSON body still reports the platform REACHABLE', async () => {
  // `reachable` is what /api/setup keys on: when it is false, an anonymous local-admin claim
  // is allowed, because that is the recovery path for a platform that is down. A parse failure
  // used to fall through to the catch and report reachable:false — so a platform answering 200
  // with a proxy's HTML error page handed out an unauthenticated admin takeover.
  const html = () => new Response('<!doctype html><h1>502 Bad Gateway</h1>', { status: 200, headers: { 'content-type': 'text/html' } });
  await withFetch(html, async () => {
    const r = await fabric.probePlatform(reqWithCookie('tok-nonjson'));
    assert.equal(r.reachable, true, 'a reply is a reply — the platform answered');
    assert.equal(r.username, null, 'but nobody is signed in by an unparseable body');
  });
});

test('a truncated JSON body is treated the same way', async () => {
  const cut = () => new Response('{"authenticated":tr', { status: 200, headers: { 'content-type': 'application/json' } });
  await withFetch(cut, async () => {
    const r = await fabric.probePlatform(reqWithCookie('tok-trunc'));
    assert.equal(r.reachable, true);
    assert.equal(r.username, null);
  });
});

test('a platform that REDIRECTS is reachable, so /api/setup stays shut', () => {
  // The reachability probe feeds a decision that fails OPEN: `/api/setup` accepts an anonymous
  // local-admin claim only when the platform is unreachable. So anything that wrongly reports
  // "unreachable" is an unauthenticated admin takeover, and a 3xx is not unreachable — an admin
  // putting an http->https upgrade in front of the dashboard is enough to produce one.
  //
  // `redirect: 'manual'` is what makes a 3xx an ANSWER rather than a thrown error. It is the one
  // outbound call here that is not 'error', and that is deliberate: it does not follow the
  // redirect either (verified), and unlike every other call in this file it sends no credential,
  // so the hazard 'error' exists to stop — our app secret bounced at another internal host — does
  // not arise. Do not "restore" it to 'error' on the strength of CLAUDE.md's general rule.
  const src = fs.readFileSync(path.join(__dirname, 'fabric.ts'), 'utf8');
  const fn = src.slice(src.indexOf('async function platformReachable'));
  const body = fn.slice(0, fn.indexOf(String.fromCharCode(10) + '}'));
  assert.match(body, /redirect: 'manual'/, 'the reachability probe must not throw on a redirect');
  assert.ok(!body.includes("redirect: 'error'"), 'and must not use error, which caches ok:false');
  assert.ok(!/x-openmasjid-app-secret/i.test(body), 'it must stay credential-free for that to be safe');

  // Every OTHER outbound call keeps 'error'. Counted so a new credential-bearing call cannot
  // quietly adopt 'manual' by copying the probe above it.
  // Comments stripped: the note above the probe necessarily quotes both spellings.
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
  const fetches = [...code.matchAll(/redirect: '(error|manual|follow)'/g)].map((m) => m[1]);
  assert.equal(fetches.filter((r) => r === 'manual').length, 1, 'exactly one manual: the probe');
  assert.equal(fetches.filter((r) => r === 'follow').length, 0, 'nothing may follow a redirect');
  assert.ok(fetches.filter((r) => r === 'error').length >= 8, 'every credential-bearing call stays error');
});
