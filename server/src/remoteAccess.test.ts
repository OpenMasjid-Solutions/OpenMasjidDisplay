// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The control panel opened from OUTSIDE the masjid, through the OpenMasjidOS tunnel.
 *
 * There the app is `https://<apps' hostname>/<basePath>/…`, the platform does not strip the
 * prefix, and the root of that hostname is the OpenMasjidOS dashboard. Opening Display from the
 * remote dashboard gave a white screen: the page named `/assets/index-….js`, the browser fetched
 * it from the DASHBOARD, and the script never ran. Behind that, nothing else answered under the
 * prefix either — not the API, not the socket — so fixing the page alone would have been a panel
 * whose every call failed.
 *
 * So this drives the real handler the way the platform's ingress does: the prefixed path, and
 * the headers a tunnelled request carries (`cf-ray`, `x-forwarded-proto: https`). A fake platform
 * answers single sign-on. Alongside it, the LAN — requests at the root — must not change at all,
 * and a password must never become a way in from outside.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Orchestrator } from './orchestrator';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-remote-'));
const PUB = path.join(DIR, 'public');
const SECRET = 'remote-access-test-secret';
/** The access token OpenMasjidOS puts back as `omos_session` for this app, behind the tunnel. */
const TOKEN = 'platform-access-token-for-this-app';
const PASSWORD = 'correct horse battery';

/** What the build writes, in the shape Vite writes it: every asset URL absolute at the root. */
const INDEX_HTML =
  '<!doctype html><html><head>' +
  '<link rel="icon" type="image/png" href="/assets/mark-1.png" />' +
  '<script type="module" crossorigin src="/assets/index-1.js"></script>' +
  '<link rel="stylesheet" crossorigin href="/assets/index-1.css">' +
  '</head><body><div id="root"></div></body></html>';

/** Headers the platform's ingress forwards for a request that came through the tunnel. */
const TUNNEL = { 'cf-ray': '8a1b2c3d4e5f-LHR', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'apps.example.org' };

let platform: http.Server;
let server: http.Server;
let port = 0;
let api: typeof import('./api');
let auth: typeof import('./auth');

