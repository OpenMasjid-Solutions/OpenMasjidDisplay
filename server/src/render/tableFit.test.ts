// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The prayer table has to FIT — every design, every screen shape, every language.
 *
 * Both tables size their type from the box they are given, and every layout bug this repository
 * has had in that code was the same shape: a size worked out from ONE axis, or from one shape of
 * box, holding right up until the box changed. "MAGHRIB" ran into "7:16 PM" when the table became
 * a narrow column; the Jumu'ah ordinal printed on top of the word JUMU'AH; the date line ran out
 * past the edge of its column. None of them were caught by a test, because the tests all asserted
 * that particular strings were present — which they were, on top of each other.
 *
 * So these tests measure. They render real documents across the whole space the app actually
 * draws — 1080p and 720p, landscape and portrait, Modern and Simple, English/Arabic/Urdu, 12h and
 * 24h, one/two/three Jumu'ah times, with and without a slideshow image beside the table — read
 * every `<text>` back out with the renderer's own width estimate, and assert two things that are
 * true of a laid-out page and false of a broken one:
 *
 *   1. no two drawn runs overlap, and
 *   2. nothing is drawn outside the frame.
 *
 * `approxWidth` over-estimates real text by 1–14%, and it is what the renderer positions with, so
 * boxes that clear each other by this measure clear each other on the screen by more.
 *
 * This is also the standing check behind TIME_SCALE and `simpleTable`'s own size solve: both were
 * raised because a masjid asked for larger times, and "does it still fit" is now a test rather
 * than a look at one 1080p frame.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDisplaySvg, approxWidth } from './svg';
import { normTimetable } from '../validate';
import type { Timetable } from '../types';

/** A Friday afternoon: the Jumu'ah row is in the table, which is the row that overflows. */
const NOW = new Date('2026-09-11T17:40:00Z');
const IMG = 'data:image/png;base64,iVBORw0KGgo=';

const BASE = {
  masjidName: 'Madani Academy Masjid',
  latitude: 40.2415,
  longitude: -75.2838,
  timezone: 'America/New_York',
};

type Run = { x: number; y: number; size: number; anchor: string; letter: number; body: string };

/** Every string the document draws, with what the renderer believes its extent to be. */
function runs(svg: string): Run[] {
  const out: Run[] = [];
  for (const m of svg.matchAll(/<text ([^>]*)>(.*?)<\/text>/g)) {
    const at = (k: string) => new RegExp(`(?:^|\\s)${k}="([^"]*)"`).exec(m[1])?.[1] ?? '';
    const body = m[2].replace(/<[^>]*>/g, ''); // the clock wraps its colon in a <tspan>
    if (!body.trim()) continue;
    out.push({
      x: Number(at('x')),
      y: Number(at('y')),
      size: Number(at('font-size')),
      anchor: at('text-anchor'),
      letter: Number(at('letter-spacing') || 0),
      body,
    });
  }
  return out;
}

/** Cap height above the baseline, descender below — the same proportions the layouts reserve. */
function box(r: Run) {
  const w = approxWidth(r.body, r.size) + Math.max(0, r.body.length - 1) * r.letter;
  const l = r.anchor === 'end' ? r.x - w : r.anchor === 'middle' ? r.x - w / 2 : r.x;
  return { l, r: l + w, t: r.y - r.size * 0.72, b: r.y + r.size * 0.2, body: r.body };
}

type Frame = { name: string; svg: string; W: number; H: number };

/**
 * Every shape the table is drawn in.
 *
 * No ticker anywhere in here, deliberately: the scrolling band TILES its message and clips the
 * result, so its runs legitimately sit beside and beyond each other and would fail both
 * invariants for a reason that is not a bug. What the ticker does to the layout — taking a strip
 * out of the bottom — is covered in announceComposite.test.ts.
 */
function frames(): Frame[] {
  const out: Frame[] = [];
  for (const quality of ['1080p', '720p']) {
    for (const layout of ['modern', 'simple']) {
      for (const orientation of ['landscape', 'portrait']) {
        for (const language of ['en', 'ar', 'ur']) {
          for (const timeFormat of ['12h', '24h']) {
            for (const jumuah of [['13:30', '14:30'], ['13:30'], ['13:30', '14:30', '15:30']]) {
              for (const ann of [null, IMG]) {
                const tt = normTimetable({ ...BASE, quality, layout, orientation, language, timeFormat, jumuah });
                const svg = renderDisplaySvg(tt as Timetable, NOW, ann ? { announcement: ann } : {});
                out.push({
                  name: `${quality} ${layout} ${orientation} ${language} ${timeFormat} j${jumuah.length}${ann ? ' +pic' : ''}`,
                  svg,
                  W: Number(/\swidth="(\d+)"/.exec(svg)![1]),
                  H: Number(/\sheight="(\d+)"/.exec(svg)![1]),
                });
              }
            }
          }
        }
      }
    }
  }
  return out;
}

