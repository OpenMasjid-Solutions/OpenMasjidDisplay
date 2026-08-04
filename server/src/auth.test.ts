// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Session cookie / token handling, and the crash it used to be possible to cause.
 *
 *  DISPLAY-001: `GET /ws` carrying `Cookie: omd_session=%` made decodeURIComponent throw
 *  inside the server's 'upgrade' listener. A throw there is an UNCAUGHT exception, so the
 *  whole app exited — an unauthenticated remote kill switch, loopable, taking every screen
 *  in the masjid down with it. */
import assert from 'node:assert';
import test from 'node:test';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import {
  hasValidSession,
  hasValidVolunteerSession,
  makeToken,
  makeVolunteerToken,
  isSecureRequest,
  setCookieHeader,
  clearCookieHeader,
  setVolunteerCookieHeader,
  clearVolunteerCookieHeader,
} from './auth';
import { WsHub } from './ws';

const SECRET = crypto.randomBytes(32);

/** A bare IncomingMessage-alike carrying just a Cookie header. */
const reqWith = (cookie?: string) =>
  ({ headers: cookie === undefined ? {} : { cookie } }) as unknown as IncomingMessage;

// ── The cookie parser must never throw on a hostile header ────────────────────
test('a malformed percent-escape in a cookie does not throw (it just fails to auth)', () => {
  // Every one of these makes bare decodeURIComponent throw.
  for (const bad of ['%', '%z', '%1', 'a%', '%E0%A4%A', '%%', '100%']) {
    assert.doesNotThrow(() => hasValidSession(reqWith(`omd_session=${bad}`), SECRET), `threw on ${bad}`);
    assert.equal(hasValidSession(reqWith(`omd_session=${bad}`), SECRET), false, `authed on ${bad}`);
    assert.doesNotThrow(() => hasValidVolunteerSession(reqWith(`omd_vol=${bad}`), SECRET), `vol threw on ${bad}`);
  }
});

test('a malformed OTHER cookie does not stop a valid session cookie being read', () => {
  // Browsers send unrelated cookies; one bad neighbour must not deny a real session.
  const good = makeToken(SECRET);
  assert.equal(hasValidSession(reqWith(`junk=%; omd_session=${good}`), SECRET), true);
  assert.equal(hasValidSession(reqWith(`omd_session=${good}; junk=%E0%A4%A`), SECRET), true);
});

test('valid, tampered, foreign-secret and cross-audience tokens behave (no regression)', () => {
  const other = crypto.randomBytes(32);
  assert.equal(hasValidSession(reqWith(`omd_session=${makeToken(SECRET)}`), SECRET), true);
  assert.equal(hasValidSession(reqWith(`omd_session=${makeToken(other)}`), SECRET), false);
  assert.equal(hasValidSession(reqWith('omd_session=not.a.token'), SECRET), false);
  assert.equal(hasValidSession(reqWith('omd_session='), SECRET), false);
  assert.equal(hasValidSession(reqWith(''), SECRET), false);
  assert.equal(hasValidSession(reqWith(), SECRET), false);
  // An expired token must not pass.
  assert.equal(hasValidSession(reqWith(`omd_session=${makeToken(SECRET, -1000)}`), SECRET), false);
  // Audience binding: a volunteer token is not an admin session, in either direction.
  const vol = makeVolunteerToken(SECRET);
  assert.equal(hasValidSession(reqWith(`omd_session=${vol}`), SECRET), false);
  assert.equal(hasValidVolunteerSession(reqWith(`omd_vol=${makeToken(SECRET)}`), SECRET), false);
  assert.equal(hasValidVolunteerSession(reqWith(`omd_vol=${vol}`), SECRET), true);
});

// ── Secure attribute, decided per request (DISPLAY-005) ───────────────────────
const reqOver = (proto?: string, encrypted = false) =>
  ({
    headers: proto === undefined ? {} : { 'x-forwarded-proto': proto },
    socket: { encrypted },
  }) as unknown as IncomingMessage;