const listen = (s: http.Server): Promise<number> =>
  new Promise((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

before(async () => {
  fs.mkdirSync(path.join(PUB, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(PUB, 'index.html'), INDEX_HTML);
  fs.writeFileSync(path.join(PUB, 'assets', 'index-1.js'), 'console.log("panel")');

  // OpenMasjidOS's single sign-on, as an app server sees it: our secret plus the visitor's token.
  platform = http.createServer((req, res) => {
    const cookies = String(req.headers.cookie ?? '').split(/;\s*/);
    const ok =
      req.url === '/api/auth/session' &&
      req.headers['x-openmasjid-app-secret'] === SECRET &&
      cookies.includes(`omos_session=${TOKEN}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { authenticated: true, username: 'admin' } : { authenticated: false }));
  });
  const platformPort = await listen(platform);

  // config reads the environment when it is first required, so everything is required after this.
  process.env.OPENMASJID_BASE_URL = `http://127.0.0.1:${platformPort}`;
  process.env.OPENMASJID_APP_SECRET = SECRET;
  process.env.DATA_DIR = path.join(DIR, 'data');
  process.env.PUBLIC_DIR = PUB;
  api = require('./api') as typeof import('./api');
  auth = require('./auth') as typeof import('./auth');
  const { Store } = require('./store') as typeof import('./store');
  const { WsHub } = require('./ws') as typeof import('./ws');

  const store = new Store();
  // Only the screen statuses are read, by /api/state.
  const orchestrator = { getStatuses: () => [] } as unknown as Orchestrator;
  // No `commands`: the platform's command route then answers 503 at its exact path, which is how
  // a test below tells "reached it" from "did not".
  const handler = api.createApi({
    store,
    orchestrator,
    volunteer: async (_req, res) => {
      res.writeHead(204);
      res.end();
    },
  });
  server = http.createServer((req, res) => void handler(req, res));
  // The same socket wiring as index.ts.
  new WsHub(server, (req) => auth.hasValidSession(req, store.secret));
  port = await listen(server);
});

after(async () => {
  for (const s of [server, platform]) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  fs.rmSync(DIR, { recursive: true, force: true });
});

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** One request, with the path sent EXACTLY as given — dot segments and escapes included. */
function call(method: string, rawPath: string, headers: Record<string, string> = {}, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: rawPath,
        headers: { ...headers, ...(payload ? { 'content-type': 'application/json' } : {}) },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const setCookies = (r: Reply): string[] => r.headers['set-cookie'] ?? [];
const cookiePair = (setCookie: string): string => setCookie.split(';')[0];

/** Sign in through OpenMasjidOS exactly as the panel does from outside; returns the cookie pair. */
async function signInFromOutside(): Promise<string> {
  const r = await call('GET', '/display/api/session', { ...TUNNEL, cookie: `omos_session=${TOKEN}` });
  assert.equal(r.status, 200);
  const [c] = setCookies(r);
  assert.ok(c, 'single sign-on minted no session');
  return cookiePair(c);
}

test('the panel opened through the tunnel names its assets under the prefix', async () => {
  for (const p of ['/display/', '/display', '/display/index.html', '/display/?edit=tt1']) {
    const r = await call('GET', p, TUNNEL);
    assert.equal(r.status, 200, p);
    assert.match(r.body, /src="\/display\/assets\/index-1\.js"/, `${p}: the script would load from the dashboard`);
    assert.match(r.body, /href="\/display\/assets\/index-1\.css"/, p);
    assert.match(r.body, /href="\/display\/assets\/mark-1\.png"/, p);
    assert.doesNotMatch(r.body, /="\/assets\//, `${p}: an asset URL is still at the root`);
    // And the bundle is told the prefix for its API calls, sockets and runtime-built asset URLs,
    // in a classic script — which runs before the deferred module bundle.
    assert.match(r.body, /<script>window\.__OMD_BASE__="\/display";<\/script><\/head>/, p);
  }
  const js = await call('GET', '/display/assets/index-1.js', TUNNEL);
  assert.equal(js.status, 200);
  assert.equal(js.body, 'console.log("panel")');
});

test('on the masjid’s network the page is served at the root exactly as before', async () => {
  for (const p of ['/', '/index.html']) {
    const r = await call('GET', p);
    assert.equal(r.status, 200);
    assert.match(r.body, /src="\/assets\/index-1\.js"/);
    assert.match(r.body, /<script>window\.__OMD_BASE__="";<\/script>/);
  }
});

test('from outside, OpenMasjidOS signs the admin in — with a cookie for this app’s path alone', async () => {
  const r = await call('GET', '/display/api/session', { ...TUNNEL, cookie: `omos_session=${TOKEN}` });
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type']), /application\/json/, 'the API answered with the page');
  const s = JSON.parse(r.body) as { authed: boolean; passwordSignIn: boolean; sso: { username?: string } };
  assert.equal(s.authed, true);
  assert.equal(s.sso.username, 'admin');
  assert.equal(s.passwordSignIn, false, 'a password form would be offered that the server refuses');

  const [c] = setCookies(r);
  assert.match(c, /^omd_session_s=/, 'never the platform’s own cookie name');
  // Every app on the tunnel hostname shares it, and the platform forwards our cookies to the
  // others: at Path=/ any of them could replay it at /display/api/….
  assert.match(c, /; Path=\/display;/);
  assert.match(c, /; Secure$/);
  assert.match(c, /HttpOnly/);

  // Without the platform's token, nobody is signed in.
  const anon = JSON.parse((await call('GET', '/display/api/session', TUNNEL)).body) as { authed: boolean };
  assert.equal(anon.authed, false);
});

test('the admin API answers under the prefix — JSON, behind the session', async () => {
  const cookie = await signInFromOutside();
  const st = await call('GET', '/display/api/state', { ...TUNNEL, cookie });
  assert.equal(st.status, 200);
  assert.match(String(st.headers['content-type']), /application\/json/);
  assert.ok(Array.isArray((JSON.parse(st.body) as { timetables: unknown }).timetables));

  const created = await call('POST', '/display/api/schedules', { ...TUNNEL, cookie }, {});
  assert.notEqual(created.status, 401, 'a mutation under the prefix was refused as signed out');

  // And not without it: the prefix is not a way round the sign-in gate.
  const anon = await call('GET', '/display/api/state', TUNNEL);
  assert.equal(anon.status, 401);
});

/** A WebSocket handshake, reporting the status line. */
function upgrade(rawPath: string, cookie?: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        `GET ${rawPath} HTTP/1.1\r\nHost: apps.example.org\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
          'cf-ray: 8a1b2c3d4e5f-LHR\r\nx-forwarded-proto: https\r\n' +
          (cookie ? `Cookie: ${cookie}\r\n` : '') +
          '\r\n',
      );
    });
    let out = '';
    sock.on('data', (d) => {
      out += d.toString();
      if (out.includes('\r\n')) sock.destroy();
    });
    const done = () => resolve(out.split('\r\n')[0] ?? '');
    sock.on('close', done);
    sock.on('error', done);
    setTimeout(() => sock.destroy(), 2000);
  });
}

test('the live socket connects under the prefix, and only when signed in', async () => {
  const cookie = await signInFromOutside();
  assert.match(await upgrade('/display/ws', cookie), / 101 /, 'live updates would never arrive from outside');
  assert.match(await upgrade('/display/ws'), / 401 /);
});

test('password sign-in and first-run setup are refused from outside — in every spelling', async () => {
  // Give the panel a recovery password, on the LAN, the way an admin would (signed in through the
  // dashboard, because the platform is reachable).
  const set = await call('POST', '/api/setup', { cookie: `omos_session=${TOKEN}` }, { password: PASSWORD });
  assert.equal(set.status, 200, set.body);

  // `new URL()` folds every one of these onto /api/login or /api/setup. Before this fix the dot
  // spellings reached the real password routes through the tunnel — with the prefix kept, the
  // platform routed them to us, and they arrived at the root.
  for (const p of [
    '/display/api/login',
    '/display/../api/login',
    '/display/%2e%2e/api/login',
    '/display/.%2e/api/login',
    '/x/y/../../api/login',
    '/display/api/setup',
    '/display/../api/setup',
  ]) {
    const r = await call('POST', p, TUNNEL, { password: PASSWORD });
    assert.equal(r.status, 403, `${p} answered ${r.status}`);
    assert.equal(setCookies(r).length, 0, `${p} handed out a session`);
  }

  // The LAN is unchanged: the password still works at the root.
  const lan = await call('POST', '/api/login', {}, { password: PASSWORD });
  assert.equal(lan.status, 200);
  assert.match(setCookies(lan)[0], /^omd_session=.*; Path=\/;/);
});

test('signing out from outside clears the cookie at its own path, and at the root', async () => {
  const cookie = await signInFromOutside();
  const r = await call('POST', '/display/api/logout', { ...TUNNEL, cookie });
  assert.equal(r.status, 200);
  const cleared = setCookies(r);
  for (const name of ['omd_session_s', 'omd_session']) {
    for (const p of ['/display', '/']) {
      assert.ok(
        cleared.some((c) => c.startsWith(`${name}=;`) && c.includes(`; Path=${p}; Max-Age=0`)),
        `${name} at Path=${p} survives sign-out`,
      );
    }
  }
  // On the LAN, exactly what it always cleared.
  const lan = setCookies(await call('POST', '/api/logout'));
  assert.deepEqual(lan, ['omd_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0']);
});

test('the platform’s command route is not reachable under the prefix', async () => {
  const h = { 'x-openmasjid-app-secret': SECRET, 'x-openmasjid-caller-app': 'omos:platform' };
  // At its exact path it is reached (503: this test built no command handler)…
  assert.equal((await call('POST', '/fabric/commands/run', h, {})).status, 503);
  // …and stripping the panel's prefix must never route a tunnelled request to it.
  const r = await call('POST', '/display/fabric/commands/run', { ...TUNNEL, ...h }, {});
  assert.notEqual(r.status, 503);
  assert.equal(r.status, 401);
});

test('panelPrefix: a first segment that is not one of the app’s own routes', () => {
  const { panelPrefix } = api;
  for (const [p, want] of [
    ['/', ''],
    ['/index.html', ''],
    ['/api/state', ''],
    ['/assets/index-1.js', ''],
    ['/s/abcdefghijklmnop', ''],
    ['/w/tt1', ''],
    ['/pi/enrol', ''],
    ['/volunteer', ''],
    ['/fabric/commands/run', ''],
    ['/healthz', ''],
    ['/display', '/display'],
    ['/display/', '/display'],
    ['/display/api/state', '/display'],
    ['/masjid-screens-2/assets/x.js', '/masjid-screens-2'],
  ] as const) {
    assert.equal(panelPrefix(p), want, p);
  }
});

test('session cookies take the prefix as their Path, and nothing else', () => {
  const tok = auth.makeToken(Buffer.alloc(32, 1));
  assert.match(auth.setCookieHeader(tok, undefined, true, '/display'), /; Path=\/display;/);
  assert.match(auth.setCookieHeader(tok, undefined, false), /; Path=\/;/, 'the LAN keeps Path=/');
  assert.match(auth.setCookieHeader(tok, undefined, false, ''), /; Path=\/;/);
  for (const bad of ['/a; Domain=evil.example', '/a/b', 'display', '/../x']) {
    assert.match(auth.setCookieHeader(tok, undefined, true, bad), /; Path=\/;/, bad);
  }
  assert.match(auth.setVolunteerCookieHeader(tok, true, '/display'), /; Path=\/display;/);
  assert.ok(auth.clearVolunteerCookieHeader(true, '/display').every((c) => c.includes('; Path=/display;')));
});
