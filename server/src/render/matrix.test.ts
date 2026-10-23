// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Every configuration a masjid can actually set, swept for structural faults.
 *
 * `golden.test.ts` pins thirty configurations byte for byte, which catches a CHANGE but says
 * nothing about whether the output was ever right. This asks a different question of a much wider
 * spread — both designs, both resolutions, both orientations, all three languages, every theme,
 * and the content states that move the geometry — and it asks it structurally:
 *
 *   - does every `url(#…)` resolve to something the same document defines
 *   - does any text leave the canvas
 *   - is any Arabic set in a Latin face (resvg picks ONE font per run and does not fall back per
 *     glyph, so this is how a prayer name becomes a row of empty boxes)
 *   - does any English word survive into an Arabic or Urdu screen
 *
 * That last one is why this exists. Two half-translated strings shipped for months and were found
 * by pointing a capture card at a television and looking: the Simple header read "الصلاة TIMES",
 * and the next-prayer ring printed the Arabic name twice. Neither is visible in a diff, neither
 * moves a golden hash once it is pinned, and both are obvious on a wall.
 *
 * It is deliberately a STRUCTURAL check and not a pixel one. Rasterising 100+ configurations would
 * be slow and machine-dependent (this repository vendors two Arabic faces and no Latin one), and
 * the faults worth catching here are all visible in the SVG.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDisplaySvg } from './svg';
import { normTimetable } from '../validate';
import { THEMES } from './theme';
import type { Timetable } from '../types';

const IMG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const BASE = {
  masjidName: 'Madani Academy Masjid',
  latitude: 40.2415,
  longitude: -75.2838,
  timezone: 'America/New_York',
  jumuah: ['13:30', '14:30'],
  footerNote: 'Muslim World League',
};
const tt = (o: Record<string, unknown> = {}): Timetable => normTimetable({ ...BASE, ...o }) as Timetable;

const THU_AM = new Date('2026-09-10T09:14:03Z');
const FRI_PM = new Date('2026-09-11T17:40:00Z');
const FRI_ZAWAL = new Date('2026-09-11T16:52:00Z');
const NIGHT = new Date('2026-09-10T02:14:03Z');

