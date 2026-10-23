// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Adopting a Raspberry Pi by its address — the half that decides where this server will connect.
 *
 * This is the only route in the app where an address typed into the panel becomes an outbound
 * connection carrying a credential. So the tests are about refusal and about ORDER:
 *
 *   • an address that resolves anywhere public is refused before anything is sent;
 *   • nothing of ours leaves until the screen has accepted the admin's password;
 *   • a redirect is never followed, because following one is how an address that passed the
 *     private check delivers us somewhere that would not have.
 *
 * The handshake is exercised against a real HTTP server on the loopback interface rather than a
 * stubbed `fetch`. The behaviours that matter here — a redirect, several `set-cookie` headers, a
 * connection that is accepted and then goes silent — are properties of the HTTP stack, and a stub
 * of it would be a test of my own assumptions about them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  parseLinkAddress,
  isPrivateAddress,
  resolveLinkTarget,
  piPanelSignIn,
  piPanelHandOver,
} from './piLink';

// ── the address somebody typed ───────────────────────────────────────────────

test('a bare address is read as the screen panel it is', () => {
  // A Pi's panel is port 80 over plain HTTP with no certificate, so the scheme that gets assumed
  // is the one that actually works. Anything else would make the common case the one that fails.
  for (const [typed, want] of [
    ['192.168.1.30', 'http://192.168.1.30'],
    ['  192.168.1.30  ', 'http://192.168.1.30'],
    ['//192.168.1.30', 'http://192.168.1.30'],
    ['screen.local', 'http://screen.local'],
    ['192.168.1.30:8080', 'http://192.168.1.30:8080'],
    ['http://192.168.1.30/settings', 'http://192.168.1.30'],
    ['https://screen.local:8443', 'https://screen.local:8443'],
    // Default ports are dropped by URL.origin, which is right: it is the same screen either way.
    ['http://192.168.1.30:80', 'http://192.168.1.30'],
  ] as const) {
    const got = parseLinkAddress(typed);
    assert.ok(!('error' in got), `${typed} should be accepted: ${JSON.stringify(got)}`);
    assert.equal(got.origin, want, typed);
  }
});

test('anything that is not a web address is refused, not coerced into one', () => {
  for (const bad of [
    '',
    '   ',
    'file:///etc/passwd',
    'gopher://host',
    'ftp://192.168.1.30',
    'javascript:alert(1)',
    // Credentials in the address would be sent as part of the URL rather than as the password,
    // which silently does something other than what the form says.
    'http://admin:hunter2@192.168.1.30',
    // A space is the one that URL() would quietly percent-encode into a path instead of refusing.
    '192.168.1.30 please',
    'a'.repeat(300),
    42,
    null,
    undefined,
    { toString: () => 'http://192.168.1.30' },
  ]) {
    assert.ok('error' in parseLinkAddress(bad), `${JSON.stringify(String(bad))} should be refused`);
  }
});

test('the hostname comes back separately, and unbracketed', () => {
  // The privacy check is asked about the HOST and nothing else, and re-deriving it at the call
  // site is how the two end up disagreeing about an IPv6 literal.
  const v6 = parseLinkAddress('http://[fd00::1]:7860');
  assert.ok(!('error' in v6));
  assert.equal(v6.hostname, 'fd00::1');
  assert.equal(v6.origin, 'http://[fd00::1]:7860');
});

// ── which addresses are on this network ──────────────────────────────────────

test('private address ranges are judged on the parsed address, not on the name', () => {
  for (const ok of [
    '10.0.0.5',
    '10.255.255.255',
    '127.0.0.1',
    '192.168.1.30',
    '172.16.0.1',
    '172.31.255.254',
    '169.254.1.1', // link-local — and where a cloud metadata service lives
    '100.64.0.1', // carrier-grade NAT
    '::1',
    'fd00::1',
    'fc00::1',
    'fe80::1',
    '::ffff:192.168.1.30', // the same machine wearing an IPv6 hat
    // …and the SAME address in hex, which is what `new URL` normalises a typed literal into.
    // Measured: `http://[::ffff:127.0.0.1]` arrives as `::ffff:7f00:1`, and without this it was
    // judged public — refusing an admin's own screen with a sentence that was simply untrue.
    '::ffff:7f00:1', // 127.0.0.1
    '::ffff:c0a8:11e', // 192.168.1.30
    '::ffff:ac10:1', // 172.16.0.1
  ]) {
    assert.equal(isPrivateAddress(ok), true, `${ok} is a private address`);
  }
  for (const no of [
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1', // just below the block
    '172.32.0.1', // just above it
    '192.169.1.1',
    '100.128.0.1', // just above CGNAT
    '2606:4700::1111',
    '::ffff:8.8.8.8',
    '::ffff:808:808', // 8.8.8.8 in hex — the mapping must not make a public address private
    'fec0::1', // deprecated site-local: not a range this allows, and refusing is the safe way to be wrong
    '999.1.1.1',
    'not-an-address',
    '',
  ]) {
    assert.equal(isPrivateAddress(no), false, `${no} is NOT a private address`);
  }
});