const FRAMES = frames();

test('the shape space is actually being walked', () => {
  // A guard on the guard: a filter typo that rendered nothing would make every test below pass.
  assert.equal(FRAMES.length, 288);
  for (const f of FRAMES) assert.ok(runs(f.svg).length > 10, `${f.name} drew almost nothing`);
});

test('no two drawn strings overlap, in any shape the app renders', () => {
  const hits: string[] = [];
  for (const f of FRAMES) {
    const bs = runs(f.svg).map(box);
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i];
        const b = bs[j];
        const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l);
        const oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
        // Half a pixel of tolerance: every coordinate in the document is rounded to one decimal.
        if (ox > 0.5 && oy > 0.5) {
          hits.push(`${f.name}: "${a.body}" over "${b.body}" by ${ox.toFixed(0)}x${oy.toFixed(0)}px`);
        }
      }
    }
  }
  assert.deepEqual(hits.slice(0, 8), [], `${hits.length} overlapping pairs`);
});

test('nothing is drawn outside the frame', () => {
  // This is the form the Simple date bug took: not clipping, but a centred line hanging off its
  // own column and running out past the edge of the screen.
  const hits: string[] = [];
  for (const f of FRAMES) {
    for (const b of runs(f.svg).map(box)) {
      if (b.l < -0.5 || b.r > f.W + 0.5) hits.push(`${f.name}: "${b.body}" at [${b.l.toFixed(0)}, ${b.r.toFixed(0)}] in 0..${f.W}`);
      if (b.t < -0.5 || b.b > f.H + 0.5) hits.push(`${f.name}: "${b.body}" vertically [${b.t.toFixed(0)}, ${b.b.toFixed(0)}] in 0..${f.H}`);
    }
  }
  assert.deepEqual(hits.slice(0, 8), [], `${hits.length} runs outside the frame`);
});

// ── the Simple table's column headers ────────────────────────────────────────

function simple(over: Record<string, unknown> = {}): string {
  return renderDisplaySvg(normTimetable({ ...BASE, layout: 'simple', jumuah: ['13:30', '14:30'], ...over }) as Timetable, NOW, {});
}

test('the Simple table names its two time columns', () => {
  // It showed two times a row and said which was which nowhere — the complaint this answers.
  for (const [language, adhan, iqamah] of [
    ['en', 'ADHAN', 'IQĀMAH'],
    ['ar', 'الأذان', 'الإقامة'],
    ['ur', 'اذان', 'اقامہ'],
  ]) {
    const svg = simple({ language });
    assert.ok(svg.includes(adhan), `${language}: no Adhan column header`);
    assert.ok(svg.includes(iqamah), `${language}: no Iqamah column header`);
  }
});

test('each header is anchored to the very column it names', () => {
  // The whole value of a header is that it sits over its own column, so this compares the drawn
  // x of the label with the drawn x of the times under it rather than trusting that both were
  // derived from the same constant. A header naming the wrong column is worse than none.
  for (const orientation of ['landscape', 'portrait']) {
    const svg = simple({ orientation });
    const all = runs(svg);
    const ends = all.filter((r) => r.anchor === 'end');
    const times = ends.filter((r) => /^\d{1,2}:\d{2} [AP]M$/.test(r.body));
    const cols = [...new Set(times.map((r) => r.x))].sort((a, b) => a - b);
    assert.equal(cols.length, 2, `${orientation}: expected an Adhan and an Iqamah column, saw ${cols.length}`);
    for (const [label, col] of [
      ['ADHAN', cols[0]],
      ['IQĀMAH', cols[1]],
    ] as const) {
      const hdr = ends.find((r) => r.body === label);
      assert.ok(hdr, `${orientation}: ${label} is not right-anchored`);
      assert.equal(hdr!.x, col, `${orientation}: ${label} sits at ${hdr!.x}, its column is at ${col}`);
    }
  }
});

