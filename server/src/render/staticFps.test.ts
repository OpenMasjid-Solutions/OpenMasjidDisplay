// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A timetable with no ticker has nothing on it that moves, so its output frame rate is pure cost.
 * It was 15; measured in the shipped container the encoder was ~3.5x the SVG renderer, making this
 * the largest single lever on CPU for a masjid with no hardware encoder.
 *
 * The bug worth a permanent test is not the number, it is the DRIFT. The frame rate is set in two
 * places — the filter chain that produces frames, and the encoder flags that consume them — and
 * they must agree. If the filter emits more than the encoder wants, ffmpeg scales and formats every
 * surplus frame and then discards it, paying the full price of the higher rate and showing none of
 * it. Nothing about the output looks wrong when that happens, which is exactly why it survived.
 */
import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { timetableVf, STATIC_FPS, type TickerSpec } from './renderer';

const D = { width: 1920, height: 1080 };
const SRC = fs.readFileSync(path.resolve(__dirname, 'renderer.ts'), 'utf8');

test('a static timetable is encoded well below the ticker rate', () => {
  // Not asserting 8 exactly — that is a tuning decision. Asserting it is low enough to be worth
  // having (the whole point) and high enough that commodity decoders and browsers stay happy.
  assert.ok(STATIC_FPS >= 5 && STATIC_FPS <= 10, `STATIC_FPS out of sane range: ${STATIC_FPS}`);
});

test('the filter feeds exactly the frame rate the encoder is set to', () => {
  const vf = timetableVf(D, null);
  assert.match(vf, new RegExp(`fps=${STATIC_FPS}(,|$)`), `no-ticker filter should ask for ${STATIC_FPS} fps: ${vf}`);
  // The encoder side of the same decision. Read from source because timetableArgs is private, and
  // exporting an ffmpeg argv builder just to satisfy a test would be worse than reading the line.
  assert.match(
    SRC,
    /const ofps = ticker \? TICKER_FPS : STATIC_FPS;/,
    'timetableArgs must take its no-ticker fps from STATIC_FPS, not a literal',
  );
  // And no stray literal can creep back into the timetable filter.
  assert.doesNotMatch(timetableVf(D, null), /fps=1[0-9]/, 'a literal frame rate is back in timetableVf');
});

test('a ticker still gets the smooth rate — this saving must not touch motion', () => {
  const ticker: TickerSpec = {
    text: 'x',
    textfile: '/data/ticker_x.txt',
    fontfile: '/app/fonts/NotoSans-Regular.ttf',
    speed: 5,
    prohibited: false,
    color: '#ffffff',
  };
  const withTicker = timetableVf(D, ticker);
  assert.doesNotMatch(withTicker, new RegExp(`fps=${STATIC_FPS}\b`), 'the ticker path must not be slowed');
});
