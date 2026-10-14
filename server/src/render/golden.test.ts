// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Golden output for the renderer: the safety net for moving it.
 *
 * The Pi standalone work (docs/PI_STANDALONE_DESIGN.md, phase 1) lifts the renderer into a
 * shared area that both the server and the Pi agent import. That move must change nothing a
 * masjid can see, and "nothing changed" is not a claim anybody can make by reading a diff of a
 * file move — the whole point of a move is that the diff looks like nothing changed. So the
 * output of a spread of real configurations is pinned here first, and the move has to keep every
 * one of them byte-identical.
 *
 * **It pins the SVG, not the pixels, and that is deliberate.** The repository vendors two Arabic
 * faces and no Latin one, so resvg draws Latin text with whatever the host has — a rasterised
 * golden would encode the machine it was generated on and fail for the next person. The SVG is
 * the renderer's actual output; resvg's job starts after it. Every geometry, string, colour and
 * ordering decision this code makes is in that string, so a golden over it catches what a
 * picture would, and catches it the same way on Windows, in CI and on a Pi.
 *
 * **Regenerating is a decision, not a fix.** `OMD_GOLDEN_UPDATE=1 npm test` rewrites the table
 * and prints what moved. If a change was not intended, the right response is to find out why the
 * output moved, not to accept the new hash — the test cannot tell those two apart and will not
 * try.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderDisplaySvg } from './svg';
import { normTimetable } from '../validate';
import type { Timetable } from '../types';

const TABLE = path.join(__dirname, 'golden.json');
const UPDATE = process.env.OMD_GOLDEN_UPDATE === '1';

/** A 1x1 PNG. Enough to take the slideshow and logo code paths without a fixture file. */
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Fixed instants. A Friday afternoon for Jumu'ah, a weekday morning, and the minute before
 *  Dhuhr on a Friday, which is when the prohibited-time window is open. */
const FRI_PM = new Date('2026-09-11T17:40:00Z');
const THU_AM = new Date('2026-09-10T09:14:03Z');
const FRI_ZAWAL = new Date('2026-09-11T16:52:00Z');

const BASE = {
  masjidName: 'Madani Academy Masjid',
  latitude: 40.2415,
  longitude: -75.2838,
  timezone: 'America/New_York',
  jumuah: ['13:30', '14:30'],
  footerNote: 'Muslim World League',
};

const tt = (over: Record<string, unknown> = {}): Timetable => normTimetable({ ...BASE, ...over }) as Timetable;

interface Shot {
  name: string;
  tt: Record<string, unknown>;
  now: Date;
  opts?: Record<string, unknown>;
}

/**
 * The spread.
 *
 * Chosen so that each one would be the only one to catch something: the two designs, both
 * orientations, both qualities, the three languages (two of them right-to-left), the slideshow
 * composite, a ticker, the prohibited window, the Friday table, the seconds in both styles, and
 * a custom page colour. A matrix of everything crossed with everything would be thousands of
 * near-duplicates that nobody reads when one of them goes red.
 */
const SHOTS: Shot[] = [];
for (const layout of ['modern', 'simple']) {
  for (const orientation of ['landscape', 'portrait']) {
    SHOTS.push({ name: `${layout}-${orientation}`, tt: { layout, orientation }, now: FRI_PM });
    SHOTS.push({ name: `${layout}-${orientation}-720`, tt: { layout, orientation, quality: '720p' }, now: THU_AM });
    SHOTS.push({
      name: `${layout}-${orientation}-slideshow`,
      tt: { layout, orientation },
      now: THU_AM,
      opts: { announcement: IMG },
    });
  }
  SHOTS.push({ name: `${layout}-ar`, tt: { layout, language: 'ar' }, now: FRI_PM });
  SHOTS.push({ name: `${layout}-ur`, tt: { layout, language: 'ur' }, now: THU_AM });
  SHOTS.push({
    name: `${layout}-ticker`,
    tt: { layout, ticker: { enabled: true, messages: [{ id: 't1', text: 'Fundraising dinner this Saturday after Isha.', start: '', end: '' }] } },
    now: THU_AM,
  });
  SHOTS.push({
    name: `${layout}-zawal`,
    tt: { layout, prohibitedNotice: { enabled: true, ticker: false, minutes: 15 } },
    now: FRI_ZAWAL,
  });
  SHOTS.push({ name: `${layout}-seconds-stacked`, tt: { layout, showSeconds: true }, now: THU_AM });
  SHOTS.push({ name: `${layout}-seconds-inline`, tt: { layout, showSeconds: true, secondsStyle: 'inline' }, now: THU_AM });
  SHOTS.push({ name: `${layout}-sunrise-ishraq`, tt: { layout, showSunrise: true, ishraqMinutes: 20 }, now: THU_AM });
  SHOTS.push({ name: `${layout}-logo`, tt: { layout }, now: THU_AM, opts: { logo: IMG } });
}
SHOTS.push({ name: 'simple-page-colour', tt: { layout: 'simple', simpleBg: '#0b3d2e' }, now: FRI_PM });
SHOTS.push({ name: 'modern-ticker-band-only', tt: { layout: 'modern', ticker: { enabled: true, messages: [{ id: 't1', text: 'Band only.', start: '', end: '' }] } }, now: THU_AM, opts: { tickerBandOnly: true } });

