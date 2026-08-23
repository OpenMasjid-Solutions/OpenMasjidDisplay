// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The rate limit on a screen's own endpoints, against how often a screen actually calls them.
 *
 * Third instance of one bug in this repository, and the first two are both written up in the code it
 * checks: a cap sized for one traffic pattern, later applied to another, with nothing comparing the
 * two. An HLS player pulling a segment a second tripped a limit sized for "a screen that asks twice a
 * minute" and the camera died after ten seconds. Then a check-in cap of 2,000 bytes silently rejected
 * every 9KB check-in for weeks.
 *
 * The third would have been a live preview: a Pi polls every 1.2s while one is open AND posts a frame
 * on every poll, which is ~100 requests a minute from one device against a cap of 120 — and behind
 * the platform's tunnel every screen in the masjid shares that address. The 429 lands on the STATE
 * POLL, so the failure is a television in a prayer hall saying it has lost contact with the server.
 *
 * So this test does not assert a number. It derives what a masjid's screens actually generate from
 * the cadences in the code, and insists the budgets cover it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PI_POLL_MS } from './piAgent';

const apiSrc = () => fs.readFileSync(path.resolve(__dirname, 'api.ts'), 'utf8');
const agentSrc = () => fs.readFileSync(path.resolve(__dirname, 'pi', 'index.ts'), 'utf8');

/** A limiter's budget per minute, read out of api.ts rather than copied. */
function budget(name: string): number {
  // `[\d_]`, not `\d`: every cap in api.ts is written with numeric separators (60_000), and `\d+`
  // stops at the underscore — which read the window as 60 milliseconds and failed on its own
  // assertion rather than on anything real.
  const m = new RegExp(`const ${name} = new RequestLimiter\\(([\\d_]+), ([\\d_]+)`).exec(apiSrc());
  assert.ok(m, `could not find ${name} in api.ts`);
  const per = Number(m[1].replace(/_/g, ''));
  const windowMs = Number(m[2].replace(/_/g, ''));
  assert.equal(windowMs, 60_000, `${name}'s window is not a minute; this test's arithmetic assumes it is`);
  return per;
}

/** The shortest interval the agent will poll at, read out of the agent. */
function fastPollMs(): number {
  const m = /Math\.min\(pollMs, (\d+)\)/.exec(agentSrc());
  assert.ok(m, 'could not find the fast-poll interval in the agent');
  return Number(m[1]);
}

/** How many screens on one address the budget should survive. Behind the platform's tunnel they all
 *  arrive from the ingress, so this is "screens in a masjid", not "screens on a subnet". */
const SCREENS = 6;

test('the poll budget survives a masjid of screens with their consoles open', () => {
  const perMinute = Math.ceil(60_000 / fastPollMs());
  // Each screen: a state poll per fast tick, plus a check-in, plus the occasional log upload.
  const needed = SCREENS * (perMinute + 2);
  assert.ok(
    budget('screenLimiter') >= needed,
    `${SCREENS} screens fast-polling generate ~${needed} requests a minute and the budget is ` +
      `${budget('screenLimiter')} — the 429 would land on a state poll, and the screen says "lost contact" on the wall`,
  );
});

test('a normal masjid is nowhere near the budget', () => {
  // The other direction: a limiter that has to be raised on every release is not bounding anything.
  const idle = Math.ceil(60_000 / PI_POLL_MS);
  assert.ok(
    budget('screenLimiter') > SCREENS * idle * 3,
    'the budget should be comfortable at the idle cadence, not merely sufficient',
  );
});

test('a live preview is budgeted as a stream, not as a poll', () => {
  // One frame per fast tick, per screen being watched. Two admins watching two screens is 100
  // requests a minute of pure image upload — which is the whole poll budget on its own.
  const src = apiSrc();
  assert.ok(
    /piMatch\[3\] === 'screenshot' \? screenMediaLimiter : screenLimiter/.test(src),
    'the screenshot upload must not share the poll budget',
  );
  const perMinute = Math.ceil(60_000 / fastPollMs());
  assert.ok(
    budget('screenMediaLimiter') >= SCREENS * perMinute,
    'and the media budget has to cover every screen being watched at once',
  );
});

test('the preview stops on its own, so the traffic cannot outlive the window watching it', () => {
  // The bound that matters is not the limiter, it is that nobody has to remember to turn this off.
  const src = apiSrc();
  const m = /const PREVIEW_WINDOW_MS = ([\d_]+);/.exec(src);
  assert.ok(m, 'the preview window must be a named constant');
  const windowMs = Number(m[1].replace(/_/g, ''));
  assert.ok(windowMs <= 30_000, `a preview lingers for ${windowMs}ms after its window closes; that is too long`);
  assert.ok(windowMs >= 10_000, 'and too short a window makes the picture stutter on a slow tunnel');

  // The panel has to beat comfortably faster than that, or the preview it is showing keeps lapsing.
  const panel = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'web', 'src', 'routes', 'PiDisplayPanel.tsx'),
    'utf8',
  );
  const b = /const BEAT_MS = (\d+);/.exec(panel);
  assert.ok(b, 'the panel must name its heartbeat');
  assert.ok(Number(b[1]) * 2 <= windowMs, 'a single lost beat must not interrupt the picture');
});

test('a heartbeat once a second does not rewrite the database once a second', () => {
  // store.update() rewrites db.json whole and runs every change listener. The preview beat is called
  // about once a second for as long as a window is open, so persisting its deadline meant rewriting a
  // masjid's entire configuration onto an SD card every second to record a fact that is meaningless
  // fifteen seconds later — and that does not survive a restart in any useful form anyway.
  const src = apiSrc();
  const route = src.slice(src.indexOf("const piPreview ="), src.indexOf('const piShot ='));
  assert.ok(route.length > 100, 'could not find the preview route');
  assert.ok(!/store\.update\(/.test(route), 'the preview beat must not write to the store');
  assert.ok(/markPreviewWanted\(/.test(route), 'it belongs in memory, beside the liveness map');
  // And it must genuinely be in memory rather than a field on the stored device.
  const types = fs.readFileSync(path.resolve(__dirname, 'types.ts'), 'utf8');
  assert.ok(!/previewUntil/.test(types), 'previewUntil must not be a persisted field');
});
