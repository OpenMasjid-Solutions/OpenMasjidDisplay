// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Every route that serves a file somebody UPLOADED must sandbox it.
 *
 * An uploaded image may be an SVG, and an SVG is a script container: served with its real type and
 * opened directly, it runs in this app's origin. The uploader is an admin, so this is
 * admin-to-admin rather than a way in — but the project already treats stored SVG as active
 * content (`fabricTimetable.ts` refuses it outright, by magic bytes, for exactly this reason), and
 * being consistent costs one header.
 *
 * ## Why this is a test and not a comment
 *
 * It was already a comment. `api.ts`'s announcement-thumbnail route wrote the sandbox headers out
 * by hand with a paragraph explaining why an uploaded SVG is active content — and the other routes
 * serving the same bytes through the same `uploadFilePath()` did not have them: the Pi agent's
 * asset route, the browser screen's asset route, and a standalone Pi's own preview. The volunteer
 * page had a *third* hand-written copy which had already drifted (it omitted `media-src`). The
 * decision was made once, written three times, and applied to half the callers.
 *
 * So the check is not "is there a header" but "does every caller of uploadFilePath that writes a
 * 200 use the shared constant".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_HEADERS, SECURITY_HEADERS } from './httpio';

const SRC = __dirname;

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) out.push(p);
  }
  return out;
}

/** The lines of a handler, with comments dropped.
 *
 *  Dropping them is load-bearing, not tidiness: the first version of this matched the WORD
 *  `UPLOAD_HEADERS` anywhere in the window, and the fix's own explanatory comment contains that
 *  word — so reverting a route to the weak headers and leaving the comment behind passed. Found
 *  by sabotaging the route and watching this stay green. */
function code(lines: string[], from: number, span = 25): string {
  return lines
    .slice(from, from + span)
    .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

test('the sandboxing set actually sandboxes', () => {
  const csp = UPLOAD_HEADERS['content-security-policy'];
  // `sandbox` is the directive that stops script in an SVG; without it the rest is decoration.
  assert.match(csp, /\bsandbox\b/, 'an SVG without `sandbox` can still run script');
  assert.match(csp, /default-src 'none'/, 'nothing should load by default');
  assert.equal(UPLOAD_HEADERS['x-content-type-options'], 'nosniff');
  // And it must be stricter than the ordinary set, or using it would be pointless.
  assert.notEqual(csp, SECURITY_HEADERS['content-security-policy']);
});

test('every route that serves an uploaded file sandboxes it', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\buploadFilePath\s*\(/.test(line)) return;
      const window = code(lines, i);
      // Some callers only need the PATH (to read bytes for rendering) and never write a response.
      if (!/res\.writeHead\(/.test(window)) return;
      // A 404-only branch serves no file, so the ordinary headers are right there.
      const writes = [...window.matchAll(/res\.writeHead\((\d{3})/g)].map((m) => m[1]);
      if (!writes.includes('200')) return;
      // The SPREAD, not the word: `...UPLOAD_HEADERS` is what actually sets them.
      if (/\.\.\.UPLOAD_HEADERS\b/.test(window)) return;
      offenders.push(`${path.relative(SRC, file).replace(/\\/g, '/')}:${i + 1}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    'these routes serve an uploaded file without the sandboxing headers — an uploaded SVG is ' +
      `active content and would run in this app's origin:\n  ${offenders.join('\n  ')}`,
  );
});

test('there is one definition of it, not one per caller', () => {
  // The bug this file exists for was the same decision written three times and applied to half
  // the callers. A second literal copy of the policy string is that bug coming back.
  const literal = /default-src 'none'; img-src 'self' data:/;
  const copies = sources(SRC)
    .filter((f) => literal.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(SRC, f).replace(/\\/g, '/'));
  assert.deepEqual(copies, ['httpio.ts'], 'the upload policy belongs in httpio.ts, imported from there');
});
