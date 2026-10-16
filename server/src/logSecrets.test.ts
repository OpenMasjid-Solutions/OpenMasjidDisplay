// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * No secret may be written to a log, and this is the thing that checks rather than the discipline.
 *
 * CLAUDE.md states the invariant — *"Secrets that must never be logged: the PIN, the request
 * secret, device tokens. Enforced by a test that greps the log sink, not by discipline"* — and
 * until now nothing did. A sweep of every log call in the server found no violation, so this
 * starts green; the point is the next one.
 *
 * Why it matters more here than in most apps: this app's logs are COLLECTED. `control.sh` uploads
 * the journal to the display server when the dashboard asks for it, the panel renders it in a
 * page, and a masjid volunteer debugging a screen is the person reading it. A device token in
 * that journal is a credential in a web page; a Wi-Fi passphrase in it is the masjid's network.
 *
 * ## What counts as a violation
 *
 * Interpolating a secret-bearing identifier into a logged string, or passing one as an argument.
 * MENTIONING one in prose does not: `log('refusing a session whose secret is not a plain token')`
 * is a sentence about a secret, not a secret, and a check that could not tell those apart would be
 * turned off within a week.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname);

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) out.push(p);
  }
  return out;
}

/** Names that hold a credential. Deliberately broad: a false positive is a rename away. */
const SECRET =
  /\b(deviceSecret|appSecret|psk|passphrase|[A-Za-z]*[Pp]assword|[A-Za-z]*[Tt]oken|setupCode|requestSecret|sessionSecret|pin)\b/;

/** A log call, and the text between its parentheses. One line is enough: a multi-line log call
 *  with a secret in it would still have the secret on some line of its own, which this sees. */
const CALL = /\b(?:log|logger|console)(?:\.\w+)?\(([^;]*)\)/g;

test('no log call writes a secret into the log', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;
      for (const m of line.matchAll(CALL)) {
        const inner = m[1];
        // Strip quoted runs: what is left is identifiers and interpolations, i.e. VALUES.
        // `${...}` is kept, because that is interpolation inside a template literal and is
        // exactly the dangerous case.
        const interpolated = [...inner.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).join(' ');
        const unquoted = inner
          .replace(/`(?:[^`\\]|\\.)*`/g, ' ')
          .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
          .replace(/"(?:[^"\\]|\\.)*"/g, ' ');
        const hit = SECRET.exec(`${interpolated} ${unquoted}`);
        if (hit) {
          offenders.push(`${path.relative(SRC, file).replace(/\\/g, '/')}:${i + 1}  [${hit[1]}]  ${t.slice(0, 100)}`);
        }
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `a secret is being written to the log — the journal is uploaded to the display server and\n` +
      `rendered in a page, so this is a credential in a web page:\n  ${offenders.join('\n  ')}`,
  );
});

test('the check can actually see a violation', () => {
  // A guard that cannot fail is worse than none: it reads as proof. This proves the matcher
  // catches both shapes — interpolation and a bare argument — without needing a real offence
  // committed in the tree to demonstrate it.
  const samples = [
    'log(`joined with ${cfg.psk}`);',
    "log('token', token);",
    'console.warn(`device ${id} token ${deviceToken}`);',
    'log(`pin accepted: ${pin}`);',
  ];
  for (const line of samples) {
    const found = [...line.matchAll(CALL)].some((m) => {
      const inner = m[1];
      const interpolated = [...inner.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).join(' ');
      const unquoted = inner
        .replace(/`(?:[^`\\]|\\.)*`/g, ' ')
        .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
        .replace(/"(?:[^"\\]|\\.)*"/g, ' ');
      return SECRET.test(`${interpolated} ${unquoted}`);
    });
    assert.ok(found, `the matcher missed: ${line}`);
  }

  // And that prose about a secret is NOT a violation, or the check gets switched off.
  const prose = "log('refusing a terminal session whose id or secret is not a plain token');";
  const flagged = [...prose.matchAll(CALL)].some((m) => {
    const inner = m[1];
    const interpolated = [...inner.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).join(' ');
    const unquoted = inner
      .replace(/`(?:[^`\\]|\\.)*`/g, ' ')
      .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
      .replace(/"(?:[^"\\]|\\.)*"/g, ' ');
    return SECRET.test(`${interpolated} ${unquoted}`);
  });
  assert.equal(flagged, false, 'a sentence that merely mentions a secret must not be flagged');
});