test('a cookie is marked Secure for an HTTPS request and not for plain HTTP', () => {
  // Behind the platform's TLS proxy (manifest https: true) the ingress sets and sanitises
  // X-Forwarded-Proto, so an HTTPS visitor's 30-day admin cookie must not go out bare.
  assert.equal(isSecureRequest(reqOver('https')), true);
  assert.equal(setCookieHeader(makeToken(SECRET), undefined, true).includes('; Secure'), true);

  // …and the plain-HTTP LAN flow this app ships in must keep working. A Secure cookie is
  // silently never sent over http, so getting this wrong locks the admin out entirely.
  assert.equal(isSecureRequest(reqOver('http')), false);
  assert.equal(isSecureRequest(reqOver()), false, 'no header, plain socket → not secure');
  assert.equal(setCookieHeader(makeToken(SECRET), undefined, false).includes('Secure'), false);
});

test('a direct TLS socket counts as secure even with no proxy header', () => {
  assert.equal(isSecureRequest(reqOver(undefined, true)), true);
});

test('a comma-joined X-Forwarded-Proto uses the first (client-facing) hop', () => {
  // Chained proxies append, so the value can be "https, http".
  assert.equal(isSecureRequest(reqOver('https, http')), true);
  assert.equal(isSecureRequest(reqOver('http, https')), false);
  assert.equal(isSecureRequest(reqOver('  HTTPS  ')), true, 'case and padding must not matter');
});

test('clearing a cookie mirrors the Secure attribute, and the volunteer cookie behaves too', () => {
  assert.ok(clearCookieHeader(true).some((c) => c.includes('; Secure')));
  assert.ok(clearCookieHeader(false).every((c) => !c.includes('Secure')));
  assert.equal(setVolunteerCookieHeader(makeVolunteerToken(SECRET), true).includes('; Secure'), true);
  assert.equal(setVolunteerCookieHeader(makeVolunteerToken(SECRET), false).includes('Secure'), false);
  assert.ok(clearVolunteerCookieHeader(true).some((c) => c.includes('; Secure')));
});

// ── The dual-port cookie-jar trap (regression guard) ──────────────────────────
// Cookies are keyed by (name, domain, path) and ignore the PORT, and this app is published
// on both a TLS-proxied port and a plain-HTTP port of the SAME host. With one shared name,
// the HTTPS cookie (Secure) could neither be received NOR REPLACED on the HTTP port —
// browsers refuse a non-Secure Set-Cookie that would overwrite a Secure one ("Leave Secure
// Cookies Alone"). The admin bounced back to the login form after a CORRECT password, with
// no way out. Separate names per scheme are what prevent that.
test('the HTTPS and plain-HTTP session cookies use DIFFERENT names so they cannot collide', () => {
  const https = setCookieHeader(makeToken(SECRET), undefined, true);
  const http = setCookieHeader(makeToken(SECRET), undefined, false);
  const nameOf = (c: string) => c.slice(0, c.indexOf('='));
  assert.notEqual(nameOf(https), nameOf(http), 'one shared name is what caused the lockout');
  assert.match(https, /^omd_session_s=/);
  assert.match(http, /^omd_session=/);
  // Same for the volunteer page, which is served on a proxied path AND an unproxied port.
  assert.notEqual(
    nameOf(setVolunteerCookieHeader(makeVolunteerToken(SECRET), true)),
    nameOf(setVolunteerCookieHeader(makeVolunteerToken(SECRET), false)),
  );
});

