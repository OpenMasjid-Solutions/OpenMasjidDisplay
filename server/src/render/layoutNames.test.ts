// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Renaming the default design, and the migration that has to come with it.
 *
 * `layout` held 'centered' | 'clockTop' | 'split' | 'simple'. The first three were arrangements of
 * one look that v0.37.0 collapsed into a single design; they drew identical pixels for the thirty
 * releases after that and were kept only so stored timetables still rendered. That design is now
 * called 'modern', which leaves every timetable a masjid already has holding a name that no longer
 * exists.
 *
 * Plain validation cannot do that rename, and the way it fails is quiet: `oneOf` falls back to the
 * BASE value, and `normTimetable` is always called with the stored row as the base — so 'centered'
 * would validate into 'centered' for ever. The picker would offer Modern and Simple, the stored
 * value would match neither, and every existing timetable would look like the picker was broken.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDisplaySvg } from './svg';
import { normTimetable, normLayout } from '../validate';
import type { Timetable } from '../types';

const NOW = new Date('2026-08-21T20:11:00Z');

function tt(over: Record<string, unknown> = {}): Timetable {
  return normTimetable({
    masjidName: 'Madani Academy Masjid',
    latitude: 40.2415,
    longitude: -75.2838,
    timezone: 'America/New_York',
    jumuah: ['13:30', '14:30'],
    ...over,
  });
}

test('the three names this field used to hold all become the design they were already drawn as', () => {
  for (const old of ['centered', 'clockTop', 'split']) {
    assert.equal(normLayout(old), 'modern', `${old} must migrate`);
    // With a stale BASE as well — the case that actually happens, since every save passes the
    // stored row as the base and the stored row is what holds the old name.
    assert.equal(normLayout(old, old), 'modern');
    assert.equal(normLayout(undefined, old), 'modern');
  }
});

test('a timetable stored before the rename comes back as a design that exists', () => {
  const stored = { ...tt(), layout: 'split' as unknown as Timetable['layout'] };
  assert.equal(normTimetable({ name: 'edited' }, stored).layout, 'modern');
});

test('a real choice survives, in both directions', () => {
  assert.equal(normTimetable({ layout: 'simple' }).layout, 'simple');
  assert.equal(normTimetable({ layout: 'modern' }).layout, 'modern');
  // A simple timetable being edited keeps simple — the migration must not drag it to modern.
  const simple = tt({ layout: 'simple' });
  assert.equal(normTimetable({ name: 'renamed' }, simple).layout, 'simple');
  assert.equal(normLayout('nonsense', 'simple'), 'simple');
  assert.equal(normLayout(null), 'modern');
});

test('modern is what a fresh timetable gets', () => {
  assert.equal(normTimetable({}).layout, 'modern');
});

test('modern draws the themed design and simple draws the flat one', () => {
  // The names have to point at different pictures, or the rename is cosmetic.
  const modern = renderDisplaySvg(tt({ layout: 'modern' }), NOW);
  const simple = renderDisplaySvg(tt({ layout: 'simple' }), NOW);
  assert.notEqual(modern, simple);
  assert.ok(modern.includes('stroke-dasharray'), 'modern keeps the countdown ring');
  assert.ok(!simple.includes('stroke-dasharray'), 'simple has no ring');
  // And a migrated legacy value lands on the themed one, not on the flat one.
  const migrated = renderDisplaySvg(normTimetable({}, { ...tt(), layout: 'clockTop' as unknown as Timetable['layout'] }), NOW);
  assert.ok(migrated.includes('stroke-dasharray'), 'a migrated timetable keeps the design it had');
});

// ── the colour pass on the simple layout ───────────────────────────────────

