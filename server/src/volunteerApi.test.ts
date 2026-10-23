// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The volunteer page: a 4–8 digit PIN on a phone, so the two things that matter are how fast
 * that PIN can be guessed and how much one PIN-holder can load the server.
 *
 * Driven through a real socket rather than a request double, because the first bug here was about
 * TIMING: the PIN limiter was asked before the body arrived, so a burst of guesses all passed it
 * before the first failure was counted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// config reads DATA_DIR at import time, so it is set before anything that reads it loads.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-vol-'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Store } = require('./store') as typeof import('./store');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createVolunteerApi } = require('./volunteerApi') as typeof import('./volunteerApi');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { hashPassword } = require('./auth') as typeof import('./auth');

const PIN = '4821';

/** A fresh volunteer API on its own port, with a PIN set and no timetables to draw cards for. */
async function serve(): Promise<{ port: number; close: () => void }> {
  const store = new Store();
  store.update((db) => {
    db.settings = { ...db.settings, volunteerEnabled: true };
    db.volunteerAuth = hashPassword(PIN);
    db.timetables = [];
    db.reports = [];
  });
  const handler = createVolunteerApi({ store, orchestrator: { getStatuses: () => [] } } as never);
  const server = http.createServer((q, s) => void handler(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as net.AddressInfo).port, close: () => server.close() };
}

/** One request. `holdMs` delays the body, so a burst's requests all arrive before any finishes. */
function send(port: number, method: string, url: string, body: unknown, cookie = '', holdMs = 0): Promise<{ status: number; setCookie: string }> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body ?? {});
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        `${method} ${url} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n` +
          (cookie ? `Cookie: ${cookie}\r\n` : '') +
          'Connection: close\r\n\r\n',
      );
      setTimeout(() => sock.write(payload), holdMs);
    });
    let buf = '';
    sock.on('error', () => {});
    sock.on('data', (d) => (buf += d));
    sock.on('close', () =>
      resolve({
        status: Number(/HTTP\/1\.1 (\d+)/.exec(buf)?.[1] ?? 0),
        setCookie: (/set-cookie: ([^;\r\n]+)/i.exec(buf)?.[1] ?? '').trim(),
      }),
    );
  });
}

test('a burst of PIN guesses is limited like guesses one at a time', async (t) => {
  const { port, close } = await serve();
  t.after(close);
  const wrong = Array.from({ length: 40 }, (_, i) => send(port, 'POST', '/api/volunteer/login', { pin: String(1000 + i) }, '', 300));
  const right = send(port, 'POST', '/api/volunteer/login', { pin: PIN }, '', 300);
  const replies = await Promise.all([...wrong, right]);
  const tried = replies.filter((r) => r.status === 401).length;
  assert.ok(tried <= 10, `${tried} wrong PINs were checked in one burst`);
  assert.equal(replies[replies.length - 1].status, 429, 'the right PIN, sent with them, is not let in');
});

test('one PIN cannot pile up reports without limit', async (t) => {
  // Each report carries photos, and every one added redraws every report's card on the thread that
  // also serves the panel and feeds the screens.
  const { port, close } = await serve();
  t.after(close);
  const signIn = await send(port, 'POST', '/api/volunteer/login', { pin: PIN });
  assert.equal(signIn.status, 200);
  const report = { plate: 'ABC123', location: 'Front gate', reason: 'Blocking the exit' };
  for (let i = 0; i < 20; i++) {
    assert.equal((await send(port, 'POST', '/api/volunteer/reports', report, signIn.setCookie)).status, 201, `report ${i + 1}`);
  }
  assert.equal((await send(port, 'POST', '/api/volunteer/reports', report, signIn.setCookie)).status, 400, 'the twenty-first');
});
