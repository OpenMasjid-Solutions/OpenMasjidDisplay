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
function panel(opts: { claimed?: boolean; code?: string | undefined; noDevice?: boolean } = {}) {
  const store = new Store();
  store.update((db) => {
    db.admin = null;
  });
  let cfg = { server: '', deviceId: 'pi_a', deviceSecret: 's', setupCode: opts.code === undefined && !('code' in opts) ? CODE : opts.code };
  // A stand-in for the Raspberry Pi: it records what it was asked for instead of writing a spool
  // file, so the tests are about what the ROUTE lets through rather than about nmcli.
  const asked: { action: string; wifi?: { ssid: string; psk: string } }[] = [];
  const handler = createPiPanel({
    store,
    readConfig: () => cfg as never,
    writeConfig: (next) => {
      cfg = next as never;
    },
    webDir: WEB,
    screens: { getStatuses: () => [] },
    ...(opts.noDevice
      ? {}
      : {
          device: {
            id: 'tv_self',
            read: () => ({ net: { link: 'ethernet', ssid: '', hasWifi: true }, networks: [], wifiResult: undefined }),
            wifi: (action, wifi) => {
              asked.push({ action, ...(wifi ? { wifi } : {}) });
              return null;
            },
          },
        }),
  });
  if (opts.claimed) {
    store.update((db) => {
      db.admin = { hash: 'x', salt: 'y', createdAt: new Date().toISOString() };
    });
  }
  return { handler, store, config: () => cfg, asked };
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

// ── the rest of a timetable ──────────────────────────────────────────────────

test('a timetable can be duplicated, and the copy is its own', async () => {
  const { handler, store } = panel();
  const cookie = await claim(handler);
  const id = store.db.timetables[0].id;
  const r = await call(handler, 'POST', `/api/timetables/${id}/duplicate`, {}, cookie);
  assert.equal(r.status, 200, r.body);
  assert.equal(store.db.timetables.length, 2);
  const copy = store.db.timetables[1];
  assert.notEqual(copy.id, id, 'a new id, or deleting one deletes both');
  assert.match(copy.name, /\(copy\)$/);
});

test('an Iqamah spreadsheet imports, exports and clears', async () => {
  const { handler, store } = panel();
  const cookie = await claim(handler);
  const id = store.db.timetables[0].id;
  const csv = 'date,fajr,dhuhr,asr,maghrib,isha\n01-15,06:00,13:15,16:30,18:05,19:45\n';
  const put = await call(handler, 'POST', `/api/timetables/${id}/iqamah-csv`, { data: csv }, cookie);
  assert.equal(put.status, 200, put.body);
  assert.equal(put.json().rows, 1);
  assert.ok(store.db.timetables[0].iqamahYear, 'the times were kept');

  const out = await call(handler, 'GET', `/api/timetables/${id}/iqamah-csv`, undefined, cookie);
  assert.equal(out.status, 200);
  assert.match(String(out.headers['content-type']), /text\/csv/);
  assert.ok(out.body.includes('06:00'), 'what went in comes back out');

  const cleared = await call(handler, 'DELETE', `/api/timetables/${id}/iqamah-csv`, undefined, cookie);
  assert.equal(cleared.status, 200);
  assert.equal(store.db.timetables[0].iqamahYear, undefined);
});

test('a spreadsheet with nothing usable in it is refused, and changes nothing', async () => {
  const { handler, store } = panel();
  const cookie = await claim(handler);
  const id = store.db.timetables[0].id;
  const r = await call(handler, 'POST', `/api/timetables/${id}/iqamah-csv`, { data: 'nonsense\nmore nonsense\n' }, cookie);
  assert.equal(r.status, 400);
  assert.equal(store.db.timetables[0].iqamahYear, undefined);
});

test('scheduled Iqamah changes save, and an empty list removes them', async () => {
  const { handler, store } = panel();
  const cookie = await claim(handler);
  const id = store.db.timetables[0].id;
  const entry = [{ from: '2026-03-01', fajr: '05:45', dhuhr: '13:30' }];
  const r = await call(handler, 'PUT', `/api/timetables/${id}/iqamah-schedule`, { schedule: entry }, cookie);
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json().entries, 1);
  assert.ok(store.db.timetables[0].iqamahSchedule?.length);
  await call(handler, 'PUT', `/api/timetables/${id}/iqamah-schedule`, { schedule: [] }, cookie);
  assert.equal(store.db.timetables[0].iqamahSchedule, undefined, 'an empty list means "none", not "an empty one"');
});

