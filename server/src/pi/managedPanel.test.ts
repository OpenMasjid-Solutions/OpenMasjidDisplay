// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The panel an adopted screen serves.
 *
 * Two things are being held here, and they pull in opposite directions: it must be reachable
 * without a password, because a Pi installed from a server never had one — and it must not be
 * able to change anything or say anything a stranger on the LAN should not hear.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createManagedPanel, type ManagedStatus } from './managedPanel';

const WEB = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-mgd-'));
fs.writeFileSync(path.join(WEB, 'index.html'), '<!doctype html><title>panel</title>');
fs.mkdirSync(path.join(WEB, 'assets'), { recursive: true });
fs.writeFileSync(path.join(WEB, 'assets', 'app.js'), 'console.log(1)');
// A file OUTSIDE the bundle, for the traversal check.
fs.writeFileSync(path.join(path.dirname(WEB), 'omd-mgd-secret.txt'), 'the device token lives here');

const STATUS: ManagedStatus = {
  screenName: 'Main Hall',
  hostname: 'raspberrypi',
  ip: '192.168.1.30',
  model: 'Raspberry Pi 4 Model B Rev 1.2',
  agentVersion: '0.71.0-dev.45',
  server: 'http://192.168.1.18:7860',
  serverReachable: true,
  lastContactAt: '2026-10-16T12:00:00.000Z',
  content: 'timetable',
  clockSuspect: false,
  displayOff: false,
};

interface Reply {
  status: number;
  body: string;
  headers: Record<string, unknown>;
  json: () => Record<string, unknown>;
}

function call(method: string, url: string, status: ManagedStatus = STATUS): Promise<Reply> {
  const handler = createManagedPanel({ webDir: WEB, status: () => status });
  const chunks: Buffer[] = [];
  const headers: Record<string, unknown> = {};
  let code = 0;
  let done!: () => void;
  const finished = new Promise<void>((r) => {
    done = r;
  });
  const res = {
    writeHead(c: number, h: Record<string, unknown>) {
      code = c;
      Object.assign(headers, h);
      return res;
    },
    setHeader(k: string, v: unknown) {
      headers[k.toLowerCase()] = v;
    },
    end(b?: Buffer | string) {
      if (b) chunks.push(Buffer.from(b));
      done();
    },
  } as unknown as ServerResponse;
  handler({ method, url, headers: {} } as unknown as IncomingMessage, res);
  return finished.then(() => {
    const body = Buffer.concat(chunks).toString('utf8');
    return {
      status: code,
      body,
      headers,
      json: () => JSON.parse(body) as Record<string, unknown>,
    };
  });
}

// ── it answers at all, without a password ────────────────────────────────────

test('the status page is reachable with no sign-in', async () => {
  // A Pi installed from a server never had a local password. Asking for one would lock an admin
  // out of the one page that exists for the day the server stops answering.
  const s = await call('GET', '/api/session');
  assert.equal(s.status, 200);
  assert.equal(s.json().authed, true, 'there is nothing to sign in to, so saying otherwise sends the app to a dead login');
  assert.equal(s.json().needsSetup, false);
  const self = await call('GET', '/api/pi/self');
  assert.equal(self.status, 200);
  assert.equal(self.json().screenName, 'Main Hall');
});

test('it says it is managed, so the panel knows to show one page', async () => {
  const caps = (await call('GET', '/api/session')).json().capabilities as Record<string, unknown>;
  assert.equal(caps.editable, false, 'a managed screen must not offer to edit a copy nothing reads');
  assert.equal(caps.host, 'pi');
  assert.equal(caps.screens, 'self');
  // Every server-only feature stays off, exactly as on a standalone Pi.
  for (const k of ['whatsapp', 'companion', 'sso', 'notifications', 'widget', 'terminal', 'remoteAccess']) {
    assert.equal(caps[k], false, `${k} must be off on a Pi`);
  }
});

