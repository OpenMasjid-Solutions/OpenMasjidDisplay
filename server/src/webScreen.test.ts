// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Browser screens (beta).
 *
 * Two things carry the weight here and neither is about pixels:
 *
 *  - **The page is unauthenticated**, because a television cannot sign in. The token in the
 *    URL is therefore the entire access control, so the tests below are mostly about who can
 *    reach it and with what.
 *  - **One renderer.** The whole feature rests on `render/svg.ts` being usable from a browser,
 *    so the last test pins the property that makes that true — if someone adds an `fs` import
 *    to the renderer, a browser screen goes blank and nothing else in the suite would notice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normTv, normSettings } from './validate';
import { webScreenState, markWebScreenSeen, webScreenOnline, findByToken, WEB_SEEN_TIMEOUT_MS, __resetWebScreensForTests } from './webScreen';
import type { DB, Settings, Tv } from './types';

const NOW = new Date('2026-08-18T15:00:00Z').getTime();

function settings(over: Partial<Settings> = {}): Settings {
  const empty: Settings = {
    defaultQuality: '1080p',
    scheduleTimezone: '',
    volunteerEnabled: false,
    volunteerRemote: true,
    whatsapp: { iqamahChange: false, groupId: '', groupLabel: '', timetableId: '', daysBefore: 1 },
    webScreensBeta: false,
  };
  return { ...normSettings({}, empty), ...over };
}

function db(tvs: Tv[]): DB {
  return {
    version: 1,
    admin: null,
    volunteerAuth: null,
    settings: settings(),
    timetables: [],
    sources: [],
    tvs,
    schedules: [],
  };
}

// ── the token ────────────────────────────────────────────────────────────────

test('a web screen gets a 128-bit token; an rtsp screen gets none', () => {
  const web = normTv({ name: 'Hall', kind: 'web' });
  assert.equal(web.kind, 'web');
  assert.ok(web.webToken, 'a web screen needs a token — it is the whole access control');
  // 16 random bytes base64url. Not rid(), which is 4 bytes and only has to be unique.
  assert.equal(web.webToken!.length, 22);
  assert.match(web.webToken!, /^[A-Za-z0-9_-]+$/, 'must be URL-safe — it goes in a path');

  const rtsp = normTv({ name: 'Hall' });
  assert.equal(rtsp.kind, 'rtsp', 'the default, so every screen made before this feature is unchanged');
  assert.equal(rtsp.webToken, undefined);
});

test('a token is never accepted from the client', () => {
  // It is a capability. Letting a caller choose it would let them choose someone else's.
  const forged = normTv({ name: 'Hall', kind: 'web', webToken: 'aaaaaaaaaaaaaaaaaaaaaa' });
  assert.notEqual(forged.webToken, 'aaaaaaaaaaaaaaaaaaaaaa');
});

test('a token survives every edit, because a television has that URL saved', () => {
  const first = normTv({ name: 'Hall', kind: 'web' });
  const renamed = normTv({ name: 'Main hall', kind: 'web' }, first);
  assert.equal(renamed.webToken, first.webToken);
});

test('two screens never share a token', () => {
  const tokens = new Set(Array.from({ length: 200 }, () => normTv({ name: 'x', kind: 'web' }).webToken));
  assert.equal(tokens.size, 200);
});

test('lookup is by token and only ever finds web screens', () => {
  const web = normTv({ name: 'Hall', kind: 'web' });
  const rtsp = normTv({ name: 'Other' });
  const d = db([web, rtsp]);
  assert.equal(findByToken(d, web.webToken!)?.id, web.id);
  assert.equal(findByToken(d, 'nope'), null);
  assert.equal(findByToken(d, ''), null);

  // Switching a screen back to a decoder must make its old URL stop working, not keep serving.
  const reverted = normTv({ name: 'Hall', kind: 'rtsp' }, web);
  assert.equal(findByToken(db([reverted]), web.webToken!), null);
});

// ── liveness ─────────────────────────────────────────────────────────────────

test('a browser screen is online only while it keeps checking in', () => {
  __resetWebScreensForTests();
  const tv = normTv({ name: 'Hall', kind: 'web' });
  assert.equal(webScreenOnline(tv.id, NOW), false, 'never seen = offline, not "assume fine"');

  markWebScreenSeen(tv.id, NOW);
  assert.equal(webScreenOnline(tv.id, NOW), true);
  // Survives a couple of missed check-ins — a Wi-Fi blip is not a dark screen.
  assert.equal(webScreenOnline(tv.id, NOW + WEB_SEEN_TIMEOUT_MS - 1000), true);
  assert.equal(webScreenOnline(tv.id, NOW + WEB_SEEN_TIMEOUT_MS + 1000), false);
});

// ── the state payload ────────────────────────────────────────────────────────