test('the simple table is banded in the theme colour, not one flat wash', () => {
  const svg = renderDisplaySvg(tt({ layout: 'simple', themeId: 'cyan' }), NOW);
  // Every row band is a mix of the page colour toward the accent, so "more than one distinct band
  // colour" is the observable form of "it alternates".
  const fills = [...svg.matchAll(/<rect[^>]*fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
  assert.ok(new Set(fills).size >= 3, `expected several band colours, saw ${JSON.stringify([...new Set(fills)])}`);
});

test('the table has a filled title bar rather than grey text on the page', () => {
  const svg = renderDisplaySvg(tt({ layout: 'simple', themeId: 'cyan' }), NOW);
  const i = svg.indexOf('PRAYER TIMES');
  assert.ok(i > 0, 'the title is still there');
  // The band is drawn immediately before its text, in the theme's primary.
  assert.match(svg.slice(Math.max(0, i - 400), i), /<rect[^>]*fill="#22D3EE"/i, 'the title sits on a primary-filled band');
});

test('text on a filled band is chosen for contrast, not assumed', () => {
  // The accent is a colour input: an admin can set it to anything, including something pale. A
  // fixed light-on-primary would be white on pale yellow.
  const dark = renderDisplaySvg(tt({ layout: 'simple', accent: '#0b2f6b' }), NOW);
  const pale = renderDisplaySvg(tt({ layout: 'simple', accent: '#ffe08a' }), NOW);
  // Read the fill off the <text> element that CONTAINS the title, rather than the last fill= before
  // it: text() emits fill before text-anchor, so it is never the final attribute.
  const titleFill = (svg: string) => {
    const i = svg.indexOf('PRAYER TIMES');
    const el = svg.slice(svg.lastIndexOf('<text', i), i);
    return /fill="(#[0-9a-f]{6})"/i.exec(el)?.[1]?.toLowerCase();
  };
  assert.equal(titleFill(dark), '#f2f6f3', 'light text on a dark accent');
  assert.equal(titleFill(pale), '#1c2620', 'dark text on a pale accent');
});

test("Jumu'ah is marked out from the day's five prayers", () => {
  const svg = renderDisplaySvg(tt({ layout: 'simple', themeId: 'cyan' }), NOW);
  assert.match(svg, /JUMU/, "Jumu'ah is in the table");
  // Its Iqāmah time takes the theme's gold, which is what distinguishes it on a dark page where a
  // gold BAND cannot work — gold over dark navy comes out olive at every alpha.
  assert.ok(svg.includes('#F59E0B') || svg.includes('#f59e0b'), "the Jumu'ah time carries the gold");
});

// ── how Jumu'ah reads in the Simple table ───────────────────────────────────

test("Jumu'ah labels its times rather than calling itself \"1/2\"", () => {
  // The row carried a "1/2" suffix to explain that its two times were the first and second
  // jamā'ah rather than an Adhan and an Iqāmah. It reads as a fraction. The other layout had
  // already solved this by labelling each TIME with its ordinal, which is what this does now.
  const svg = renderDisplaySvg(tt({ layout: 'simple', jumuah: ['13:30', '14:30'] }), NOW);
  assert.ok(svg.includes('JUMU'), "the row is there");
  assert.ok(!svg.includes('1/2'), 'the fraction is gone');
  const after = svg.slice(svg.indexOf('JUMU'));
  const texts = [...after.matchAll(/>([^<>]{1,20})</g)].map((m) => m[1]);
  assert.deepEqual(texts.slice(0, 4), ['1st', '1:30 PM', '2nd', '2:30 PM'], 'each time carries its ordinal');
});

test("one Jumu'ah gets no ordinal at all", () => {
  const svg = renderDisplaySvg(tt({ layout: 'simple', jumuah: ['13:30'] }), NOW);
  const after = svg.slice(svg.indexOf('JUMU'));
  const texts = [...after.matchAll(/>([^<>]{1,20})</g)].map((m) => m[1]);
  assert.deepEqual(texts.slice(0, 1), ['1:30 PM'], 'a lone time needs no "1st"');
  assert.ok(!after.includes('1st'));
});
