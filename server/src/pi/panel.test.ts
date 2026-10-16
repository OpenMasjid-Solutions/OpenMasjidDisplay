// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The panel a standalone screen serves for itself.
 *
 * This is the only inbound path to the device, and `/api/setup` is the one route on it that can
 * create an account — so the tests here are about the boundary rather than the feature: what is
 * reachable without a session, what it takes to claim an unclaimed screen, and what happens to
 * the code afterwards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-panel-'));
process.env.DATA_DIR = DIR;
// config reads DATA_DIR at import time, so store must load after it is set.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Store } = require('../store') as typeof import('../store');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createPiPanel } = require('./panel') as typeof import('./panel');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PI_CAPABILITIES } = require('../capabilities') as typeof import('../capabilities');

const CODE = '04172580';
const WEB = path.join(DIR, 'web');
fs.mkdirSync(WEB, { recursive: true });
fs.writeFileSync(path.join(WEB, 'index.html'), '<!doctype html><title>panel</title>');
fs.mkdirSync(path.join(WEB, 'assets'), { recursive: true });
fs.writeFileSync(path.join(WEB, 'assets', 'app.js'), 'console.log(1)');
// A file OUTSIDE the bundle, for the traversal check.
fs.writeFileSync(path.join(DIR, 'secret.txt'), 'device token lives here');

interface Reply {
  status: number;
  body: string;
  headers: Record<string, unknown>;
  json: () => Record<string, unknown>;
}

