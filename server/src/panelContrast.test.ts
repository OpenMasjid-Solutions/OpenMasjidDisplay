// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The control panel's ink, measured against the fills it actually sits on.
 *
 * OpenMasjidOS's app spec (docs/design-system/APP_UI_SPEC.md) asks for WCAG AA in both themes
 * and says, twice and in bold, that the place it fails is ink on a FILLED element. It is right:
 * the panel had `color: #fff` on four of them, one being the button that deletes a masjid's
 * timetable, which measured 2.77:1 on this theme's light red.
 *
 * That is not a class of bug that reading the CSS catches, because every one of those lines
 * looks fine. It needs arithmetic, and it needs to be run over the whole space rather than the
 * default: the admin picks one of FIVE accents on the dashboard and we paint it over the
 * stylesheet at runtime, so a pairing that passes in cyan says nothing about gold.
 *
 * These tests live in the server suite because that is where this repo runs tests at all — there
 * is no runner under `web/` — and they read the panel's real files off disk rather than
 * importing them, the way changelog.test.ts reads the real CHANGELOG. The contrast function is
 * the renderer's own, so the panel and the screens cannot come to different views of what AA is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { contrastRatio } from './render/svg';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const TOKENS = read('web/src/styles/tokens.css');
const APP_CSS = read('web/src/styles/app.css');
const ACCENTS_TS = read('web/src/omosAccents.ts');
const SPEC = read('docs/design-system/APP_UI_SPEC.md');

/** AA for body text. The panel is read at a desk, so the large-text allowance is not claimed. */
const AA = 4.5;

/**
 * The custom properties each theme ends up with.
 *
 * Only the plain theme selectors are considered — `:root`, `[data-theme="dark"]`,
 * `[data-theme="light"]` and comma-lists of them. The `[data-theme][data-wallpaper]` blocks
 * further down the file are higher-specificity scene colours for one wallpaper and are not what
 * a button is painted with. Later declarations win, as they do in the browser.
 */
function tokensFor(theme: 'dark' | 'light'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of TOKENS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sels = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const plain = sels.every((s) => s === ':root' || s === '[data-theme="dark"]' || s === '[data-theme="light"]');
    if (!plain) continue;
    const applies = sels.some((s) => (theme === 'dark' ? s === ':root' || s === '[data-theme="dark"]' : s === '[data-theme="light"]'));
    if (!applies) continue;
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  }
  return out;
}

const THEMES = { dark: tokensFor('dark'), light: tokensFor('light') } as const;

type Accent = { primary: string; hover: string; onPrimary: string; textLight: string };

/** The five accents, read out of the panel's own table. */
function accentTable(src: string): Record<string, Accent> {
  const out: Record<string, Accent> = {};
  for (const m of src.matchAll(
    /(\w+):\s*\{\s*primary:\s*'(#[0-9a-fA-F]{6})',\s*hover:\s*'(#[0-9a-fA-F]{6})',\s*onPrimary:\s*'(#[0-9a-fA-F]{6})',\s*textLight:\s*'(#[0-9a-fA-F]{6})'\s*\}/g,
  )) {
    out[m[1]] = { primary: m[2], hover: m[3], onPrimary: m[4], textLight: m[5] };
  }
  return out;
}

const ACCENTS = accentTable(ACCENTS_TS);

test('the files this reads are the ones it thinks they are', () => {
  // A guard on the guard: a moved file or a renamed token would otherwise make every assertion
  // below pass over an empty set.
  assert.equal(Object.keys(ACCENTS).length, 5, `expected five accents, parsed ${Object.keys(ACCENTS).join(', ')}`);
  for (const theme of ['dark', 'light'] as const) {
    for (const key of ['--color-surface', '--color-surface-raised', '--color-ink', '--color-primary', '--color-btn', '--color-on-primary', '--color-danger', '--color-on-danger']) {
      assert.ok(THEMES[theme][key], `${theme} is missing ${key}`);
    }
  }
});

// ── the accents ──────────────────────────────────────────────────────────────

test("each accent's own ink is readable on it — including on its hover", () => {
  // The whole reason `onPrimary` travels with `primary` in omosAccents.ts. Gold is the one that
  // makes the case: white on #FBBF24 is 1.67:1, and gold is a colour a masjid will pick.
  for (const [id, a] of Object.entries(ACCENTS)) {
    assert.ok(contrastRatio(a.onPrimary, a.primary) >= AA, `${id}: ink on the fill is ${contrastRatio(a.onPrimary, a.primary).toFixed(2)}:1`);
    assert.ok(contrastRatio(a.onPrimary, a.hover) >= AA, `${id}: ink on the HOVER fill is ${contrastRatio(a.onPrimary, a.hover).toFixed(2)}:1`);
  }
});

test('white would NOT have done — this is why the ink is a table and not a constant', () => {
  // Stated as a test rather than a comment so that "just use white" cannot quietly come back.
  const failures = Object.entries(ACCENTS).filter(([, a]) => contrastRatio('#FFFFFF', a.primary) < AA);
  assert.ok(failures.length >= 3, `expected white to fail on most accents; it failed on ${failures.length}`);
});

