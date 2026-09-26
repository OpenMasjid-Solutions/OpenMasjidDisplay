// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The parts of OpenMasjidOS's app spec (docs/design-system/APP_UI_SPEC.md) that a machine can
 * check, other than contrast — that has its own file.
 *
 * Each of these is a rule where the code looks perfectly fine right up until somebody opens the
 * panel in Arabic, or on a masjid with no route to the internet. Neither is a thing a reviewer
 * notices by reading a diff, and both are things a single careless line reintroduces, which is
 * what a lint is for.
 *
 * Read off the panel's source rather than its build output, because the server suite runs before
 * `web` is built and a test that silently skips is worse than no test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CSS_FILES = ['web/src/styles/tokens.css', 'web/src/styles/glass.css', 'web/src/styles/app.css'];
const CSS = CSS_FILES.map((f) => ({ file: f, text: read(f) }));

test('the files this reads are the ones it thinks they are', () => {
  for (const { file, text } of CSS) assert.ok(text.length > 100, `${file} is empty or missing`);
});

// ── §6 right-to-left ─────────────────────────────────────────────────────────

test('no physical inline-axis properties — logical ones only', () => {
  /**
   * `margin-left` and friends do not flip. The panel is opened from a dashboard that may itself
   * be in Arabic or Urdu, and since we now set `dir` from the dashboard's language a single
   * physical property is a control that walks to the wrong side of its own row.
   *
   * `left:`/`right:` are NOT in this list, and that is deliberate rather than an oversight: the
   * floating window is positioned in page pixels and dragged by the pointer, which is physical
   * geometry in both directions. It is centred symmetrically, so it behaves the same either way.
   */
  const BANNED = /(^|[^-\w])(margin|padding)-(left|right)\s*:|(^|[^-\w])border-(left|right)(-\w+)?\s*:|text-align\s*:\s*(left|right)\b/g;
  const hits: string[] = [];
  for (const { file, text } of CSS) {
    for (const m of text.matchAll(BANNED)) {
      const line = text.slice(0, m.index).split('\n').length;
      hits.push(`${file}:${line} ${m[0].trim()}`);
    }
  }
  assert.deepEqual(hits, [], 'physical properties — use the inline-start/inline-end forms');
});

test('every inline-axis translateX has its RTL counterpart', () => {
  /**
   * `transform: translateX()` has no logical form, so it is the one thing that cannot be fixed
   * by using the right property — it has to be flipped by hand under `[dir="rtl"]`. The spec
   * names it as having shipped twice on the platform before a test caught it: a toggle whose
   * thumb travels +1.2rem walks straight out of its own track in Arabic.
   *
   * A translateX of exactly -50% (or 50%) is a CENTRING, not a journey along the inline axis, so
   * it is the same in both directions and is not required to have a mirror.
   */
  const missing: string[] = [];
  for (const { file, text } of CSS) {
    const rules = [...text.matchAll(/([^{}]+)\{([^}]*)\}/g)];
    for (const r of rules) {
      const sel = r[1].trim();
      const m = /translateX\(\s*(-?[\d.]+)([a-z%]*)\s*\)/.exec(r[2]);
      if (!m || sel.includes('[dir="rtl"]')) continue;
      if (m[2] === '%' && Math.abs(Number(m[1])) === 50) continue; // a centring
      if (Number(m[1]) === 0) continue;
      const mirrored = rules.some((o) => o[1].includes('[dir="rtl"]') && o[1].includes(sel.replace(/^[^ ]*\s*/, '').trim() || sel) && /translateX/.test(o[2]));
      if (!mirrored) missing.push(`${file}: ${sel} moves ${m[1]}${m[2]} with no [dir="rtl"] rule`);
    }
  }
  assert.deepEqual(missing, [], 'translateX along the inline axis without an RTL mirror');
});

test('Arabic and Urdu are in the right-to-left set', () => {
  // The two languages this app itself renders screens in, so they are the two a masjid is most
  // likely to have their dashboard in. Read out of prefs.ts so dropping one shows up here.
  const rtl = /const RTL = new Set\(\[([^\]]*)\]\)/.exec(read('web/src/prefs.ts'))?.[1] ?? '';
  const tags = [...rtl.matchAll(/'([a-z]{2,3})'/g)].map((m) => m[1]);
  for (const want of ['ar', 'ur', 'fa', 'he']) {
    assert.ok(tags.includes(want), `${want} should be treated as right-to-left; saw ${tags.join(', ')}`);
  }
  assert.ok(!tags.includes('en'), 'English is not right-to-left');
});

// ── §8 no CDNs ───────────────────────────────────────────────────────────────

test('the panel asks the internet for nothing', () => {
  /**
   * A masjid may be on a LAN with no route out at all — the box is a Raspberry Pi in a cupboard,
   * not a laptop. One `fonts.googleapis.com` link is a page that renders in the wrong face, or
   * hangs, on exactly the installations least able to diagnose it.
   *
   * Links in COMMENTS are fine and are stripped first: documentation pointing at a spec or an
   * issue is not a request. So is anything the browser never fetches — `xmlns`, a `<link rel>`
   * to our own origin, an `href` a person clicks.
   */
  const SOURCES = [
    'web/index.html',
    'web/screen.html',
    ...CSS_FILES,
    'web/src/main.tsx',
    'web/src/App.tsx',
    'web/src/prefs.ts',
    'web/src/omosAccents.ts',
  ].filter((p) => fs.existsSync(path.join(ROOT, p)));
  const hits: string[] = [];
  for (const file of SOURCES) {
    const text = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/<!--[\s\S]*?-->/g, '');
    for (const m of text.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
      const url = m[0];
      if (/^https?:\/\/(www\.)?w3\.org/.test(url)) continue; // an SVG/XML namespace, never fetched
      if (/github\.com\/OpenMasjid-Solutions/.test(url)) continue; // the AGPL §13 source link
      hits.push(`${file}: ${url}`);
    }
  }
  assert.deepEqual(hits, [], 'the built panel must make no external requests');
});
