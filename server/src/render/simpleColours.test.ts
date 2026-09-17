// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The Simple design's colours: that the theme presets reach it at all, and that every one of
 * them is readable.
 *
 * Cycling the theme presets used to do almost nothing to a Simple screen. Simple has no scene,
 * no glass and no photo — a flat page and an accent is the whole design — and it replaced the
 * theme's `bg` with its own page colour, which defaulted to white and stayed white however many
 * times the admin clicked. A masjid could choose Twilight and get a white screen with purple
 * numbers on it.
 *
 * The page now has two theme options, stored as the TOKENS `theme-light` / `theme-dark` and
 * resolved against whatever accent is in play at render time — which is what makes them follow a
 * custom accent and a wallpaper-matched one, not just a preset.
 *
 * The other half is the reason a "pick any colour" feature is not free on this design. Simple
 * puts the accent on TEXT — the Iqamah times, the Jumu'ah times, the "next prayer in" line — and
 * several shipped accents are pale by design. Sunset's #facc15 Jumu'ah time on its own pale band
 * was 1.8:1. So the last test here is the one that matters: it reads every string off a rendered
 * frame, finds what is actually painted behind it, and holds the whole design to WCAG AA.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDisplaySvg, approxWidth, contrastRatio } from './svg';
import { THEMES, simplePage } from './theme';
import { normTimetable } from '../validate';
import type { Timetable } from '../types';

const NOW = new Date('2026-09-11T17:40:00Z');

function tt(over: Record<string, unknown> = {}): Timetable {
  return normTimetable({
    masjidName: 'Madani Academy Masjid',
    latitude: 40.2415,
    longitude: -75.2838,
    timezone: 'America/New_York',
    jumuah: ['13:30', '14:30'],
    layout: 'simple',
    ...over,
  });
}

/** The page colour the frame actually used: the first full-width rect it paints. */
function pageOf(svg: string): string {
  const m = /<rect x="0\.0" y="0\.0" width="\d+\.0" height="\d+\.0"[^>]*fill="(#[0-9a-f]{6})"/i.exec(svg);
  assert.ok(m, 'no page rect found');
  return m![1].toLowerCase();
}

// ── the presets reach Simple ─────────────────────────────────────────────────

test('the page tokens survive validation, and nothing else does', () => {
  assert.equal(tt({ simpleBg: 'theme-light' }).simpleBg, 'theme-light');
  assert.equal(tt({ simpleBg: 'theme-dark' }).simpleBg, 'theme-dark');
  assert.equal(tt({ simpleBg: '#123456' }).simpleBg, '#123456');
  assert.equal(tt({ simpleBg: 'theme-teal' }).simpleBg, '', 'an unknown token is not a colour');
  assert.equal(tt({ simpleBg: '' }).simpleBg, '');
});

test('an existing Simple screen is untouched — no value still means white', () => {
  // The whole reason the tokens are a new value rather than a change of meaning for the empty
  // one: every Simple screen already on a wall stores '' and must keep looking exactly as it did.
  assert.equal(pageOf(renderDisplaySvg(tt(), NOW, {})), '#ffffff');
  assert.equal(pageOf(renderDisplaySvg(tt({ themeId: 'twilight' }), NOW, {})), '#ffffff');
});

test('a theme page follows the theme', () => {
  const pages = new Set<string>();
  for (const th of THEMES) {
    for (const mode of ['theme-light', 'theme-dark']) {
      const page = pageOf(renderDisplaySvg(tt({ themeId: th.id, simpleBg: mode }), NOW, {}));
      assert.equal(page, simplePage(th.palette.primary, mode === 'theme-dark' ? 'dark' : 'light').toLowerCase());
      pages.add(page);
    }
  }
  // Two themes share an accent (Parchment and Emerald), and on this design an accent is most of
  // what a theme IS — so 20 clicks give 18 pages, not 20, and that is the honest number.
  assert.equal(pages.size, 18, `expected 18 distinct pages, saw ${pages.size}`);
});

