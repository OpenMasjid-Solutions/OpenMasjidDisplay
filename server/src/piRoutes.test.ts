// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Every address the agent posts to has to be an address the server answers.
 *
 * `POST /pi/<token>/logs` had a complete handler — cap reasoned about, error codes, a store
 * function with its own tests — and it could never run, because the single regex that decides
 * which paths are DEVICE paths listed `state|seen|command-ack` and not `logs`. So the upload fell
 * through to the authenticated API and came back `401 Please sign in.` to a device that has no
 * session and never will. On the screen it looked exactly like the feature had not been built.
 *
 * This is the same shape of bug as the check-in size cap next door in checkInSize.test.ts: two
 * things that have to agree, written in different files, with nothing checking that they do. So
 * this test does not list the routes — it reads the agent's OWN urls out of the agent, reads the
 * gate's OWN regex out of api.ts, and insists that each of the first is admitted by the second.
 * Adding an endpoint to the agent and forgetting the gate now fails here instead of in a hall.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const apiSrc = () => fs.readFileSync(path.resolve(__dirname, 'api.ts'), 'utf8');
const agentSrc = () => fs.readFileSync(path.resolve(__dirname, 'pi', 'index.ts'), 'utf8');

/** The live route gate, lifted out of api.ts rather than copied — a copy would go stale the
 *  first time somebody edited the real one, which is the whole failure being guarded against. */
function deviceRouteRe(): RegExp {
  const line = apiSrc()
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('/^') && l.includes('(enrol|'));
  assert.ok(line, 'could not find the /pi/ route regex in api.ts — has it been rewritten?');
  const lit = line.replace(/\.exec\($/, '');
  assert.ok(lit.startsWith('/') && lit.endsWith('/'), `not a regex literal: ${lit}`);
  return new RegExp(lit.slice(1, -1));
}

/** Every `/pi/<token>/…` path the agent actually asks for, read from its source. */
function agentEndpoints(): string[] {
  const found = [...agentSrc().matchAll(/\$\{cfg\.server\}\/pi\/\$\{cfg\.token\}\/([a-z-]+)/g)].map((m) => m[1]);
  assert.ok(found.length >= 3, `only found ${found.length} token-scoped agent endpoints — has the agent changed shape?`);
  return [...new Set(found)];
}

// A token of the shape the enrolment route hands out: 22 url-safe base64 characters.
const TOKEN = 'ZyftbT8NoeN7rZvbFe6upg';

test('every endpoint the agent posts to is admitted by the device route', () => {
  const re = deviceRouteRe();
  for (const ep of agentEndpoints()) {
    assert.ok(re.test(`/pi/${TOKEN}/${ep}`), `the agent posts to /pi/<token>/${ep} and the route regex rejects it`);
    // And behind the platform's tunnel, where the app is served under its own base path.
    assert.ok(re.test(`/display/pi/${TOKEN}/${ep}`), `/display/pi/<token>/${ep} is rejected`);
  }
});

test('every endpoint the route admits is one the server actually handles', () => {
  // The other direction, and the cheaper half of the same mistake: a path that gets past the gate
  // and then matches no `what === '…'` branch falls out of the block and is answered by whatever
  // comes next, which is not a device route at all.
  const re = String(deviceRouteRe());
  const inner = /\(state\|([a-z|-]+)\|\(\?:asset\|font\)/.exec(re);
  assert.ok(inner, `could not read the endpoint alternation out of ${re}`);
  const src = apiSrc();
  for (const what of ['state', ...inner[1].split('|')]) {
    assert.ok(
      src.includes(`what === '${what}'`),
      `the route admits /pi/<token>/${what} but nothing in api.ts handles it`,
    );
  }
});

test('the device route still refuses what it always refused', () => {
  // The guard is a security boundary, not just a dispatch table: it is what stops an unauthenticated
  // path from reaching the authenticated API. A test that only checked "logs is allowed" would pass
  // just as well against a regex that allowed everything.
  const re = deviceRouteRe();
  for (const bad of [
    `/pi/${TOKEN}/settings`,
    `/pi/${TOKEN}/state/../../api/screens`,
    `/pi/${TOKEN}/asset/../../../etc/passwd`,
    `/pi/${TOKEN}`,
    `/pi/${TOKEN}/logs/extra`,
    '/pi/short/logs',
    `/a/b/pi/${TOKEN}/logs`,
  ]) {
    assert.ok(!re.test(bad), `the route regex should not match ${bad}`);
  }
  // And what it must keep allowing.
  assert.ok(re.test('/pi/enrol'));
  assert.ok(re.test(`/pi/${TOKEN}/asset/tt_6e46aea7.logo.png`));
  assert.ok(re.test(`/pi/${TOKEN}/font/NotoSans-Regular.ttf`));
});

/**
 * Adopting one screen twice at once, and the release that must follow it.
 *
 * `POST /api/pi/link` mints a FRESH identity every time, so two overlapping requests for one
 * screen each create a device and a screen, and the second's handover overwrites the first's on
 * the Pi. What is left is an ADOPTED row for a screen that will never come online — and
 * `forgetPendingDevice` deliberately refuses to touch an adopted row, so nothing cleans it up.
 * The panel's button is disabled while a request is in flight, which covers a double click and
 * does not cover the case that produces this: a slow Pi, an admin who thinks it has hung, a page
 * reload, and a second press.
 *
 * The guard is a set of origins currently being adopted. It is not what makes the overlap SAFE —
 * that is the Pi's own refusal to accept a second handover while it holds a token, which holds
 * across processes and is pinned in pi/panel.test.ts. This one buys the better answer: refused in
 * milliseconds rather than after a twelve-second round trip that creates a screen and deletes it
 * again. What makes it worth a test of its own is not the `add` — it is the RELEASE: a release on the success path only would lock an address out of
 * being adopted for the lifetime of the process the first time a screen refused, and the symptom
 * would be "it says it is already being set up" for ever, with nothing to restart but the server.
 */
test('an adoption in flight is released however it ends', () => {
  const src = apiSrc();
  const start = src.indexOf("if (pathname === '/api/pi/link' && method === 'POST')");
  assert.ok(start > 0, 'could not find the adopt-by-address route — has it been renamed?');
  const end = src.indexOf('// Forget a device:', start);
  assert.ok(end > start, 'could not find the end of the route');
  // Comments stripped FIRST. This repository has twice shipped a test satisfied by the prose
  // explaining the rule rather than by the rule, and the prose above names every symbol below.
  const body = src
    .slice(start, end)
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  assert.ok(/linking\.add\(/.test(body), 'the route must mark the screen as being adopted');
  assert.ok(/linking\.has\(/.test(body), 'and refuse a second attempt while it is');

  const fin = body.indexOf('} finally {');
  assert.ok(fin > 0, 'the route must have a finally block to release in');
  assert.ok(
    /linking\.delete\(/.test(body.slice(fin)),
    'the release must be in the finally block: on the success path only, one screen that refuses ' +
      'to be adopted locks its address out until the server is restarted',
  );
  assert.ok(
    !/linking\.delete\(/.test(body.slice(0, fin)),
    'and ONLY there — an earlier release would reopen the window it exists to close',
  );
});