const render = (s: Shot): string => renderDisplaySvg(tt(s.tt), s.now, s.opts ?? {});
const digest = (svg: string): string => crypto.createHash('sha256').update(svg).digest('hex').slice(0, 16);

const current: Record<string, string> = {};
for (const s of SHOTS) {
  assert.ok(!(s.name in current), `duplicate fixture name ${s.name}`);
  current[s.name] = digest(render(s));
}

const stored: Record<string, string> = fs.existsSync(TABLE) ? JSON.parse(fs.readFileSync(TABLE, 'utf8')) : {};

if (UPDATE) {
  fs.writeFileSync(TABLE, `${JSON.stringify(current, null, 2)}\n`);
  for (const k of Object.keys(current)) {
    if (stored[k] !== current[k]) console.log(`golden ${k}: ${stored[k] ?? '(new)'} -> ${current[k]}`);
  }
  for (const k of Object.keys(stored)) if (!(k in current)) console.log(`golden ${k}: removed`);
}

test('the renderer draws what it drew before', () => {
  assert.ok(Object.keys(stored).length > 0, `no golden table — run OMD_GOLDEN_UPDATE=1 to write ${TABLE}`);
  const moved: string[] = [];
  for (const s of SHOTS) {
    if (stored[s.name] !== current[s.name]) moved.push(s.name);
  }
  if (moved.length) {
    // The hash alone says nothing about WHAT moved, so put the actual output somewhere the
    // reader can diff it. A golden failure with no artefact is a golden failure nobody acts on.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-golden-'));
    for (const name of moved) {
      const s = SHOTS.find((x) => x.name === name)!;
      fs.writeFileSync(path.join(dir, `${name}.svg`), render(s));
    }
    assert.fail(
      `${moved.length} of ${SHOTS.length} fixtures changed: ${moved.join(', ')}\n` +
        `  the new output is in ${dir}\n` +
        `  if the change was intended: OMD_GOLDEN_UPDATE=1 npm test`,
    );
  }
});

test('every pinned fixture still exists', () => {
  // A fixture deleted rather than fixed is how a golden table quietly stops covering things.
  const gone = Object.keys(stored).filter((k) => !(k in current));
  assert.deepEqual(gone, [], `pinned fixtures no longer rendered: ${gone.join(', ')}`);
});

test('the fixtures actually differ from one another', () => {
  // A matrix whose knobs do nothing would pass the golden test for ever while covering one
  // picture. Each fixture must produce output no other fixture produces.
  const byHash = new Map<string, string[]>();
  for (const [name, h] of Object.entries(current)) byHash.set(h, [...(byHash.get(h) ?? []), name]);
  const dupes = [...byHash.values()].filter((names) => names.length > 1);
  assert.deepEqual(dupes, [], `fixtures render identically: ${dupes.map((d) => d.join(' == ')).join('; ')}`);
});

test('rendering is deterministic for a fixed instant', () => {
  // The whole table rests on this. Anything time-of-day dependent that read the wall clock
  // instead of `now` would make every golden flaky rather than wrong, which is worse.
  for (const s of SHOTS.slice(0, 6)) assert.equal(digest(render(s)), current[s.name], s.name);
});