test('the header costs the rows no height — it is the band, not a line under it', () => {
  // Putting the column names on their own dim line below the band was the other way to do this,
  // and it would have taken the height out of the rows, which is where the times live. The
  // observable form: adding the labels must not have moved the first row down.
  const svg = simple();
  const top = runs(svg)
    .filter((r) => /^\d{1,2}:\d{2} [AP]M$/.test(r.body))
    .reduce((y, r) => Math.min(y, r.y), Infinity);
  const header = runs(svg).find((r) => r.body === 'ADHAN')!;
  assert.ok(top - header.y > 0, 'the first row is below the header');
  // The band is `titleSize * 2.1` tall and the rows start at `titleSize * 2.6` — so the gap
  // between the header baseline and the first row's is about one row, not one row plus a strip.
  assert.ok(top - header.y < (runs(svg).find((r) => r.body === 'FAJR')!.size) * 4, 'no extra strip was inserted');
});

// ── labels an admin can retype ───────────────────────────────────────────────

test('a renamed prayer or column still fits — the labels are an input, not a constant', () => {
  /**
   * Every string in this table is editable. `normLabels` takes up to 40 characters for any of
   * them, the prayer names carry `editId`s so they can be retyped straight on the live preview,
   * and the panel writes whatever is typed. So "ADHAN" and "MAGHRIB" are the DEFAULTS, not the
   * range, and two things sized against the defaults were wrong the moment somebody used the
   * feature:
   *
   *  - the prayer name's fixed 1px-per-gap tracking was left out of the row's width budget, so a
   *    renamed prayer spent room the solve had already given to its Adhan time and ran into it;
   *  - the ADHAN / IQĀMAH column labels were sized from the box HEIGHT and never measured against
   *    their own columns, so a long Iqamah label ran left across ADHAN.
   *
   * Both were found by review rather than by looking at frames, because the frames all used the
   * defaults. This walks the shapes where the columns are tightest with the labels at and near
   * the validator's own limit.
   */
  const LABELS: Record<string, string>[] = [
    { maghrib: 'Maghrib / Sunset' },
    { maghrib: 'Salatul Maghrib' },
    { maghrib: 'Maghrib (Sunset Prayer)' },
    { maghrib: 'M'.repeat(40) },
    { iqamah: 'Congregation Time' },
    { iqamah: 'Jamaah Starting Time For Today Insha Allah' },
    { athan: 'Call to Prayer' },
    { prayer: 'Prayer Schedule For The Whole Week' },
    { prayer: 'P'.repeat(40), athan: 'A'.repeat(40), iqamah: 'I'.repeat(40), maghrib: 'G'.repeat(40) },
  ];
  const hits: string[] = [];
  for (const labels of LABELS) {
    for (const quality of ['1080p', '720p']) {
      for (const orientation of ['landscape', 'portrait']) {
        for (const ann of [null, IMG]) {
          const t = normTimetable({ ...BASE, layout: 'simple', jumuah: ['13:30', '14:30'], quality, orientation, labels }) as Timetable;
          const svg = renderDisplaySvg(t, NOW, ann ? { announcement: IMG } : {});
          const bs = runs(svg).map(box);
          for (let i = 0; i < bs.length; i++) {
            for (let j = i + 1; j < bs.length; j++) {
              const a = bs[i];
              const b = bs[j];
              const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l);
              const oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
              if (ox > 0.5 && oy > 0.5) {
                hits.push(`${JSON.stringify(labels).slice(0, 44)} ${quality} ${orientation}${ann ? ' +pic' : ''}: "${a.body}" over "${b.body}" by ${ox.toFixed(0)}px`);
              }
            }
          }
        }
      }
    }
  }
  assert.deepEqual(hits.slice(0, 8), [], `${hits.length} overlapping pairs with renamed labels`);
});