/** The resolver guard, asked the way the route asks it. */
const resolve = (host: string) => resolveLinkTarget({ origin: `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}`, hostname: host });

test('an address on the public internet is refused', async () => {
  // Resolved, not guessed from the spelling. `pi/lanHost.ts` says of itself that it is a heuristic
  // about names rather than a security check, and it is right — this is the other thing.
  //
  // Checked against LITERALS rather than a real public name on purpose: `dns.lookup` short-circuits
  // a literal, so this asserts the refusal without the test depending on a working resolver. A
  // network-dependent test in CI fails for reasons that have nothing to do with the code.
  for (const host of ['8.8.8.8', '2606:4700:4700::1111']) {
    const r = await resolve(host);
    assert.ok('error' in r, `${host} must be refused`);
    assert.match(r.error, /public internet/);
  }
});

test('a link-local address is refused, and not called public', async () => {
  // It is as private as an address gets, so `isPrivateAddress` says true and is right to. It is
  // refused one level up for a different reason: 169.254/16 is what a machine gives itself when
  // DHCP fails, so a screen there is not a working screen — and it is where cloud metadata
  // services live, which makes it the one private range worth probing.
  for (const host of ['169.254.169.254', '169.254.1.1', 'fe80::1']) {
    assert.equal(isPrivateAddress(host), true, `${host} really is private`);
    const r = await resolve(host);
    assert.ok('error' in r, `${host} must still be refused`);
    assert.match(r.error, /link-local/);
    assert.doesNotMatch(r.error, /public internet/, 'calling it public would be a lie');
  }
});

test('a screen that already belongs to a server says so, not "wrong password"', async () => {
  // An adopted screen serves the read-only panel, which answers nothing but GET and HEAD — so the
  // sign-in is refused by the METHOD, before any password is looked at. Reported on real hardware
  // as "answered unexpectedly (HTTP 405)", which sends an admin looking for a password problem
  // that is not there.
  const pi = await fakePi({
    '/api/login': (_q, res) => {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end('{"error":"This screen is managed by a Display server. Change it there."}');
    },
  });
  try {
    const r = await piPanelSignIn(pi.origin, pi.origin, 'pw', AbortSignal.timeout(5000));
    assert.ok('error' in r);
    assert.equal(r.status, 409);
    assert.match(r.error, /already managed by a display server/i);
  } finally {
    await pi.close();
  }
});

test('the address that was CHECKED is the address that gets connected to', async () => {
  // The whole point of resolving here rather than letting `fetch` do it. Checking a NAME and then
  // handing that name to fetch resolves it twice, and nothing makes the two answers agree — a
  // record that is private for the check and public for the connection walks through a guard
  // written that way, and what is posted on the other side of it is a device token.
  //
  // `localhost` is the case that shows it: a NAME, resolved here, and what comes back must be the
  // literal it resolved to rather than the name, because a name handed onward is a name resolved
  // again.
  const r = await resolve('localhost');
  assert.ok(!('error' in r));
  const host = new URL(r.origin).hostname;
  assert.notEqual(host, 'localhost', 'the name must not survive into the address we connect to');
  assert.ok(isPrivateAddress(host.replace(/^\[|\]$/g, '')), `connected host ${host} must be the private literal`);
  assert.equal(r.display, 'http://localhost', 'but the admin is still told what they typed');
});

test('a port survives resolution, and an IPv6 literal keeps its brackets', () => {
  // Rebuilding the origin around a new host is where both of these get dropped. A screen on a
  // non-default port would be connected to on port 80, and an unbracketed IPv6 host does not
  // parse at all.
  return (async () => {
    const withPort = await resolveLinkTarget({ origin: 'http://127.0.0.1:8080', hostname: '127.0.0.1' });
    assert.ok(!('error' in withPort));
    assert.equal(withPort.origin, 'http://127.0.0.1:8080');

    const v6 = await resolveLinkTarget({ origin: 'http://[::1]:7860', hostname: '::1' });
    assert.ok(!('error' in v6), JSON.stringify(v6));
    assert.equal(v6.origin, 'http://[::1]:7860');
  })();
});

