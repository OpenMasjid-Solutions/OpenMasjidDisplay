// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * What resolution a decoder screen is actually rasterised at.
 *
 * This existed as a constant with a plausible justification and no measurement: every 1080p decoder
 * screen was rasterised at 1280 and upscaled by ffmpeg, because a comment said a 720p frame is
 * "~2.25× cheaper". That is the pixel-count ratio. The measured ratio is 1.25 — most of resvg's time
 * goes on parsing and tessellating an SVG, which does not care how big it is drawn — so the cap was
 * costing every announcement photograph a 1.5x upscale to save a quarter of one thread.
 *
 * The lesson it repeats is the reason this file exists at all: STATIC_FPS was set to 15 on the
 * strength of "the encoder has ample headroom", which measurement found to be backwards. Both
 * numbers were load-bearing, plausible, and wrong. So the size is now decided from what renders
 * actually cost on the box, and the properties that makes correct are pinned here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderDimsFor, noteRenderCost, __resetRenderCostForTests } from './renderer';

const HD = { width: 1920, height: 1080 };
const SD = { width: 1280, height: 720 };

test('a screen is rasterised at its own resolution by default', () => {
  __resetRenderCostForTests();
  // The whole point. A 1080p screen gets a 1080p frame, so an announcement photograph is not blown
  // up 1.5x by ffmpeg on its way to the wall.
  assert.deepEqual(renderDimsFor(HD), HD);
  assert.deepEqual(renderDimsFor(SD), SD, 'and 720p was always 1:1');
});

test('a box that cannot keep up is capped, and only after enough samples to be sure', () => {
  __resetRenderCostForTests();
  // Nine slow renders is not a verdict: the first render of a process pays for fonts loading and a
  // cold JIT, and judging a machine on that would cap a box that is perfectly capable.
  for (let i = 0; i < 9; i++) {
    assert.equal(noteRenderCost(5000, true), false, `sample ${i + 1} must not decide anything`);
  }
  assert.deepEqual(renderDimsFor(HD), HD, 'still full resolution while it is undecided');
  assert.equal(noteRenderCost(5000, true), true, 'the tenth completes the median');
  assert.deepEqual(renderDimsFor(HD), { width: 1280, height: 720 }, 'and it drops to the cap');
});

test('a fast box is never capped', () => {
  __resetRenderCostForTests();
  for (let i = 0; i < 30; i++) assert.equal(noteRenderCost(120, true), false);
  assert.deepEqual(renderDimsFor(HD), HD);
});

test('one slow render among fast ones does not cap the box', () => {
  __resetRenderCostForTests();
  // A median, not a max. The reconcile, a backup, or anything else on the machine can steal a
  // second, and a screen must not lose its picture quality for good because of one of them.
  for (const ms of [120, 130, 4000, 125, 140, 118, 133, 127, 122, 131]) noteRenderCost(ms, true);
  assert.deepEqual(renderDimsFor(HD), HD);
});

test('the verdict is one-way, because reversing it would respawn ffmpeg', () => {
  __resetRenderCostForTests();
  for (let i = 0; i < 10; i++) noteRenderCost(5000, true);
  assert.deepEqual(renderDimsFor(HD), { width: 1280, height: 720 });
  // A box hovering at the threshold would otherwise flip back and forth, and every flip respawns
  // ffmpeg and drops every decoder watching it. A slightly soft picture is a far better failure
  // than a screen that reconnects every thirty seconds.
  for (let i = 0; i < 50; i++) assert.equal(noteRenderCost(50, true), false, 'nothing re-opens the verdict');
  assert.deepEqual(renderDimsFor(HD), { width: 1280, height: 720 });
});

test('a capped render is not a sample', () => {
  __resetRenderCostForTests();
  // Feeding capped timings into the median would make it drift down and mean nothing: they are
  // cheaper by construction, and the question is whether the FULL render fits.
  for (let i = 0; i < 40; i++) assert.equal(noteRenderCost(5000, false), false);
  assert.deepEqual(renderDimsFor(HD), HD, 'a slow capped render says nothing about the full one');
});

test('the measurement that replaced the guess is written down', () => {
  // A number in a comment is what went wrong here twice. If the numbers go, the next person has
  // nothing but the same plausible ratio to reason from.
  const src = fs.readFileSync(path.resolve(__dirname, 'renderer.ts'), 'utf8');
  assert.ok(/p50 135ms/.test(src) && /p50 168ms/.test(src), 'the measured render costs must stay recorded');
  assert.ok(/1\.25x/.test(src), 'and the ratio they give');
});