test('an accent still reads once it is painted over either theme — as a fill AND as text', () => {
  /**
   * `applyAccent` writes onto the root, which beats both theme blocks, so every accent has to
   * work over BOTH pages — the ten looks the spec counts.
   *
   * A fill and a letterform are separate questions and this asks both. The letterform is the one
   * that catches people out: the raw accents are 6.6:1 to 11.7:1 as text on the dark page and
   * 1.67:1 to 2.72:1 on the light one, which is why the table carries `textLight` at all.
   */
  const bad: string[] = [];
  for (const theme of ['dark', 'light'] as const) {
    const card = THEMES[theme]['--color-surface-raised'];
    const page = THEMES[theme]['--color-surface'];
    for (const [id, a] of Object.entries(ACCENTS)) {
      const fill = contrastRatio(a.onPrimary, a.primary);
      if (fill < AA) bad.push(`${theme}/${id}: ink on the fill is ${fill.toFixed(2)}:1`);
      // What `applyAccent` actually sets --color-primary to for this theme.
      const asText = theme === 'light' ? a.textLight : a.primary;
      for (const [what, bg] of [['card', card], ['page', page]] as const) {
        const r = contrastRatio(asText, bg);
        if (r < AA) bad.push(`${theme}/${id}: accent as text on the ${what} is ${r.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(bad, [], 'accents below AA once painted over a theme');
});

test('the light text form keeps the accent it came from', () => {
  // The point of a per-theme text colour is that a gold masjid still looks gold. A darkened
  // accent that has lost its hue is a grey, and a grey is not a masjid's colour — so the test
  // is that the CHANNEL ORDER survives (which of red/green/blue leads), not that some distance
  // is under a threshold, because the lightness is supposed to move a long way.
  const order = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255), ((n >> 8) & 255), n & 255]
      .map((v, i) => [v, i] as const)
      .sort((x, y) => y[0] - x[0])
      .map(([, i]) => i)
      .join('');
  };
  for (const [id, a] of Object.entries(ACCENTS)) {
    assert.equal(order(a.textLight), order(a.primary), `${id}: ${a.textLight} is no longer the hue of ${a.primary}`);
  }
});

// ── the theme's own filled elements ──────────────────────────────────────────

test('the ink on every filled element clears AA, in both themes', () => {
  const PAIRS: [string, string][] = [
    ['--color-on-primary', '--color-btn'],
    ['--color-on-primary', '--color-btn-hover'],
    ['--color-on-primary', '--color-primary'],
    ['--color-on-danger', '--color-danger'],
  ];
  const bad: string[] = [];
  for (const theme of ['dark', 'light'] as const) {
    for (const [ink, fill] of PAIRS) {
      const r = contrastRatio(THEMES[theme][ink], THEMES[theme][fill]);
      if (r < AA) bad.push(`${theme}: ${ink} on ${fill} = ${r.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(bad, [], 'filled elements below AA');
});

test('body and muted ink clear AA on both surfaces', () => {
  const bad: string[] = [];
  for (const theme of ['dark', 'light'] as const) {
    for (const ink of ['--color-ink', '--color-ink-muted']) {
      for (const bg of ['--color-surface', '--color-surface-raised']) {
        const r = contrastRatio(THEMES[theme][ink], THEMES[theme][bg]);
        if (r < AA) bad.push(`${theme}: ${ink} on ${bg} = ${r.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(bad, [], 'body text below AA');
});

// ── and the habit that caused it ─────────────────────────────────────────────

test('no rule paints a fixed white on a themed fill', () => {
  /**
   * The lint, not the measurement — because the measurement above can only check colours it
   * knows the names of, and `color: #fff` bypasses the token system entirely.
   *
   * A fixed white over a FIXED dark scrim is fine and is not flagged: `rgba(0,0,0,0.6)` is the
   * same colour in every theme and under every accent. What is flagged is a white on a
   * `var(--color-…)` fill, which is a colour that moves.
   */
  const bad: string[] = [];
  for (const m of APP_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const body = m[2];
    if (!/color:\s*#fff\b/i.test(body)) continue;
    const bg = /background(?:-color)?:\s*([^;]+);?/i.exec(body)?.[1] ?? '';
    if (/var\(--color-/.test(bg)) bad.push(`${m[1].trim().slice(0, 60)} — white on ${bg.trim()}`);
  }
  assert.deepEqual(bad, [], 'fixed white on a fill that changes with the theme or the accent');
});

test('the accent table in the code and the one in the spec are the same table', () => {
  // The spec is the platform's, copied into this repo; the table is the contract between them.
  // Parsed out of the markdown so a future edit to either side shows up here rather than as a
  // masjid seeing a colour the dashboard did not send.
  const fromSpec: Record<string, { primary: string; hover: string; onPrimary: string }> = {};
  for (const m of SPEC.matchAll(/^\|\s*`(\w+)`[^|]*\|\s*`(#[0-9A-Fa-f]{6})`\s*\|\s*`(#[0-9A-Fa-f]{6})`\s*\|\s*`(#[0-9A-Fa-f]{6})`\s*\|/gm)) {
    fromSpec[m[1]] = { primary: m[2], hover: m[3], onPrimary: m[4] };
  }
  assert.equal(Object.keys(fromSpec).length, 5, 'the spec should still carry five accents');
  // Only the three the platform defines. `textLight` is ours — derived, not handed over — so it
  // is asserted above by measurement rather than against a table the spec does not carry.
  const three = (o: Record<string, { primary: string; hover: string; onPrimary: string }>) =>
    Object.fromEntries(
      Object.entries(o).map(([k, v]) => [k, { primary: v.primary.toLowerCase(), hover: v.hover.toLowerCase(), onPrimary: v.onPrimary.toLowerCase() }]),
    );
  assert.deepEqual(three(ACCENTS), three(fromSpec));
});