test('…and follows a CUSTOM accent, not just a preset', () => {
  // This is why the token is stored rather than the hex it resolves to. Storing the colour would
  // freeze the pairing at the moment the admin clicked, and picking a new accent afterwards would
  // leave the page behind it.
  const a = pageOf(renderDisplaySvg(tt({ simpleBg: 'theme-dark', accent: '#ff0000' }), NOW, {}));
  const b = pageOf(renderDisplaySvg(tt({ simpleBg: 'theme-dark', accent: '#0000ff' }), NOW, {}));
  assert.notEqual(a, b);
  assert.equal(a, simplePage('#ff0000', 'dark').toLowerCase());
});

test('the light page is light and the dark page is dark, for every accent', () => {
  for (const th of THEMES) {
    const light = simplePage(th.palette.primary, 'light');
    const dark = simplePage(th.palette.primary, 'dark');
    assert.ok(contrastRatio(light, '#000000') > 15, `${th.id}: the light page is not light (${light})`);
    assert.ok(contrastRatio(dark, '#ffffff') > 12, `${th.id}: the dark page is not dark (${dark})`);
  }
});

// ── and every one of them is readable ────────────────────────────────────────

type Painted = { body: string; fill: string; bg: string; ratio: number };

/**
 * Every string on the frame, paired with the colour actually painted behind it.
 *
 * SVG paints in document order, so the background of a run is the LAST rect before it that
 * covers it — which is exactly what the eye sees, and is why this is read off the document
 * rather than recomputed from the palette. Rects with a translucent fill are skipped as
 * backgrounds (the Simple design uses solid mixes; the ticker band does not, and is not rendered
 * in these frames).
 */
function painted(svg: string, page: string): Painted[] {
  const rects: { x: number; y: number; w: number; h: number; fill: string; at: number }[] = [];
  for (const m of svg.matchAll(/<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"[^>]*fill="([^"]+)"/g)) {
    rects.push({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], fill: m[5], at: m.index! });
  }
  const out: Painted[] = [];
  for (const m of svg.matchAll(/<text ([^>]*)>(.*?)<\/text>/g)) {
    const at = (k: string) => new RegExp(`(?:^|\\s)${k}="([^"]*)"`).exec(m[1])?.[1] ?? '';
    const body = m[2].replace(/<[^>]*>/g, '');
    if (!body.trim()) continue;
    const size = Number(at('font-size'));
    const w = approxWidth(body, size) + Math.max(0, body.length - 1) * Number(at('letter-spacing') || 0);
    const anchor = at('text-anchor');
    const x = Number(at('x'));
    const cxT = (anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x) + w / 2;
    const cyT = Number(at('y')) - size * 0.26; // the middle of the cap height
    let bg = page;
    for (const r of rects) {
      if (r.at > m.index!) break;
      if (!/^#[0-9a-f]{6}$/i.test(r.fill)) continue;
      if (cxT >= r.x && cxT <= r.x + r.w && cyT >= r.y && cyT <= r.y + r.h) bg = r.fill;
    }
    out.push({ body, fill: at('fill'), bg, ratio: contrastRatio(at('fill'), bg) });
  }
  return out;
}

test('every string on a Simple screen clears WCAG AA against what is behind it', () => {
  // The guarantee the colour options rest on. Walked over every preset, both page modes, both
  // orientations and the three languages, because the pairing that fails is an accent against a
  // band mixed FROM that accent — which only some of the palettes produce.
  const bad: string[] = [];
  let checked = 0;
  for (const th of THEMES) {
    for (const simpleBg of ['', 'theme-light', 'theme-dark']) {
      for (const orientation of ['landscape', 'portrait']) {
        for (const language of ['en', 'ar']) {
          const t = tt({ themeId: th.id, simpleBg, orientation, language });
          const svg = renderDisplaySvg(t, NOW, {});
          for (const p of painted(svg, pageOf(svg))) {
            if (!/^#[0-9a-f]{6}$/i.test(p.fill)) continue; // rgba() — the faint decorative marks
            checked++;
            if (p.ratio < 4.5) {
              bad.push(`${th.id}/${simpleBg || 'white'}/${orientation}/${language}: "${p.body}" ${p.fill} on ${p.bg} = ${p.ratio.toFixed(2)}:1`);
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 2000, `expected to have checked plenty of runs, checked ${checked}`);
  assert.deepEqual(bad.slice(0, 10), [], `${bad.length} runs below AA`);
});