test('loopback and a name that does not resolve are told apart', async () => {
  // Both resolve out of the hosts file or fail outright, so neither needs a resolver either.
  assert.deepEqual(await resolve('127.0.0.1'), { origin: 'http://127.0.0.1', display: 'http://127.0.0.1' });
  const named = await resolve('localhost');
  assert.ok(!('error' in named), 'localhost resolves privately');
  const gone = await resolve('this-host-does-not-exist.invalid');
  assert.ok('error' in gone, 'an unresolvable name must be refused');
  assert.match(gone.error, /Nothing on this network answers/);
});

// ── the handshake with the screen ────────────────────────────────────────────

/** A stand-in for a Pi's own panel, on loopback, answering however the test wants. */
async function fakePi(
  routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>,
): Promise<{ origin: string; seen: { path: string; cookie: string; body: string }[]; close: () => Promise<void> }> {
  const seen: { path: string; cookie: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        path: req.url ?? '',
        cookie: String(req.headers.cookie ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const route = routes[req.url ?? ''];
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"Not found."}');
        return;
      }
      route(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const ok = (res: http.ServerResponse, cookies: string[] = ['omd=abc; HttpOnly; Path=/']): void => {
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookies });
  res.end('{"ok":true}');
};

test('signing in carries the password, and comes back with the session', async () => {
  const pi = await fakePi({ '/api/login': (_q, res) => ok(res) });
  try {
    const r = await piPanelSignIn(pi.origin, pi.origin, 'a-good-password', AbortSignal.timeout(5000));
    assert.ok(!('error' in r), JSON.stringify(r));
    assert.equal(r.cookie, 'omd=abc');
    assert.deepEqual(JSON.parse(pi.seen[0].body), { password: 'a-good-password' });
  } finally {
    await pi.close();
  }
});

test('several Set-Cookie headers are kept apart rather than spliced into one', async () => {
  // Reading the joined header string would produce `omd=abc, other=1`, which matches neither
  // cookie and would make the handover fail with a 401 nobody could explain.
  const pi = await fakePi({
    '/api/login': (_q, res) => ok(res, ['omd=abc; Path=/', 'other=1; Path=/']),
  });
  try {
    const r = await piPanelSignIn(pi.origin, pi.origin, 'pw', AbortSignal.timeout(5000));
    assert.ok(!('error' in r));
    assert.equal(r.cookie, 'omd=abc; other=1');
  } finally {
    await pi.close();
  }
});

test('each way a sign-in can fail gets its own sentence, and none of them is a 500', async () => {
  for (const [code, want] of [
    [401, /password was not accepted/],
    [429, /refusing sign-ins/],
    [400, /has not been set up yet/],
    [503, /answered unexpectedly/],
  ] as const) {
    const pi = await fakePi({
      '/api/login': (_q, res) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end('{}');
      },
    });
    try {
      const r = await piPanelSignIn(pi.origin, pi.origin, 'pw', AbortSignal.timeout(5000));
      assert.ok('error' in r, `HTTP ${code} should fail`);
      assert.match(r.error, want);
      assert.notEqual(r.status, 500, 'a screen behaving badly is not this server being broken');
    } finally {
      await pi.close();
    }
  }
});

test('a 200 with no session is refused — that is not one of our panels', async () => {
  const pi = await fakePi({
    '/api/login': (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>some other device</h1>');
    },
  });
  try {
    const r = await piPanelSignIn(pi.origin, pi.origin, 'pw', AbortSignal.timeout(5000));
    assert.ok('error' in r);
    assert.match(r.error, /issued no session/);
  } finally {
    await pi.close();
  }
});

test('a redirect is never followed, however inviting', async () => {
  // This is the one that matters most. The address passed the private check; a redirect is how it
  // would then deliver us — and the credential — to a host that would not have.
  //
  // The redirect points at a SECOND server that would answer perfectly. That is deliberate: aimed
  // at something unreachable the request fails either way, so the test would pass against a
  // `redirect: 'follow'` it was meant to catch. Checked by making exactly that change.
  const elsewhere = await fakePi({ '/api/login': (_q, res) => ok(res, ['stolen=yes; Path=/']) });
  const pi = await fakePi({
    '/api/login': (_q, res) => {
      res.writeHead(302, { location: `${elsewhere.origin}/api/login` });
      res.end();
    },
  });
  try {
    const r = await piPanelSignIn(pi.origin, pi.origin, 'pw', AbortSignal.timeout(5000));
    assert.ok('error' in r, 'a redirect must not be followed into a success');
    assert.equal(r.status, 502);
    assert.deepEqual(elsewhere.seen, [], 'and the host it pointed at was never contacted');
  } finally {
    await pi.close();
    await elsewhere.close();
  }
});

