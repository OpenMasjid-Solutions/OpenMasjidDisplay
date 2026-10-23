// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Opened from outside the masjid, every address the panel builds must stay under its prefix.
 *
 * Behind the OpenMasjidOS tunnel this app is `https://<apps' hostname>/display/…` and the root of
 * that hostname is the OpenMasjidOS dashboard. So a call to `/api/state`, a socket on `/ws`, an
 * image at `/api/preview/…` all reach the DASHBOARD — and the panel opened from the remote
 * dashboard was a white screen, then (once its script loaded) a panel whose every call failed.
 * The server writes the prefix into the page as `window.__OMD_BASE__`; this checks the panel's
 * calls, links and sockets actually use it — and that anything else in that global is ignored.
 *
 * One test file is one process (node --test), so the global set here reaches nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// The server writes this before the bundle runs (server/src/httpio.ts pageUnderBase).
window.__OMD_BASE__ = '/display';

const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  calls.push(String(input));
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

// After the global is set: base.ts reads it once, when it is first imported.
const { BASE, baseFrom, withBase, wsUrl } = await import('./base');
const { api, volApi } = await import('./api');

test('the prefix the server injected is the one the panel uses', () => {
  assert.equal(BASE, '/display');
  assert.equal(withBase('/api/state'), '/display/api/state');
  assert.equal(withBase('/'), '/display/', 'the brand link goes home to the app, not the dashboard');
  // Not an in-app path: left alone.
  assert.equal(withBase('https://github.com/x'), 'https://github.com/x');
  assert.equal(withBase('//evil.example/x'), '//evil.example/x');
});

test('every API call goes under the prefix — the panel, its uploads, and the volunteer page', async () => {
  calls.length = 0;
  await api.session();
  await api.state();
  await api.uploadLogo('tt1', 'data:image/png;base64,AA==');
  await api.piTerminalOpen('dev1', 24, 80);
  await volApi.tvs();
  await api.previewLive({}).catch(() => {}); // a blob URL; jsdom may not mint one
  assert.deepEqual(calls, [
    '/display/api/session',
    '/display/api/state',
    '/display/api/timetables/tt1/logo',
    '/display/api/pi/dev1/terminal',
    // Once, not twice: the volunteer calls used to add the prefix themselves.
    '/display/api/volunteer/tvs',
    '/display/api/preview',
  ]);
});

test('addresses the panel hands to an <img>, a download link or a new tab are under the prefix', () => {
  for (const url of [
    api.iqamahCsvUrl('tt1'),
    api.iqamahCsvUrl('tt1', 'template'),
    api.iqamahChangeImageUrl('tt1'),
    api.announcementImageUrl('tt1', 'a b.png'),
    api.timetablePrintUrl('tt1'),
    volApi.reportImageUrl('r1'),
  ]) {
    assert.ok(url.startsWith('/display/api/'), `${url} would be fetched from the dashboard`);
  }
});

test('the live socket and the Pi terminal connect under the prefix', () => {
  // jsdom's page is http://screen.test/ (testing/jsdom.mjs).
  assert.equal(wsUrl('/ws'), 'ws://screen.test/display/ws');
  assert.equal(wsUrl('/api/pi/shell/abc'), 'ws://screen.test/display/api/pi/shell/abc');
});

test('anything but a plain path segment in the global means the root, never a URL part', () => {
  for (const bad of ['/x"><script>', 'display', '/a/b', '/UPPER', '//host', '/', '', 42, undefined]) {
    assert.equal(baseFrom(bad), '', `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(baseFrom('/masjid-display-2'), '/masjid-display-2');
});