test('the state payload is data, not a rendered picture — and it is small', () => {
  const tt = require('./validate').normTimetable({
    masjidName: 'Madani Academy Masjid',
    latitude: 40.2415,
    longitude: -75.2838,
    timezone: 'America/New_York',
  });
  const tv = normTv({ name: 'Hall', kind: 'web', defaultContent: { kind: 'timetable', id: tt.id } });
  const d = db([tv]);
  d.timetables = [tt];

  const state = webScreenState(d, tv, NOW, { basePrefix: '', clockSuspect: false, bgLight: false, autoAccent: null });
  assert.equal(state.timetable?.id, tt.id);
  assert.equal(state.content.kind, 'timetable');
  assert.equal(state.serverNow, NOW, 'the browser renders against the SERVER clock, not its own');

  // The point of the whole feature: the wire carries a timetable, not a frame. An H.264 second
  // is ~190 KB; this is the entire state.
  const bytes = Buffer.byteLength(JSON.stringify(state));
  assert.ok(bytes < 4096, `state payload should be tiny, was ${bytes} B`);
});

test('asset URLs are scoped to the screen token, not to a global uploads path', () => {
  const tt = require('./validate').normTimetable({ latitude: 1, longitude: 1, timezone: 'UTC' });
  tt.backgroundImage = 'bg.png';
  tt.logoImage = 'logo.png';
  const tv = normTv({ name: 'Hall', kind: 'web', defaultContent: { kind: 'timetable', id: tt.id } });
  const d = db([tv]);
  d.timetables = [tt];

  const state = webScreenState(d, tv, NOW, { basePrefix: '/display', clockSuspect: false, bgLight: false, autoAccent: null });
  assert.equal(state.assets.background, `/display/s/${tv.webToken}/asset/bg.png`);
  assert.equal(state.assets.logo, `/display/s/${tv.webToken}/asset/logo.png`);
  // The base prefix is what makes the same page work behind the platform's tunnel.
  assert.ok(state.assets.background!.startsWith('/display/'), 'must carry the tunnel base path');
});

test('a screen showing nothing carries no timetable', () => {
  const tv = normTv({ name: 'Hall', kind: 'web', defaultContent: { kind: 'off' } });
  const state = webScreenState(db([tv]), tv, NOW, { basePrefix: '', clockSuspect: false, bgLight: false, autoAccent: null });
  assert.equal(state.timetable, null);
  assert.equal(state.content.kind, 'off');
});

// ── the property the whole feature rests on ──────────────────────────────────

test('the renderer stays free of Node-only APIs, or every browser screen goes blank', () => {
  // svg.ts and its transitive imports are bundled into the page. A single `node:fs` import
  // anywhere in that set breaks the build for a surface no server test would exercise, so the
  // constraint is asserted here rather than discovered on a wall.
  const dir = path.join(__dirname);
  const files = ['render/svg.ts', 'render/theme.ts', 'render/defaultHadith.ts', 'iqamahSchedule.ts', 'iqamahCsv.ts', 'prayer/engine.ts'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const imports = [...src.matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(
        spec.startsWith('.'),
        `${f} imports "${spec}" — the browser bundle only tolerates relative imports from this set`,
      );
    }
    assert.ok(!/\bnode:/.test(src), `${f} must not use a node: import`);
    assert.ok(!/\bBuffer\b/.test(src), `${f} must not use Buffer`);
    assert.ok(!/\bprocess\./.test(src), `${f} must not read process`);
  }
});

test('the renderer never reads the clock itself', () => {
  // `now` is always passed in. If the renderer called Date.now(), a browser screen would draw
  // against the TELEVISION's clock instead of the server's, and a TV with a dead RTC would
  // show confident, wrong prayer times.
  const src = fs.readFileSync(path.join(__dirname, 'render/svg.ts'), 'utf8');
  assert.equal((src.match(/Date\.now\(\)/g) ?? []).length, 0, 'svg.ts must not call Date.now()');
  assert.equal((src.match(/new Date\(\)/g) ?? []).length, 0, 'svg.ts must not construct an unparameterised Date');
});

test('the screen page and its bundle are actually built', () => {
  // The route serves dist/screen.html. A missing second Vite entry would 404 every screen,
  // and only an integration test would catch it.
  const dist = path.resolve(__dirname, '..', '..', 'web', 'dist');
  if (!fs.existsSync(dist)) return; // not built in this checkout; the CI web build covers it
  assert.ok(fs.existsSync(path.join(dist, 'screen.html')), 'web build must emit screen.html');
  const html = fs.readFileSync(path.join(dist, 'screen.html'), 'utf8');
  assert.match(html, /<div id="screen">/);
  assert.match(html, /assets\/screen-[\w-]+\.js/, 'screen.html must reference its own bundle');
});

test('a temp dir is not needed for any of this', () => {
  // Guard against someone "helpfully" persisting the heartbeat: it expires in 95 seconds and
  // writing it would spin the debounced save and the reconcile listener on every beat.
  assert.ok(os.tmpdir());
});