/** One request through the handler, with no socket involved. */
function call(
  handler: ReturnType<typeof createPiPanel>,
  method: string,
  url: string,
  body?: unknown,
  cookie = '',
  ip = '10.0.0.5',
): Promise<Reply> {
  const chunks: Buffer[] = [];
  const headers: Record<string, unknown> = {};
  let status = 0;
  const res = {
    writeHead(code: number, h: Record<string, unknown>) {
      status = code;
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

  let done = (): void => {};
  const finished = new Promise<void>((r) => {
    done = r;
  });

  const listeners: Record<string, ((x?: unknown) => void)[]> = {};
  const req = {
    method,
    url,
    headers: { ...(cookie ? { cookie } : {}) },
    socket: { remoteAddress: ip, encrypted: false },
    on(ev: string, fn: (x?: unknown) => void) {
      (listeners[ev] ??= []).push(fn);
      return req;
    },
    destroy() {},
  } as unknown as IncomingMessage;

  const ran = handler(req, res);
  // Feed the body after the handler has attached its listeners.
  queueMicrotask(() => {
    if (body !== undefined) for (const fn of listeners.data ?? []) fn(Buffer.from(JSON.stringify(body)));
    for (const fn of listeners.end ?? []) fn();
  });

  return Promise.all([ran, finished]).then(() => {
    const text = Buffer.concat(chunks).toString('utf8');
    return { status, body: text, headers, json: () => JSON.parse(text || '{}') };
  });
}

/** A panel with its own store, reset per test. */
function panel(opts: { claimed?: boolean; code?: string | undefined } = {}) {
  const store = new Store();
  store.update((db) => {
    db.admin = null;
  });
  let cfg = { server: '', deviceId: 'pi_a', deviceSecret: 's', setupCode: opts.code === undefined && !('code' in opts) ? CODE : opts.code };
  const handler = createPiPanel({
    store,
    readConfig: () => cfg as never,
    writeConfig: (next) => {
      cfg = next as never;
    },
    webDir: WEB,
    screens: { getStatuses: () => [] },
  });
  if (opts.claimed) {
    store.update((db) => {
      db.admin = { hash: 'x', salt: 'y', createdAt: new Date().toISOString() };
    });
  }
  return { handler, store, config: () => cfg };
}

// ── what is reachable without signing in ─────────────────────────────────────

test('an unclaimed screen says it needs setting up, and that a code is wanted', async () => {
  const { handler } = panel();
  const r = await call(handler, 'GET', '/api/session');
  assert.equal(r.status, 200);
  const j = r.json();
  assert.equal(j.needsSetup, true);
  assert.equal(j.authed, false);
  assert.equal(j.setupCodeRequired, true);
  assert.deepEqual(j.capabilities, PI_CAPABILITIES, 'the panel is told it is on a Pi');
});

test('the session never contains the code itself', async () => {
  // Knowing WHAT the code is, is the whole point of walking to the television.
  const { handler } = panel();
  const r = await call(handler, 'GET', '/api/session');
  assert.ok(!r.body.includes(CODE), r.body);
});

test('nothing else is reachable without a session', async () => {
  const { handler } = panel({ claimed: true });
  for (const [m, u] of [
    ['GET', '/api/state'],
    ['GET', '/api/timetables'],
    ['POST', '/api/timetables'],
    ['GET', '/api/anything'],
  ] as const) {
    const r = await call(handler, m, u);
    assert.equal(r.status, 401, `${m} ${u}`);
  }
});

// ── claiming the screen ──────────────────────────────────────────────────────

test('the right code and a password claim the screen', async () => {
  const { handler, store, config } = panel();
  const r = await call(handler, 'POST', '/api/setup', { code: '0417 2580', password: 'a-good-password' });
  assert.equal(r.status, 200, r.body);
  assert.ok(store.db.admin, 'the account exists');
  assert.ok(String(r.headers['set-cookie']).includes('='), 'and the session is handed over');
  assert.equal(config().setupCode, undefined, 'the code is spent');
});

test('a wrong code claims nothing', async () => {
  const { handler, store } = panel();
  const r = await call(handler, 'POST', '/api/setup', { code: '04172581', password: 'a-good-password' });
  assert.equal(r.status, 401);
  assert.equal(store.db.admin, null, 'no account was created');
});

test('a short password is refused, and the code is not spent by it', async () => {
  // Otherwise a typo in the password costs somebody a walk to the television.
  const { handler, config } = panel();
  const r = await call(handler, 'POST', '/api/setup', { code: CODE, password: 'short' });
  assert.equal(r.status, 400);
  assert.equal(config().setupCode, CODE, 'the code survives a rejected password');
});

test('two people claiming at once cannot both win', async () => {
  // The check for "is there an admin already" happens BEFORE the request body is awaited, and
  // an await yields. So two POSTs arriving together can both pass that check and both go on to
  // write an account — the second silently replacing the first, who keeps a session cookie for
  // a password that no longer works.
  //
  // Both callers need the right code, so this is not a takeover by a stranger. It is still the
  // kind of thing that is impossible to diagnose afterwards: one of two people setting up a
  // screen finds their password simply does not work.
  const { handler, store } = panel();
  const results = await Promise.all([
    call(handler, 'POST', '/api/setup', { code: CODE, password: 'first-password-x' }, '', '10.0.0.1'),
    call(handler, 'POST', '/api/setup', { code: CODE, password: 'second-password-x' }, '', '10.0.0.2'),
  ]);
  const ok = results.filter((r) => r.status === 200);
  assert.equal(ok.length, 1, `both requests were accepted: ${results.map((r) => r.status).join(', ')}`);
  assert.ok(store.db.admin, 'and one of them did create the account');
});

test('a screen already set up cannot be claimed again', async () => {
  const { handler } = panel({ claimed: true });
  const r = await call(handler, 'POST', '/api/setup', { code: CODE, password: 'a-good-password' });
  assert.equal(r.status, 409);
});

test('a screen with no code on disk cannot be claimed at all', async () => {
  // The dangerous state: an unclaimed panel with no secret in front of it is one anyone on the
  // network can take. Refusing is the only safe reading.
  const { handler, store } = panel({ code: undefined });
  const r = await call(handler, 'POST', '/api/setup', { code: '', password: 'a-good-password' });
  assert.equal(r.status, 403);
  assert.equal(store.db.admin, null);
});

test('guessing is rate-limited', async () => {
  const { handler } = panel();
  let sawLimit = false;
  for (let i = 0; i < 40; i++) {
    const r = await call(handler, 'POST', '/api/setup', { code: '00000000', password: 'a-good-password' }, '', '10.0.0.9');
    if (r.status === 429) {
      sawLimit = true;
      break;
    }
  }
  assert.ok(sawLimit, 'eight digits is only out of reach while guessing is slow');
});

// ── what the panel boots from ────────────────────────────────────────────────

/** Claim the screen and return the session cookie, so the authenticated routes can be reached. */
async function claim(handler: ReturnType<typeof createPiPanel>): Promise<string> {
  const r = await call(handler, 'POST', '/api/setup', { code: CODE, password: 'a-good-password' });
  assert.equal(r.status, 200, r.body);
  const set = String(r.headers['set-cookie'] ?? '');
  return set.split(';')[0];
}

test('a signed-in panel gets the same payload shape the server sends', async () => {
  // The panel is one app on both hosts, so it is written against one shape. These are the keys
  // it boots from; a missing one is a page that renders empty with nothing in the console.
  const { handler } = panel();
  const cookie = await claim(handler);
  const r = await call(handler, 'GET', '/api/state', undefined, cookie);
  assert.equal(r.status, 200, r.body);
  const j = r.json();
  for (const k of ['settings', 'timetables', 'sources', 'tvs', 'schedules', 'themes', 'hadithDefaults', 'statuses', 'rtsp', 'volunteer', 'serverNow']) {
    assert.ok(k in j, `missing ${k}`);
  }
});

test('the state says plainly that this device serves no RTSP and has no platform', async () => {
  // Not cosmetic: a screen that advertised an RTSP port would be inviting somebody to point a
  // television at a stream this device does not publish and never will.
  const { handler } = panel();
  const cookie = await claim(handler);
  const j = (await call(handler, 'GET', '/api/state', undefined, cookie)).json();
  assert.deepEqual(j.rtsp, { port: 0, transport: 'tcp' });
  assert.equal(j.omosBase, '');
  assert.deepEqual(j.volunteer, { pinSet: false, port: 0 });
});

// ── pictures ─────────────────────────────────────────────────────────────────

/** A real 1x1 PNG, because the type is decided by the BYTES and a fake would be refused. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('a logo can be uploaded, and the timetable then names it', async () => {
  const { handler, store } = panel();
  const cookie = await claim(handler);
  const id = store.db.timetables[0].id;
  const r = await call(handler, 'POST', `/api/timetables/${id}/logo`, { data: PNG }, cookie);
  assert.equal(r.status, 200, r.body);
  assert.ok(store.db.timetables[0].logoImage, 'the timetable points at the stored file');
  const gone = await call(handler, 'DELETE', `/api/timetables/${id}/logo`, undefined, cookie);
  assert.equal(gone.status, 200);
  assert.equal(store.db.timetables[0].logoImage, '', 'and removing it clears the reference');
});

test('the picture type comes from the bytes, not the name the browser gave it', async () => {
  // A browser types a data URI from the file EXTENSION, so a text file called logo.png arrives
  // claiming to be a PNG. resvg would then pick its decoder from that lie and draw nothing.
  const { handler, store } = panel();
  const cookie = await claim(handler);
  const id = store.db.timetables[0].id;
  const lying = `data:image/png;base64,${Buffer.from('this is not a picture').toString('base64')}`;
  const r = await call(handler, 'POST', `/api/timetables/${id}/logo`, { data: lying }, cookie);
  assert.equal(r.status, 400, r.body);
  assert.equal(store.db.timetables[0].logoImage, '', 'nothing was stored');
});

test('an upload needs a session like everything else', async () => {
  const { handler, store } = panel();
  await claim(handler);
  const id = store.db.timetables[0].id;
  const r = await call(handler, 'POST', `/api/timetables/${id}/logo`, { data: PNG });
  assert.equal(r.status, 401);
});

test('announcement pictures add, list and remove one at a time', async () => {
  const { handler, store } = panel();
  const cookie = await claim(handler);
  const id = store.db.timetables[0].id;
  await call(handler, 'POST', `/api/timetables/${id}/announcements`, { data: PNG }, cookie);
  await call(handler, 'POST', `/api/timetables/${id}/announcements`, { data: PNG }, cookie);
  const images = store.db.timetables[0].announcements?.images ?? [];
  assert.equal(images.length, 2, 'both were kept — each announcement is its own file');
  assert.notEqual(images[0], images[1], 'and they are different files');
  const r = await call(handler, 'DELETE', `/api/timetables/${id}/announcements/${encodeURIComponent(images[0])}`, undefined, cookie);
  assert.equal(r.status, 200);
  assert.deepEqual(store.db.timetables[0].announcements?.images, [images[1]], 'only the named one went');
});

test('an upload for a timetable that does not exist is refused', async () => {
  const { handler } = panel();
  const cookie = await claim(handler);
  const r = await call(handler, 'POST', '/api/timetables/tt_nope/logo', { data: PNG }, cookie);
  assert.equal(r.status, 404);
});

// ── the bundle ───────────────────────────────────────────────────────────────

test('the web app and its assets are served', async () => {
  const { handler } = panel();
  const index = await call(handler, 'GET', '/');
  assert.equal(index.status, 200);
  assert.ok(index.body.includes('<!doctype html>'));
  const asset = await call(handler, 'GET', '/assets/app.js');
  assert.equal(asset.status, 200);
  assert.equal(asset.headers['content-type'], 'application/javascript; charset=utf-8');
});

test('an unknown path falls back to the app, so its routes work on a refresh', async () => {
  const { handler } = panel();
  const r = await call(handler, 'GET', '/settings');
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('<!doctype html>'));
});

test('a path cannot climb out of the bundle', async () => {
  // TWO guards stand here and they are redundant: `new URL().pathname` removes `..` segments
  // before the handler sees them, and `serveStatic` then resolves the path and checks it is
  // inside the bundle. Measured: removing EITHER one leaves this test green, and removing
  // both turns it red.
  //
  // So this pins the OUTCOME — no request reads a file outside the bundle — not which guard
  // earns it. A test cannot attribute a win between two defences that each suffice, and
  // writing it as though it could is how one of them gets deleted later on a green suite.
  // The device's own config lives one directory up, which is what makes the outcome matter.
  const { handler } = panel();
  for (const u of ['/../secret.txt', '/..%2Fsecret.txt', '/assets/../../secret.txt', '/%2e%2e/secret.txt']) {
    const r = await call(handler, 'GET', u);
    assert.ok(!r.body.includes('device token lives here'), `${u} escaped the bundle`);
  }
});