test('an HTTP login still works when an HTTPS session already exists (the lockout)', () => {
  const httpsTok = makeToken(SECRET);
  const httpTok = makeToken(SECRET);
  // The browser's jar after using BOTH entry points: the Secure cookie is only ever sent
  // over HTTPS, the plain one over either.
  const overHttp = (cookie: string) =>
    ({ headers: { cookie }, socket: {} }) as unknown as IncomingMessage;
  const overHttps = (cookie: string) =>
    ({ headers: { cookie, 'x-forwarded-proto': 'https' }, socket: {} }) as unknown as IncomingMessage;

  // The decisive assertion: with an HTTPS session already stored, a fresh HTTP session
  // authenticates. Before the fix the HTTP cookie could not be stored at all.
  assert.equal(hasValidSession(overHttp(`omd_session=${httpTok}`), SECRET), true);
  assert.equal(
    hasValidSession(overHttps(`omd_session_s=${httpsTok}; omd_session=${httpTok}`), SECRET),
    true,
    'both may coexist',
  );
});

test('a Secure-named cookie never authenticates a plain-HTTP request', () => {
  const tok = makeToken(SECRET);
  const overHttp = ({ headers: { cookie: `omd_session_s=${tok}` }, socket: {} }) as unknown as IncomingMessage;
  // A real browser would not even send it; refuse it regardless so the scheme boundary is
  // enforced server-side too.
  assert.equal(hasValidSession(overHttp, SECRET), false);
});

test('an HTTPS request accepts a session started on the legacy HTTP port', () => {
  const tok = makeToken(SECRET);
  const req = ({ headers: { cookie: `omd_session=${tok}`, 'x-forwarded-proto': 'https' }, socket: {} }) as unknown as IncomingMessage;
  assert.equal(hasValidSession(req, SECRET), true, 'moving from the HTTP port to TLS must not sign you out');
});

test('an HTTPS logout clears BOTH names, so it is never partial', () => {
  const cleared = clearCookieHeader(true);
  assert.ok(cleared.some((c) => c.startsWith('omd_session_s=;')));
  assert.ok(cleared.some((c) => c.startsWith('omd_session=;')));
  // Plain HTTP can only clear its own; the Secure cookie is neither sent nor clearable
  // there, and cannot authenticate an HTTP request anyway.
  assert.deepEqual(clearCookieHeader(false).length, 1);
});

test('the hardening attributes every session cookie must keep', () => {
  for (const c of [setCookieHeader(makeToken(SECRET)), setVolunteerCookieHeader(makeVolunteerToken(SECRET))]) {
    assert.match(c, /HttpOnly/, 'must stay unreadable to JS');
    assert.match(c, /SameSite=Lax/, 'this is what carries the CSRF defence');
    assert.match(c, /Path=\//);
  }
});

// ── End to end: the upgrade path must survive it ──────────────────────────────
/** Send a raw WebSocket upgrade with the given Cookie header; resolve the status line
 *  ('' if the peer closed without writing one). */
function rawUpgrade(port: number, cookie: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        'GET /ws HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
          `Cookie: ${cookie}\r\n\r\n`,
      );
    });
    let out = '';
    sock.on('data', (d) => {
      out += d.toString();
    });
    const done = () => resolve(out.split('\r\n')[0] ?? '');
    sock.on('close', done);
    sock.on('error', done); // ECONNRESET is what a crashing server looks like
    setTimeout(() => {
      sock.destroy();
      done();
    }, 2000);
  });
}

test('a malformed cookie on the /ws upgrade cannot kill the server', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('alive');
  });
  // Same wiring as index.ts: the WS auth check runs inside the 'upgrade' listener.
  new WsHub(server, (req) => hasValidSession(req, SECRET));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;

  try {
    // Sanity: a well-formed but invalid token is refused, proving the check really runs.
    assert.match(await rawUpgrade(port, 'omd_session=notavalidtoken'), /401/);

    // The payload that used to be fatal. If the fix regresses, the throw is an uncaught
    // exception inside the listener and it takes THIS test process down — which is
    // exactly the failure we want to be impossible to ignore.
    await rawUpgrade(port, 'omd_session=%');

    // The decisive assertion: the server is still serving.
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200, 'server should still answer after a malformed cookie');
    assert.equal(await res.text(), 'alive');

    // …and it still refuses the upgrade rather than letting it through.
    assert.match(await rawUpgrade(port, 'omd_session=%'), /401/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