test('the web app and its assets are served, and a refresh on a route still works', async () => {
  assert.match((await call('GET', '/')).body, /<title>panel<\/title>/);
  assert.equal((await call('GET', '/assets/app.js')).status, 200);
  // An unknown path falls back to the app, or a client-side route would 404 on reload.
  assert.match((await call('GET', '/anything/at/all')).body, /<title>panel<\/title>/);
});

test('a path cannot climb out of the bundle', async () => {
  for (const p of ['/../omd-mgd-secret.txt', '/..%2fomd-mgd-secret.txt', '/assets/../../omd-mgd-secret.txt']) {
    const r = await call('GET', p);
    assert.ok(!r.body.includes('device token'), `${p} escaped the bundle`);
  }
});

// ── it cannot change anything ────────────────────────────────────────────────

test('nothing but GET and HEAD is answered', async () => {
  // The server owns this screen's configuration. A write here would either do nothing or change a
  // local copy nothing reads, which is worse than refusing: the admin would believe it had worked.
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await call(m, '/api/pi/self');
    assert.equal(r.status, 405, `${m} must be refused`);
    assert.match(String(r.json().error), /managed by a Display server/);
  }
});

test('the editing API is not here, and says which machine has it', async () => {
  // Not a bare 404: an admin reading this should be told where the screen IS managed, rather than
  // concluding the panel is broken.
  for (const p of ['/api/state', '/api/timetables', '/api/settings', '/api/sources', '/api/setup', '/api/login']) {
    const r = await call('GET', p);
    assert.equal(r.status, 404, `${p} must not be served`);
    assert.match(String(r.json().error), /managed by a Display server/);
  }
});

test('the handler cannot write: it holds no writer at all', () => {
  // The standalone panel has ~25 routes, most of which write. This is a SEPARATE handler so the
  // writes are not registered rather than guarded — a guard is one `if` that a later route can be
  // added around. Asserted by reading the file, because "there is no writer" is a property of the
  // file and not of any one route.
  //
  // COMMENTS STRIPPED FIRST. Without that this failed on its own explanation, which names the
  // very calls it is asserting are absent — the same trap uploadHeaders.test.ts fell into, where
  // a comment mentioning the constant satisfied the check.
  const src = fs
    .readFileSync(path.join(__dirname, 'managedPanel.ts'), 'utf8')
    .split(String.fromCharCode(10))
    .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l))
    .join(String.fromCharCode(10));
  for (const forbidden of ['store.update', 'writeFileSync', 'renameSync', 'unlinkSync', 'mkdirSync', 'rmSync', 'readBody']) {
    assert.ok(!src.includes(forbidden), `managedPanel.ts must not contain ${forbidden}`);
  }
});

// ── it does not say more than the television already does ────────────────────

test('the status carries no timetable, no camera and no credential', async () => {
  // Unauthenticated on the LAN, so the payload is held to what anybody standing in the room can
  // already read off the television. `content` is a KIND: a camera's name can carry a room name
  // and its URL carries a password.
  const body = (await call('GET', '/api/pi/self', { ...STATUS, content: 'camera' })).body;
  assert.match(body, /"content":"camera"/);
  for (const leak of ['rtsp', 'password', 'token', 'secret', 'Fajr', 'timetable"', 'logo']) {
    assert.ok(!body.toLowerCase().includes(leak.toLowerCase()), `the status must not carry ${leak}`);
  }
  // And the shape is exactly the fields that were designed, so a field added later is a decision.
  assert.deepEqual(Object.keys((await call('GET', '/api/pi/self')).json()).sort(), [
    'agentVersion',
    'clockSuspect',
    'content',
    'displayOff',
    'hostname',
    'ip',
    'lastContactAt',
    'model',
    'screenName',
    'server',
    'serverReachable',
  ]);
});

test('a screen out of contact says so, and says when it last heard', async () => {
  // The question somebody opening this page is actually asking.
  const j = (await call('GET', '/api/pi/self', { ...STATUS, serverReachable: false })).json();
  assert.equal(j.serverReachable, false);
  assert.equal(j.lastContactAt, '2026-10-16T12:00:00.000Z');
});
