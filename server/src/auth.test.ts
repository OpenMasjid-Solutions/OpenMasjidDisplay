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
import { hasValidSession, hasValidVolunteerSession, makeToken, makeVolunteerToken } from './auth';
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
