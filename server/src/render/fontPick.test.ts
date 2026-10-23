// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Which faces get loaded — and why a standalone screen cannot be left to guess.
 *
 * This is in a file of its own because `fontOptions()` memoises its scan on first call, so the
 * directory has to be chosen before anything else imports it. Node's test runner gives each file
 * its own process, which is what makes that possible.
 *
 * The measurement behind it, taken on an Arabic timetable rendered three ways:
 *
 *   no font files, system fonts off   →   22 KB,  167 ink   (every string missing)
 *   Amiri named explicitly            →  127 KB, 1258 ink   (correct)
 *   Amiri + Naskh, as this picks      →  127 KB, 1258 ink   (correct)
 *
 * Note what the first row is. It is not "Arabic came out as boxes" — the clock, the prayer
 * times, the date and the countdown were all gone too, leaving the bands and the weather icons
 * on an otherwise blank screen. An adopted screen is handed its faces by the server; a
 * standalone one has to find them, and if it finds none it must say so rather than hang a blank
 * board in a hall.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

// Before the import below — the scan runs once, on first call, and is cached from then on.
process.env.OMD_FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fontOptions } = require('./fonts') as typeof import('./fonts');

test('the vendored faces are found, and an Arabic one is among them', () => {
  const o = fontOptions();
  assert.ok(o.fontFiles && o.fontFiles.length > 0, 'no font files were chosen at all');
  assert.equal(o.loadSystemFonts, false, 'naming files and ALSO loading system fonts is not the contract');
  const arabic = o.fontFiles!.filter((f) => /amiri|arabic/i.test(path.basename(f)));
  assert.ok(arabic.length > 0, `no Arabic face among ${o.fontFiles!.map((f) => path.basename(f)).join(', ')}`);
});

test('a default family is named, and it is a family rather than a filename', () => {
  // resvg resolves `defaultFontFamily` as a FAMILY name. Naming a file ("DejaVuSans") names a
  // family that is not loaded, so resvg substitutes something else and text laid out with one
  // set of metrics is drawn with another — which is how it ends up outside the boxes around it.
  const o = fontOptions();
  assert.ok(o.defaultFontFamily, 'something has to be the default');
  assert.ok(!/\.(ttf|otf)$/i.test(o.defaultFontFamily), 'that is a filename, not a family');
  assert.equal(o.serifFamily ?? o.defaultFontFamily, o.defaultFontFamily, 'serif resolves to a loaded face');
});

test('the set stays small', () => {
  // Every file here is parsed on every frame, on a board that has one second to draw.
  assert.ok(fontOptions().fontFiles!.length <= 5, 'the curated set is meant to be small');
});