test('printing needs a location, and says so rather than printing nothing', async () => {
  const { handler, store } = panel();
  const cookie = await claim(handler);
  const id = store.db.timetables[0].id;
  const no = await call(handler, 'GET', `/api/timetables/${id}/print`, undefined, cookie);
  assert.equal(no.status, 400, 'a calendar with no times on it is worse than a message');

  store.update((db) => {
    db.timetables[0].latitude = 40.2415;
    db.timetables[0].longitude = -75.2838;
    db.timetables[0].timezone = 'America/New_York';
  });
  const yes = await call(handler, 'GET', `/api/timetables/${id}/print?month=2026-03`, undefined, cookie);
  assert.equal(yes.status, 200);
  assert.match(String(yes.headers['content-type']), /text\/html/);
  assert.ok(yes.body.includes('March'), 'the month asked for');
});

test('an impossible month is refused, not quietly turned into another one', async () => {
  // A printed calendar that is confidently the wrong month is a bad thing to hand a congregation.
  const { handler, store } = panel();
  const cookie = await claim(handler);
  store.update((db) => {
    db.timetables[0].latitude = 40.2415;
    db.timetables[0].longitude = -75.2838;
  });
  const id = store.db.timetables[0].id;
  const r = await call(handler, 'GET', `/api/timetables/${id}/print?month=2026-99`, undefined, cookie);
  assert.equal(r.status, 400);
});

// ── the volunteer page ───────────────────────────────────────────────────────

test('the volunteer page is reachable without the admin sign-in', async () => {
  // It has its own PIN and its own cookie. Putting it behind the admin login would defeat the
  // point of it: a volunteer is exactly the person who does not have the admin password.
  const { handler } = panel({ claimed: true });
  const r = await call(handler, 'GET', '/api/volunteer/session');
  assert.notEqual(r.status, 401, 'must not be behind the admin session');
  assert.equal(r.status, 200, r.body);
});

test('the page cannot be turned on without a PIN', async () => {
  // A volunteer page with no PIN is an open control for every screen in the building,
  // reachable by anyone on the network.
  const { handler, store } = panel();
  const cookie = await claim(handler);
  const r = await call(handler, 'PUT', '/api/volunteer-config', { enabled: true }, cookie);
  assert.equal(r.status, 400);
  assert.equal(store.db.settings.volunteerEnabled, false);
});

test('a PIN must be 4 to 8 digits', async () => {
  const { handler } = panel();
  const cookie = await claim(handler);
  for (const pin of ['12', '123456789', 'abcd', '12a4']) {
    const r = await call(handler, 'PUT', '/api/volunteer-config', { pin, enabled: true }, cookie);
    assert.equal(r.status, 400, pin);
  }
});

test('setting a PIN turns the page on, and clearing it turns it off', async () => {
  const { handler, store } = panel();
  const cookie = await claim(handler);
  const on = await call(handler, 'PUT', '/api/volunteer-config', { pin: '4821', enabled: true }, cookie);
  assert.equal(on.status, 200, on.body);
  assert.equal(on.json().pinSet, true);
  assert.ok(store.db.volunteerAuth, 'the PIN is stored hashed');
  assert.notEqual(JSON.stringify(store.db.volunteerAuth), JSON.stringify('4821'), 'never in the clear');

  const off = await call(handler, 'PUT', '/api/volunteer-config', { pin: '', enabled: false }, cookie);
  assert.equal(off.status, 200);
  assert.equal(store.db.volunteerAuth, null);
});

