// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The line that makes "everything else needs a session" true, in both panels.
 *
 * Each of the two HTTP handlers in this app is one long chain of `if (pathname === …)`, and
 * somewhere in the middle sits a single statement:
 *
 *     if (!authed(req)) return sendJson(res, 401, { error: 'Please sign in.' });
 *
 * Every `/api/` route written ABOVE that line is public. Not "public if you get the guard wrong" —
 * public, unconditionally, with nothing else to notice it. There is no decorator, no route table
 * and no per-route annotation that would make a mistake visible; the only thing separating an
 * admin-only route from an open one is where in the file somebody happened to paste it.
 *
 * That is a reasonable design for a handler this size, and it is exactly the kind of thing that
 * breaks silently. `/api/pi/link` (0.71.0) is a good example of what it would cost: it takes an
 * address and a password, opens an outbound connection to that address, and creates a screen in
 * the masjid's dashboard. Pasted fifty lines higher it would do all of that for anybody who can
 * reach the panel, and every test of it would still pass, because they all sign in first.
 *
 * So this pins the unauthenticated surface as a LIST rather than checking any one route. Adding a
 * public route is then a deliberate act — you have to come here and say so — which is the whole
 * property worth having.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The four that genuinely cannot require a session, and why each one is here.
 *
 * `session` is what the browser asks before it knows whether it has one. `setup` creates the first
 * admin account and carries its own proof — a setup code on a Pi, the platform-reachability guard
 * on a server (CLAUDE.md §4). `login` is the sign-in itself. `logout` only clears a cookie.
 *
 * Everything else — every route that reads a timetable, changes a screen, reaches a device or
 * spends a credential — belongs below the line.
 */
const PUBLIC_API = ['/api/session', '/api/setup', '/api/login', '/api/logout'];

/** Every `/api/…` literal this handler matches on, in source order. */
function apiRoutes(src: string): { path: string; line: number }[] {
  const out: { path: string; line: number }[] = [];
  src.split('\n').forEach((text, i) => {
    // Comments first: this file is about what the CODE does, and the prose around these routes
    // names them constantly.
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
    for (const m of text.matchAll(/pathname === '(\/api\/[^']*)'/g)) out.push({ path: m[1], line: i + 1 });
    // A NEGATED startsWith is not a route — it is the static-file fallthrough, `if
    // (!pathname.startsWith('/api/'))`, which serves the web bundle for everything that is not an
    // API path. Counting it listed `/api/` itself as a public route, which is the opposite of what
    // that line says.
    for (const m of text.matchAll(/(!?)pathname\.startsWith\('(\/api\/[^']*)'\)/g)) {
      if (!m[1]) out.push({ path: m[2], line: i + 1 });
    }
  });
  return out;
}

/** Where the sign-in gate is. One per handler, and its absence is itself a failure. */
function gateLine(src: string, file: string): number {
  const lines = src.split('\n');
  const hits = lines
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => /if \(!authed\(req\)\) return sendJson\(res, 401/.test(text));
  assert.equal(hits.length, 1, `${file} must have exactly one sign-in gate; found ${hits.length}`);
  return hits[0].line;
}

for (const [label, file] of [
  ['the display server', path.resolve(__dirname, 'api.ts')],
  ['a standalone Pi', path.resolve(__dirname, 'pi', 'panel.ts')],
] as const) {
  test(`${label}: only the four sign-in routes are reachable without a session`, () => {
    const src = fs.readFileSync(file, 'utf8');
    const gate = gateLine(src, file);
    const open = apiRoutes(src)
      .filter((r) => r.line < gate)
      .map((r) => r.path);

    // Sorted and de-duplicated so the failure message reads as a SET rather than as an ordering
    // accident — a route matched twice (GET and POST on separate lines) is one route.
    const got = [...new Set(open)].sort();
    assert.deepEqual(
      got,
      [...PUBLIC_API].sort(),
      `the unauthenticated /api surface of ${path.basename(file)} has changed.\n` +
        `If a new route genuinely must be public, add it to PUBLIC_API here and say why in its ` +
        `comment. If it must not be — and almost nothing must — move it BELOW the sign-in gate ` +
        `on line ${gate}.`,
    );
  });
}

test('the gate really is what stands between a route and the public', () => {
  // Otherwise the two tests above pin a line number with no meaning. This asserts the shape the
  // whole file depends on: the gate RETURNS, so nothing after it runs unauthenticated, and it is
  // not inside a branch that could skip it.
  for (const file of [path.resolve(__dirname, 'api.ts'), path.resolve(__dirname, 'pi', 'panel.ts')]) {
    const src = fs.readFileSync(file, 'utf8');
    const line = src.split('\n')[gateLine(src, file) - 1];
    assert.match(line, /^\s*if \(!authed\(req\)\) return /, `${path.basename(file)}: the gate must return, unconditionally`);
  }
});

test('the routes added for adopting a screen by address are behind it', () => {
  // Named explicitly as well as covered by the set above, because this is the pair the invariant
  // was written for and a reader should be able to find them by name. The server's route spends a
  // credential on an outbound connection; the Pi's decides which display server owns that screen.
  for (const [file, route] of [
    [path.resolve(__dirname, 'api.ts'), '/api/pi/link'],
    [path.resolve(__dirname, 'pi', 'panel.ts'), '/api/pi/link'],
  ] as const) {
    const src = fs.readFileSync(file, 'utf8');
    const gate = gateLine(src, file);
    const hits = apiRoutes(src).filter((r) => r.path === route);
    assert.ok(hits.length > 0, `${path.basename(file)} no longer has ${route}`);
    for (const hit of hits) {
      assert.ok(hit.line > gate, `${path.basename(file)}:${hit.line} — ${route} is ABOVE the sign-in gate`);
    }
  }
});