test('when the band runs out of room the title goes first, and the labels last', () => {
  /**
   * The order of sacrifice, which is the whole design of this header. The title shrinks; then the
   * title is DROPPED; and only in a column too narrow for even that does a label get shortened.
   * The title names nothing, while ADHAN and IQĀMAH are the reason the band exists at all.
   *
   * Worth pinning as an order rather than as "it all fits": a rule where every string shrinks to
   * its own floor is not a fit, it is an overlap waiting for a long enough label, which is exactly
   * how this went wrong the first time.
   */
  const LABELS = { athan: 'Call to Prayer Adhan Time', iqamah: 'Congregation Starting Time' };
  /** The strings sharing the header's baseline — the title and the two column labels. */
  const header = (quality: string, beside: boolean): string[] => {
    const t = normTimetable({ ...BASE, layout: 'simple', quality, jumuah: ['13:30', '14:30'], labels: LABELS }) as Timetable;
    const svg = renderDisplaySvg(t, NOW, beside ? { announcement: IMG } : {});
    const heads = runs(svg).filter((r) => svg.indexOf(r.body) > 0 && r.body === r.body.toUpperCase());
    const band = heads.filter((r) => /PRAYER|CALL|CONGREGATION/.test(r.body));
    const top = Math.min(...band.map((r) => r.y));
    return band.filter((r) => r.y === top).map((r) => r.body);
  };

  const roomy = header('1080p', false);
  assert.ok(roomy.includes('PRAYER TIMES'), 'with room, the title stays');
  assert.ok(roomy.includes('CALL TO PRAYER ADHAN TIME'), 'and both labels are in full');
  assert.ok(roomy.includes('CONGREGATION STARTING TIME'));

  // The tightest column this app draws: the timetable beside a slideshow image on a 720p screen.
  const tight = header('720p', true);
  assert.ok(!tight.includes('PRAYER TIMES'), 'the title is what goes');
  assert.ok(tight.some((s) => s.startsWith('CALL TO PRAYER')), 'the Adhan column is still named');
  const iq = tight.find((s) => s.startsWith('CONGREGATION'));
  assert.ok(iq, 'and so is the Iqamah column');
  assert.ok(iq!.endsWith('...'), `shortened rather than run across its neighbour — got ${JSON.stringify(iq)}`);
});

// ── the sizes themselves ─────────────────────────────────────────────────────

/** The largest prayer-name and clock-time sizes in a frame's table. */
function tableSizes(svg: string): { name: number; time: number } {
  const rs = runs(svg);
  const time = rs
    .filter((r) => r.anchor === 'end' && /^\d{1,2}:\d{2}( [AP]M)?$/.test(r.body))
    .reduce((n, r) => Math.max(n, r.size), 0);
  const name = rs
    .filter((r) => /^(Fajr|FAJR|Maghrib|MAGHRIB|Isha|ISHA)$/.test(r.body))
    .reduce((n, r) => Math.max(n, r.size), 0);
  return { name, time };
}

test('the times are always set larger than the names beside them', () => {
  // The name is context, the time is the content. It is also the one outcome of decoupling the
  // two sizes that would read as a bug rather than as a fit, so it is asserted everywhere rather
  // than assumed from the formula: `simpleTable`'s name budget reserves room for a time at the
  // old ratio precisely so this cannot invert however tight the box gets.
  for (const f of FRAMES) {
    const { name, time } = tableSizes(f.svg);
    if (!name || !time) continue; // an Arabic-language frame names its rows in Arabic
    assert.ok(time > name, `${f.name}: times ${time} are not larger than names ${name}`);
  }
});

test('the times are bigger than they used to be', () => {
  // Concrete floors, so a change that quietly restores the old sizes fails here rather than
  // going out. The numbers on the right are what this code produced before a masjid asked for
  // larger times; the assertions are comfortably above them and below what it produces now.
  const land = tableSizes(simple({ quality: '1080p', orientation: 'landscape' }));
  assert.ok(land.time >= 66, `Simple 1080p landscape times are ${land.time} (were 48.4)`);
  assert.equal(land.name, 44, 'and the names are untouched — only the times were asked for');

  const port = tableSizes(simple({ quality: '1080p', orientation: 'portrait' }));
  assert.ok(port.time >= 55, `Simple 1080p portrait times are ${port.time} (were 46.4)`);

  const modern = tableSizes(
    renderDisplaySvg(normTimetable({ ...BASE, layout: 'modern', jumuah: ['13:30', '14:30'] }) as Timetable, NOW, {}),
  );
  assert.ok(modern.time / modern.name >= 1.2, `Modern ratio is ${(modern.time / modern.name).toFixed(2)} (was 1.10)`);
});

test('a narrow column shrinks the times rather than letting them collide', () => {
  // The other direction, and the one the overlap sweep above would catch anyway — but stated
  // here as an intention, because "it grew" and "it grows only where there is room" are two
  // different claims and only the second one is safe.
  const wide = tableSizes(simple({ quality: '1080p', orientation: 'landscape' }));
  const beside = tableSizes(
    renderDisplaySvg(
      normTimetable({ ...BASE, layout: 'simple', jumuah: ['13:30', '14:30'], quality: '1080p', orientation: 'landscape' }) as Timetable,
      NOW,
      { announcement: IMG },
    ),
  );
  assert.ok(beside.time < wide.time, 'the timetable column beside a picture has less room and takes less');
  assert.ok(beside.time > beside.name, 'and the times are still the larger of the two');
});