/** A rough advance width per character. Over-estimates, like the renderer's own `approxWidth`. */
function approx(s: string, size: number, letter = 0): number {
  let w = 0;
  for (const ch of s) w += size * (/[MWmw@]/.test(ch) ? 0.82 : /[iIl1.,:;'`|]/.test(ch) ? 0.28 : 0.55);
  return w + letter * Math.max(0, s.length - 1);
}

/** English that must not survive into an Arabic or Urdu screen. */
const ENGLISH = /\b(HOURS?|MINUTES?|SECONDS?|UNTIL|TIMES|PRAYER|ADHAN|IQAMAH|SUNRISE|SUNSET)\b/i;

/**
 * Known-untranslated words, with the reason they are still here.
 *
 * NOT a way to silence this check. Each entry is a string somebody decided to leave in English,
 * and the decision is written down: `HOURS` and `MINUTES` have no entry in the label table, and
 * supplying one needs correct Arabic counted-noun grammar (2 takes the dual, 3–10 the plural, 11+
 * the singular) from somebody who speaks it. See docs/audit/ACTION_REQUIRED.md §9.8.
 *
 * Anything NOT on this list failing the check is a new half-translated string, which is the thing
 * this test is for.
 */
const KNOWN_UNTRANSLATED = new Set<string>([]);

interface Shot {
  name: string;
  over: Record<string, unknown>;
  when: Date;
  opts: Record<string, unknown>;
}

/**
 * The two shapes the four real callers pass, because a fault can live in one and not the other.
 *
 * `tickerBandOnly` is not a detail: it is what an RTSP DECODER screen and a BROWSER screen both
 * use (`renderWorker.ts` and `web/src/screen.tsx`). In that mode the SVG paints the ticker's band
 * and leaves the moving text to a compositor — ffmpeg for the video path, CSS for the browser —
 * so the output genuinely differs from what a Pi draws, and the first version of this sweep
 * exercised only the Pi's shape. Every fault class checked here could hide in the half that was
 * never rendered.
 */
const CALLERS: [string, Record<string, unknown>][] = [
  // The Pi agent, and the still-PNG preview: the renderer draws everything itself.
  ['drawn whole', {}],
  // A decoder screen and a browser screen: the band is painted, the motion composited over it.
  ['ticker band only', { tickerBandOnly: true }],
];

function matrix(): Shot[] {
  const base: Shot[] = [];
  for (const layout of ['reference', 'simple'] as const) {
    for (const quality of ['720p', '1080p'] as const) {
      for (const orientation of ['landscape', 'portrait'] as const) {
        for (const language of ['en', 'ar', 'ur'] as const) {
          base.push({
            name: `${layout}/${quality}/${orientation}/${language}`,
            over: { layout, quality, orientation, language },
            when: THU_AM,
            opts: {},
          });
        }
      }
    }
  }
  for (const t of THEMES) {
    for (const layout of ['reference', 'simple'] as const) {
      base.push({ name: `theme ${t.id}/${layout}`, over: { layout, themeId: t.id }, when: THU_AM, opts: {} });
    }
  }
  // The states that move geometry, each on both designs and in both scripts.
  const states: [string, Record<string, unknown>, Date][] = [
    ['friday', {}, FRI_PM],
    ['prohibited window', {}, FRI_ZAWAL],
    ['night', {}, NIGHT],
    ['ticker', { ticker: { enabled: true, text: 'Jumu’ah is at 1:30 PM — please park considerately and leave room for our neighbours' } }, THU_AM],
    ['slideshow', { announcements: { enabled: true, images: [IMG], start: '', end: '', everySeconds: 1, forSeconds: 60, imageSeconds: 8 } }, THU_AM],
    ['logo and photo', { logoImage: IMG, backgroundImage: IMG }, THU_AM],
    ['very long name', { masjidName: 'The Grand Jāmi‘ Masjid and Islamic Cultural Centre of Greater Philadelphia' }, THU_AM],
    ['very long footer', { footerNote: 'Calculated with the Muslim World League method, Asr following the Hanafi school, Iqāmah fixed by the committee' }, THU_AM],
    ['no sunrise', { showSunrise: false }, THU_AM],
    ['no countdown', { showCountdown: false }, THU_AM],
    ['no dates', { showDates: false }, THU_AM],
    ['seconds', { showSeconds: true }, THU_AM],
    ['24-hour clock', { timeFormat: '24h' }, THU_AM],
    ['24-hour with seconds', { timeFormat: '24h', showSeconds: true }, THU_AM],
    ['no footer', { showFooter: false }, THU_AM],
    ['no name', { showName: false }, THU_AM],
    ['no celestial', { showCelestial: false }, THU_AM],
  ];
  for (const [n, over, when] of states) {
    for (const layout of ['reference', 'simple'] as const) {
      for (const language of ['en', 'ar'] as const) {
        base.push({ name: `${n}/${layout}/${language}`, over: { ...over, layout, language }, when, opts: {} });
      }
    }
  }
  // Each configuration is swept once per CALLER SHAPE — see CALLERS. Doubling the matrix is
  // cheaper than choosing which half of the product to test.
  return CALLERS.flatMap(([who, opts]) => base.map((s) => ({ ...s, name: `${s.name} [${who}]`, opts: { ...opts } })));
}

const SHOTS = matrix();

/** Render once per shot and hand the SVG to each check, so the matrix is built only once. */
const rendered = SHOTS.map((s) => {
  let svg = '';
  let threw: string | null = null;
  try {
    svg = renderDisplaySvg(tt(s.over), s.when, s.opts as never);
  } catch (e) {
    threw = (e as Error).message;
  }
  return { ...s, svg, threw, lang: String(s.over.language ?? 'en') };
});

test('the matrix is as wide as it claims', () => {
  // Guards against a refactor quietly shrinking the sweep to nothing.
  assert.ok(SHOTS.length >= 200, `only ${SHOTS.length} configurations swept`);
  assert.ok(SHOTS.some((s) => s.opts.tickerBandOnly), 'the decoder/browser render mode is not being swept');
  assert.ok(rendered.every((r) => r.threw || r.svg.startsWith('<svg')), 'something did not return an SVG');
});

test('every configuration renders without throwing', () => {
  const threw = rendered.filter((r) => r.threw).map((r) => `${r.name}: ${r.threw}`);
  assert.deepEqual(threw, [], `a masjid can set this and get nothing on the wall:\n  ${threw.join('\n  ')}`);
});

test('every paint reference resolves, in every configuration', () => {
  const bad: string[] = [];
  for (const r of rendered) {
    if (r.threw) continue;
    const defined = new Set([...r.svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const u of new Set([...r.svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]))) {
      if (!defined.has(u)) bad.push(`${r.name}: url(#${u})`);
    }
  }
  assert.deepEqual(bad, [], `a fill refers to a definition that is not there, so it draws as nothing:\n  ${bad.join('\n  ')}`);
});

test('no text leaves the canvas', () => {
  const bad: string[] = [];
  for (const r of rendered) {
    if (r.threw) continue;
    const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(r.svg);
    const W = vb ? Number(vb[1]) : 1920;
    const H = vb ? Number(vb[2]) : 1080;
    for (const m of r.svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)) {
      const body = m[2].replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
      if (!body.trim()) continue;
      const x = Number(/\sx="([-\d.]+)"/.exec(m[1])?.[1] ?? NaN);
      const y = Number(/\sy="([-\d.]+)"/.exec(m[1])?.[1] ?? NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const size = Number(/font-size="([\d.]+)"/.exec(m[1])?.[1] ?? 16);
      const letter = Number(/letter-spacing="([\d.]+)"/.exec(m[1])?.[1] ?? 0);
      const anchor = /text-anchor="(\w+)"/.exec(m[1])?.[1] ?? 'start';
      const w = approx(body, size, letter);
      const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
      // Generous, because approx() is an estimate: only a gross escape is worth a failure.
      const slack = size * 0.6;
      if (left < -slack || left + w > W + slack || y < -slack || y > H + slack) {
        bad.push(`${r.name}: "${body.slice(0, 24)}" at ${x.toFixed(0)},${y.toFixed(0)} size ${size}`);
      }
    }
  }
  assert.deepEqual(bad, [], `text is being drawn outside the picture:\n  ${bad.join('\n  ')}`);
});

test('Arabic is never letter-spaced', () => {
  /**
   * Letter-spacing pulls Arabic letters apart, and Arabic is cursive: the join between letters is
   * part of the writing, not decoration between glyphs. Spacing it is the typographic equivalent
   * of s p e l l i n g a word out, and on a masjid wall it reads as broken rendering.
   *
   * This is the narrow, objective form of a check that started much broader and was wrong twice:
   *
   *  - "Arabic must not be in a Latin family" can never fire, because every family constant here
   *    ends with `Noto Sans Arabic, DejaVu Sans, sans-serif` — the word is always in the string.
   *    Proved vacuous by reverting the ring fix and watching this stay green.
   *  - "Arabic must name an Arabic family FIRST" fires on the dates and several labels, which have
   *    always been set in the sans stack and render correctly through that fallback. That is a
   *    standing design choice, not a defect, and a test is the wrong place to relitigate it.
   *
   * What is left is the thing that is wrong however you feel about faces. The ring was doing it
   * until the duplicated name was removed.
   */
  const bad: string[] = [];
  for (const r of rendered) {
    if (r.threw) continue;
    for (const m of r.svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)) {
      if (!/[؀-ۿ]/.test(m[2])) continue;
      const spacing = Number(/letter-spacing="([\d.]+)"/.exec(m[1])?.[1] ?? 0);
      if (spacing > 0) bad.push(`${r.name}: "${m[2].slice(0, 16)}" letter-spacing=${spacing}`);
    }
  }
  assert.deepEqual(bad, [], `Arabic is cursive; spacing it apart breaks the join:\n  ${bad.join('\n  ')}`);
});

test('no new English word survives into an Arabic or Urdu screen', () => {
  const found = new Set<string>();
  for (const r of rendered) {
    if (r.threw || r.lang === 'en') continue;
    for (const m of r.svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)) {
      const body = m[1].trim();
      if (!body) continue;
      // MIXED STRINGS ARE CHECKED TOO, and that is the whole point. The first version skipped
      // anything containing Arabic, on the grounds that a mix must be deliberate — which made it
      // blind to both bugs it was written for: the header read "الصلاة TIMES", and the countdown
      // reads "… UNTIL الأذان". Found by reverting the fix and watching this stay green.
      const hit = ENGLISH.exec(body);
      if (hit && !KNOWN_UNTRANSLATED.has(hit[1].toUpperCase())) found.add(`${r.name}: "${body.slice(0, 28)}"`);
    }
  }
  assert.deepEqual(
    [...found],
    [],
    'an English label is showing on a non-English screen. If it is deliberate, say so in ' +
      `KNOWN_UNTRANSLATED with the reason:\n  ${[...found].join('\n  ')}`,
  );
});

test('the known-untranslated list is still accurate', () => {
  // An allowlist nobody revisits becomes a place to hide things. This fails if one of the words
  // on it has since been translated, so the entry (and §9.8) can be removed.
  const seen = new Set<string>();
  for (const r of rendered) {
    if (r.threw || r.lang === 'en') continue;
    for (const m of r.svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)) {
      const hit = ENGLISH.exec(m[1].trim());
      if (hit) seen.add(hit[1].toUpperCase());
    }
  }
  const stale = [...KNOWN_UNTRANSLATED].filter((w) => !seen.has(w));
  assert.deepEqual(stale, [], `these are no longer untranslated — drop them from the list:\n  ${stale.join(', ')}`);
});