test('nothing reaches the screen until it has accepted the password', async () => {
  // The order IS the security of this: the credential is created and sent only after the screen
  // has proved both that the admin administers it and that it is one of our panels at all.
  const pi = await fakePi({
    '/api/login': (_q, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{}');
    },
  });
  try {
    const r = await piPanelSignIn(pi.origin, pi.origin, 'wrong', AbortSignal.timeout(5000));
    assert.ok('error' in r);
    assert.equal(pi.seen.length, 1, 'exactly one request, and it was the sign-in');
    assert.equal(pi.seen[0].path, '/api/login');
    assert.ok(!pi.seen.some((s) => s.body.includes('token')), 'no token may have been sent');
  } finally {
    await pi.close();
  }
});

test('the handover carries the session and the whole credential set', async () => {
  const pi = await fakePi({
    '/api/login': (_q, res) => ok(res),
    '/api/pi/link': (_q, res) => ok(res, []),
  });
  try {
    const session = await piPanelSignIn(pi.origin, pi.origin, 'pw', AbortSignal.timeout(5000));
    assert.ok(!('error' in session));
    const payload = { server: 'http://masjid.lan:7860', deviceId: 'pi_1', deviceSecret: 'sec', token: 'tok' };
    const r = await piPanelHandOver(pi.origin, session.cookie, payload, AbortSignal.timeout(5000));
    assert.deepEqual(r, { ok: true, previousDeviceId: '' }, 'this fixture reports no previous id');
    const handover = pi.seen.find((s) => s.path === '/api/pi/link')!;
    assert.equal(handover.cookie, 'omd=abc', 'the session from the sign-in must be presented');
    assert.deepEqual(JSON.parse(handover.body), payload);
  } finally {
    await pi.close();
  }
});

test('a screen too old to know this route says so, rather than reporting a mystery', async () => {
  const pi = await fakePi({ '/api/login': (_q, res) => ok(res) });
  try {
    const session = await piPanelSignIn(pi.origin, pi.origin, 'pw', AbortSignal.timeout(5000));
    assert.ok(!('error' in session));
    const r = await piPanelHandOver(
      pi.origin,
      session.cookie,
      { server: 's', deviceId: 'd', deviceSecret: 's', token: 't' },
      AbortSignal.timeout(5000),
    );
    assert.ok('error' in r);
    assert.match(r.error, /too old to be adopted this way/);
  } finally {
    await pi.close();
  }
});

test('a screen that accepts the connection and then goes quiet does not hang the request', async () => {
  // Without the shared deadline this holds an admin's browser open for as long as the screen
  // likes, and holds a connection open on this server for the same length of time.
  const pi = await fakePi({ '/api/login': () => {} });
  try {
    const started = Date.now();
    const r = await piPanelSignIn(pi.origin, pi.origin, 'pw', AbortSignal.timeout(300));
    assert.ok('error' in r);
    assert.ok(Date.now() - started < 3000, 'it must give up when the deadline says so');
    assert.match(r.error, /Could not reach a screen/);
  } finally {
    await pi.close();
  }
});

test('the screen reports which id it is giving up, and a lie about it is bounded', async () => {
  // Adopting by address mints a fresh identity, so the screen's old pending row would otherwise
  // sit in the dashboard with a code that still looks live. The id is a device's word for what it
  // used to be called, which is why the caller only ever drops a row that has no token.
  for (const [sent, want] of [
    ['{"ok":true,"previousDeviceId":"pi_old"}', 'pi_old'],
    ['{"ok":true}', ''],
    ['not json at all', ''],
    [`{"ok":true,"previousDeviceId":${JSON.stringify('x'.repeat(200))}}`, 'x'.repeat(64)],
    ['{"ok":true,"previousDeviceId":{"nice":"try"}}', ''],
  ] as const) {
    const pi = await fakePi({
      '/api/login': (_q, res) => ok(res),
      '/api/pi/link': (_q, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(sent);
      },
    });
    try {
      const session = await piPanelSignIn(pi.origin, pi.origin, 'pw', AbortSignal.timeout(5000));
      assert.ok(!('error' in session));
      const r = await piPanelHandOver(
        pi.origin,
        session.cookie,
        { server: 's', deviceId: 'd', deviceSecret: 's', token: 't' },
        AbortSignal.timeout(5000),
      );
      assert.ok('ok' in r, sent);
      assert.equal(r.previousDeviceId, want, sent);
    } finally {
      await pi.close();
    }
  }
});