test('setting the PIN needs the admin session', async () => {
  const { handler } = panel({ claimed: true });
  const r = await call(handler, 'PUT', '/api/volunteer-config', { pin: '4821', enabled: true });
  assert.equal(r.status, 401);
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

// ── Wi-Fi: the one device control this panel has ─────────────────────────────
//
// It exists because a standalone screen that loses its network has no other way back: there is no
// display server holding a dashboard somewhere else, so the only thing that can move this screen
// onto a new network is the screen itself.

test('a Wi-Fi change reaches the device', async () => {
  const { handler, asked } = panel();
  const cookie = await claim(handler);
  const r = await call(handler, 'POST', '/api/pi/tv_self/command', { action: 'wifi-rescan' }, cookie);
  assert.equal(r.status, 200);
  assert.deepEqual(asked, [{ action: 'wifi-rescan' }]);
});

test('a join carries the network and the passphrase, and nothing else', async () => {
  const { handler, asked } = panel();
  const cookie = await claim(handler);
  const r = await call(
    handler,
    'POST',
    '/api/pi/tv_self/command',
    { action: 'wifi-join', wifi: { ssid: 'Masjid 5G', psk: 'correct horse' }, shell: 'rm -rf /', text: 'x' },
    cookie,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(asked, [{ action: 'wifi-join', wifi: { ssid: 'Masjid 5G', psk: 'correct horse' } }]);
});

test('this route is Wi-Fi ONLY — every other verb the spool knows is refused', async () => {
  // The spool WILL act on all of these. The panel has no page that asks for them, so a request
  // for one cannot have come from this product — and forwarding whatever arrived is how a route
  // that looks like "the device command route" becomes a remote reboot, a reinstall, or a root
  // terminal on the masjid's screen.
  const { handler, asked } = panel();
  const cookie = await claim(handler);
  for (const action of ['reboot', 'update', 'reinstall', 'shell', 'shell-session', 'logs', 'display-off', 'set-video-mode', 'restart', 'screenshot']) {
    const r = await call(handler, 'POST', '/api/pi/tv_self/command', { action, shell: 'id' }, cookie);
    assert.equal(r.status, 400, `"${action}" must be refused`);
  }
  assert.deepEqual(asked, [], 'and none of them reached the device');
});

test('a Wi-Fi change needs a session', async () => {
  const { handler, asked } = panel({ claimed: true });
  const r = await call(handler, 'POST', '/api/pi/tv_self/command', { action: 'wifi-rescan' });
  assert.equal(r.status, 401);
  assert.deepEqual(asked, []);
});

test('a command addressed to some other screen is refused', async () => {
  // There is exactly one device here. An id that is not it is either a mistake or a panel built
  // against a fleet, and acting on it anyway would mean the id in the path means nothing.
  const { handler, asked } = panel();
  const cookie = await claim(handler);
  const r = await call(handler, 'POST', '/api/pi/tv_other/command', { action: 'wifi-rescan' }, cookie);
  assert.equal(r.status, 404);
  assert.deepEqual(asked, []);
});

test('a network name or passphrase that cannot be real is refused here, not only by root', async () => {
  const { handler, asked } = panel();
  const cookie = await claim(handler);
  const bad = [
    {},
    { ssid: '' },
    { ssid: 'x'.repeat(33), psk: 'abcdefgh' },
    { ssid: 'ok', psk: 'p'.repeat(64) },
  ];
  for (const wifi of bad) {
    const r = await call(handler, 'POST', '/api/pi/tv_self/command', { action: 'wifi-join', wifi }, cookie);
    assert.equal(r.status, 400, `${JSON.stringify(wifi)} must be refused`);
  }
  assert.deepEqual(asked, []);
});

test('a screen with no device underneath it says so rather than pretending', async () => {
  const { handler } = panel({ noDevice: true });
  const cookie = await claim(handler);
  const r = await call(handler, 'POST', '/api/pi/tv_self/command', { action: 'wifi-rescan' }, cookie);
  assert.equal(r.status, 404);
  // And the panel is told there is nothing to render, rather than being given an empty shape it
  // would draw as a Wi-Fi section with no networks in it.
  const j = (await call(handler, 'GET', '/api/state', undefined, cookie)).json();
  assert.equal(j.pi, undefined);
});

test('the state carries this screen own network facts, so the panel polls once', async () => {
  const { handler } = panel();
  const cookie = await claim(handler);
  const j = (await call(handler, 'GET', '/api/state', undefined, cookie)).json();
  const pi = j.pi as Record<string, unknown>;
  assert.equal(pi.id, 'tv_self');
  assert.deepEqual(pi.net, { link: 'ethernet', ssid: '', hasWifi: true });
});
