// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The scrolling ticker is the one piece of text the renderer does NOT draw.
 *
 * On an RTSP decoder screen the SVG paints the ticker's band and ffmpeg's `drawtext` scrolls the
 * message over it, because that is what keeps the motion smooth between 1 fps renders. So it is
 * the one string that misses the renderer's font handling entirely — and it was being handed
 * `NotoSans-Bold`, which contains no Arabic.
 *
 * Rendered through ffmpeg on the real board with mixed Arabic + Latin ticker text:
 *
 *     NotoSans-Bold      every Arabic character is a TOFU BOX; the Latin is fine
 *     Amiri-Regular      Arabic shaped and joined, right to left, AND the Latin renders
 *     NotoNaskhArabic    Arabic fine; the LATIN is tofu
 *
 * So a masjid that put an Arabic announcement on the ticker got a row of empty boxes on every
 * decoder screen, while the same message was correct on a Raspberry Pi (which draws its own
 * ticker) and in a browser (where CSS moves it). ffmpeg's drawtext does shape Arabic properly in
 * these builds; the only thing missing was a font with the glyphs in it.
 *
 * The check here is on the GLYPHS, not on the filename — a face is only a fix if it can actually
 * draw the characters, and that is a property of the file rather than of what it is called. That
 * distinction is how the bug survived: "it is Noto, and Noto has Arabic" is true of the FAMILY and
 * false of the FILE. Read straight out of the real `NotoSans-Bold.ttf` off the Pi:
 *
 *     NotoSans-Bold    covers Latin: true   covers Arabic: FALSE
 *     Amiri-Regular    covers Latin: true   covers Arabic: true
 *
 * ## What this file cannot prove on its own
 *
 * It pins OMD_FONT_DIR to `assets/fonts`, which vendors Amiri and Noto Naskh and NO Latin face —
 * the container gets one from `fonts-noto-core` and the Pi installer puts the curated set in
 * /usr/share/fonts. So in this fixture there is nothing but Arabic-capable fonts to choose, every
 * assertion below passes whatever the selection logic does, and reverting the fix does NOT turn
 * this red. Checked, rather than assumed.
 *
 * The assertions are still the right invariant — "whatever was chosen must be able to draw the
 * message" — and they would catch a future font set that breaks it. But the evidence that the bug
 * was real and is fixed is the table above and the ffmpeg render, both taken on the board.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.OMD_FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { tickerFontFile } = require('./fonts') as typeof import('./fonts');

const ARABIC = 'الجمعة الساعة ١:٣٠';
const LATIN = "Jumu'ah at 1:30 PM";
const MIXED = `${ARABIC} — ${LATIN}`;

/**
 * Does this TrueType file have a glyph for every one of these characters?
 *
 * Reads the `cmap` table directly rather than pulling in a font library: formats 4 and 12 cover
 * every face this app ships, and a missing glyph is exactly what a tofu box is.
 */
function covers(file: string, text: string): boolean {
  const buf = fs.readFileSync(file);
  const numTables = buf.readUInt16BE(4);
  let cmapOff = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString('ascii', rec, rec + 4) === 'cmap') cmapOff = buf.readUInt32BE(rec + 8);
  }
  if (!cmapOff) return false;

  const chars = new Set([...text].map((c) => c.codePointAt(0)!).filter((c) => c > 0x20));
  const found = new Set<number>();
  const nSub = buf.readUInt16BE(cmapOff + 2);
  for (let i = 0; i < nSub; i++) {
    const sub = cmapOff + buf.readUInt32BE(cmapOff + 4 + i * 8 + 4);
    const format = buf.readUInt16BE(sub);
    if (format === 4) {
      const segX2 = buf.readUInt16BE(sub + 6);
      const ends = sub + 14;
      const starts = ends + segX2 + 2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = buf.readUInt16BE(ends + s * 2);
        const start = buf.readUInt16BE(starts + s * 2);
        for (const c of chars) if (c >= start && c <= end && end !== 0xffff) found.add(c);
      }
    } else if (format === 12) {
      const nGroups = buf.readUInt32BE(sub + 12);
      for (let g = 0; g < nGroups; g++) {
        const off = sub + 16 + g * 12;
        const start = buf.readUInt32BE(off);
        const end = buf.readUInt32BE(off + 4);
        for (const c of chars) if (c >= start && c <= end) found.add(c);
      }
    }
  }
  return [...chars].every((c) => found.has(c));
}

test('an Arabic ticker is given a font that can actually draw Arabic', () => {
  const file = tickerFontFile(ARABIC);
  assert.ok(file, 'no ticker font was chosen at all');
  assert.ok(covers(file, ARABIC), `${path.basename(file)} has no glyphs for the Arabic in the ticker`);
});

test('a ticker mixing Arabic and Latin is drawn in ONE font that has both', () => {
  // ffmpeg draws the whole message with a single font file: there is no per-glyph fallback, so a
  // face missing either script produces tofu on that side. This is why Amiri is preferred over
  // Noto Naskh, whose Latin is tofu.
  const file = tickerFontFile(MIXED);
  assert.ok(file);
  assert.ok(covers(file, ARABIC), `${path.basename(file)} cannot draw the Arabic half`);
  assert.ok(covers(file, LATIN), `${path.basename(file)} cannot draw the Latin half`);
});

test('an English ticker keeps the face it has always had', () => {
  // The fix is per message on purpose: every masjid running an English ticker today should see no
  // change at all, so this must NOT quietly restyle them onto the Arabic face.
  //
  // Only checkable where a Latin face actually exists. This repository vendors Amiri and Noto
  // Naskh and NO Latin face — the container gets `fonts-noto-core` from apt and the Pi installer
  // puts the curated set in /usr/share/fonts — so with OMD_FONT_DIR pointed at assets/ there is
  // nothing else to choose and Amiri is correctly picked for everything. Asserting otherwise here
  // would be asserting the test fixture, not the behaviour.
  const file = tickerFontFile(LATIN);
  assert.ok(file);
  assert.ok(covers(file, LATIN), 'an English ticker must at least be drawable');
  const arabicFile = tickerFontFile(ARABIC)!;
  if (path.basename(file) !== path.basename(arabicFile)) {
    assert.ok(
      !/Amiri|Naskh/i.test(path.basename(file)),
      `an English ticker should not be switched to the Arabic face (got ${path.basename(file)})`,
    );
  }
});

test('the Urdu ticker is covered too, not just Arabic', () => {
  // Urdu is Arabic script with extra letters; a face with Arabic but not those is still tofu.
  const urdu = 'جمعہ کی نماز ۱:۳۰ بجے';
  const file = tickerFontFile(urdu);
  assert.ok(file, 'no font chosen for an Urdu ticker');
  assert.ok(covers(file, urdu), `${path.basename(file)} has no glyphs for the Urdu in the ticker`);
});

test('the glyph check can tell a missing glyph from a present one', () => {
  // Otherwise every assertion above passes by accident, which is exactly how the bug survived:
  // "the font is called Noto Sans, Noto has Arabic" is true of the FAMILY and false of the FILE.
  //
  // Checked against a script no face here carries, rather than against Arabic — in this fixture
  // the only fonts available ARE the Arabic ones, so "the Latin face lacks Arabic" would fail for
  // the wrong reason.
  const chosen = tickerFontFile(ARABIC)!;
  assert.equal(covers(chosen, ARABIC), true, 'the chosen face must cover the Arabic it was chosen for');
  assert.equal(covers(chosen, '漢字'), false, 'the glyph reader is returning true for glyphs that are not there');
});
