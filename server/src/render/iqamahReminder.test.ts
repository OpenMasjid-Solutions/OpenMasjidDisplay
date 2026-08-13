// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The upcoming-Iqāmah-change reminder now SHARES the bottom band with the scrolling ticker
 * (red slice on the left) instead of stacking above it in its own reserved strip.
 *
 * Two things here are worth more than the rest: that the layout above the band does not
 * shrink when the reminder appears (the reason it moved), and that the ffmpeg scroll is
 * confined to the slice the reminder does not own (or the moving text runs straight over it,
 * which no unit test of the SVG alone would catch).
 */
import assert from 'node:assert';
import test from 'node:test';
import { normTimetable } from '../validate';
import { normalizeIqamahSchedule } from '../iqamahSchedule';
import { bottomBandSplit, iqamahNoticeText, tickerLayout, renderDisplaySvg, dimsFor, TICKER_RED } from './svg';
import { timetableVf, timetableVfReserved, type TickerSpec } from './renderer';
import type { Timetable } from '../types';

const TZ = 'America/New_York';
const NOW = new Date('2026-07-16T17:00:00Z'); // a Thursday afternoon in New York
const W = 1280;
const H = 720;

function base(): Timetable {
  return normTimetable({
    masjidName: 'Test Masjid',
    latitude: 40.7128,
    longitude: -74.006,
    method: 'ISNA',
    asrMadhab: 'Standard',
    timezone: TZ,
    timeFormat: '12h',
  });
}

/** A timetable with a scheduled Iqamah change two days out, so the reminder is due. */
function withChange(over: Partial<Timetable> = {}): Timetable {
  const tt = base();
  tt.iqamahSchedule = normalizeIqamahSchedule([{ from: '2026-07-18', fajr: '05:15', asr: '17:30' }]);
  tt.iqamahChangeNotice = { enabled: true, daysBefore: 5 };
  return Object.assign(tt, over);
}

function withTicker(tt: Timetable): Timetable {
  // start/end are the daily-window fields; '' means "always, while the ticker is enabled".
  tt.ticker = { enabled: true, messages: [{ id: 'm1', text: 'Fundraising dinner this Saturday', start: '', end: '' }] };
  return tt;
}

const spec = (text: string): TickerSpec => ({
  text,
  textfile: '/data/ticker_x.txt',
  fontfile: '/app/fonts/NotoSans-Regular.ttf',
  speed: 5,
  prohibited: false,
  color: '#ffffff',
});

// ── the split geometry ──────────────────────────────────────────────────────────

test('no upcoming change → nothing is reserved and the band is untouched', () => {
  const s = bottomBandSplit(base(), NOW, W, H, true);
  assert.equal(s.notice, '');
  assert.equal(s.reserveW, 0);
});

test('a change is due → there is a sentence to show', () => {
  const n = iqamahNoticeText(withChange(), NOW);
  assert.ok(n.length > 0, 'expected a reminder sentence');
  assert.match(n, /will be at/);
});

test('reminder with NO ticker takes the whole band', () => {
  const s = bottomBandSplit(withChange(), NOW, W, H, false);
  assert.equal(s.reserveW, W);
});

test('reminder WITH a ticker takes a slice, never the lot', () => {
  const s = bottomBandSplit(withTicker(withChange()), NOW, W, H, true);
  assert.ok(s.reserveW >= W * 0.3, `too narrow to read: ${s.reserveW}`);
  assert.ok(s.reserveW <= W * 0.6, `leaves the ticker no room: ${s.reserveW}`);
});

test('the band sits exactly where the ticker band sits (it IS that strip)', () => {
  const t = tickerLayout(W, H);
  const s = bottomBandSplit(withChange(), NOW, W, H, true);
  assert.equal(s.y, t.y);
  assert.equal(s.bandH, t.bandH);
});

test('a malformed schedule yields no reminder rather than throwing', () => {
  const tt = base();
  tt.iqamahChangeNotice = { enabled: true, daysBefore: 3 };
  // Deliberately bypass the normalizer with a shape the resolver never expects.
  (tt as unknown as { iqamahSchedule: unknown }).iqamahSchedule = [{ from: 'not-a-date' }];
  assert.doesNotThrow(() => iqamahNoticeText(tt, NOW));
});

test('disabled notice shows nothing even with a change pending', () => {
  const tt = withChange({ iqamahChangeNotice: { enabled: false, daysBefore: 5 } });
  assert.equal(iqamahNoticeText(tt, NOW), '');
});

// ── what actually reaches the screen ────────────────────────────────────────────

test('the reminder is drawn in the warning red, in the band', () => {
  const svg = renderDisplaySvg(withChange(), NOW, {});
  assert.ok(svg.includes(TICKER_RED), 'expected the reminder in TICKER_RED');
  assert.ok(svg.includes(iqamahNoticeText(withChange(), NOW)), 'expected the sentence on screen');
});

/** Everything drawn BEFORE the bottom band, for a timetable rendered at its own size.
 *  The band's backdrop is the first thing painted at the band's top edge, and rect() writes
 *  its coordinates to one decimal — so this is an exact cut, not a guess. Note the dims come
 *  from the timetable itself: normTimetable defaults to 1080p, so hardcoding a size here
 *  silently finds no marker and compares whole SVGs instead. */
function aboveBand(tt: Timetable, opts: Parameters<typeof renderDisplaySvg>[2] = {}): string {
  const d = dimsFor(tt.orientation, tt.quality);
  const { y } = tickerLayout(d.width, d.height);
  const svg = renderDisplaySvg(tt, NOW, opts);
  const marker = `<rect x="0.0" y="${y.toFixed(1)}"`;
  const i = svg.indexOf(marker);
  assert.notEqual(i, -1, 'could not find the band in the rendered SVG — the cut marker is stale');
  return svg.slice(0, i);
}

/**
 * THE regression this change exists for. The reminder used to reserve its own height above
 * the band, so the prayer table and the Jumu'ah box shrank for the days a change was
 * pending. The band is drawn LAST, so if the working area is untouched then everything
 * before the band must be byte-identical with and without the reminder.
 */
test('with a ticker running, adding the reminder does not move anything above the band', () => {
  const a = aboveBand(withTicker(base()));
  const b = aboveBand(withTicker(withChange()));
  assert.ok(a.length > 2000, 'sanity: expected a substantial layout before the band');
  assert.equal(b, a, 'the layout above the band changed — the reminder is stealing space again');
});

test('the reminder does not shrink the layout in the slideshow either', () => {
  const opts = { announcement: 'data:image/png;base64,iVBORw0KGgo=' };
  assert.equal(aboveBand(withTicker(withChange()), opts), aboveBand(withTicker(base()), opts));
});

test('the reminder still shows while announcement images are cycling', () => {
  const svg = renderDisplaySvg(withChange(), NOW, { announcement: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.ok(svg.includes(iqamahNoticeText(withChange(), NOW)), 'the reminder must survive the slideshow');
});

test('a prohibited-time message owns the band alone — no two reds at once', () => {
  const tt = withChange();
  tt.prohibitedNotice = { enabled: true, ticker: true, minutes: 600 };
  const svg = renderDisplaySvg(tt, NOW, {});
  // The zawāl message is happening NOW and outranks a change days away.
  assert.ok(!svg.includes(iqamahNoticeText(withChange(), NOW)), 'the reminder should stand down for zawāl');
});

/**
 * The still preview (the editor's live preview) draws the scrolling text itself instead of
 * leaving it to ffmpeg, so it has to respect the same reserved slice. It is clipped to that
 * slice — and the clipping group must NOT also carry a transform, because an element's
 * transform applies to its clip-path as well, which shifted the clip off-screen and made the
 * ticker text vanish from the preview entirely.
 */
test('the preview keeps its ticker text, positioned inside the reserved slice', () => {
  const tt = withTicker(withChange());
  const d = dimsFor(tt.orientation, tt.quality);
  const { reserveW } = bottomBandSplit(tt, NOW, d.width, d.height, true);
  const svg = renderDisplaySvg(tt, NOW, {});
  const g = /<g clip-path="url\(#tkclip[^"]*\)"([^>]*)>([\s\S]*?)<\/g>/.exec(svg);
  assert.ok(g, 'expected a clipped ticker group in the preview');
  assert.ok(!/transform/.test(g![1]), 'the clipping group must not be transformed');
  assert.ok(g![2].includes('Fundraising'), 'the ticker message must still be drawn');
  // Every drawn segment starts at or after the reserved edge (absolute coordinates).
  const xs = [...g![2].matchAll(/<text x="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(xs.length > 0, 'expected text segments');
  assert.ok(Math.max(...xs) >= reserveW - 1, `segments are not in the slice: ${xs.join(',')}`);
});

test('with no reminder the preview ticker is not clipped at all', () => {
  const svg = renderDisplaySvg(withTicker(base()), NOW, {});
  assert.ok(!svg.includes('tkclip'), 'the unreserved band must not gain a clip path');
  assert.ok(svg.includes('Fundraising'));
});

// ── the ffmpeg scroll region ────────────────────────────────────────────────────

test('with no reserve, the ordinary chain is completely unchanged', () => {
  const vf = timetableVf({ width: W, height: H }, spec('hello'));
  assert.ok(!vf.includes('crop='), 'the common path must not gain a crop');
  assert.ok(!vf.includes('split='));
  assert.ok(vf.startsWith('fps=20'));
  assert.ok(vf.endsWith('format=yuv420p'));
});

test('the reserved graph crops the band to the slice the reminder does NOT own', () => {
  const reserve = 500;
  const g = timetableVfReserved({ width: W, height: H }, spec('hello'), reserve);
  const { y, bandH } = tickerLayout(W, H);
  assert.ok(g.includes(`crop=${W - reserve}:${Math.round(bandH)}:${reserve}:${Math.round(y)}`), `crop missing/wrong in: ${g}`);
  assert.ok(g.includes(`overlay=${reserve}:${Math.round(y)}`), 'overlay must put the slice back where it came from');
  assert.ok(g.includes('split=2[bg][sc]'));
  assert.ok(g.endsWith('format=yuv420p'));
});

test('every drawtext lives inside the cropped slice, never on the full frame', () => {
  const g = timetableVfReserved({ width: W, height: H }, spec('hello'), 400);
  const chains = g.split(';');
  const cropChain = chains.find((c) => c.includes('crop='));
  assert.ok(cropChain, 'expected a chain containing the crop');
  for (const c of chains) {
    if (c === cropChain) continue;
    assert.ok(!c.includes('drawtext'), `drawtext escaped the crop: ${c}`);
  }
  // Inside the crop the text is centred on the cropped height, not the full frame.
  assert.ok(cropChain!.includes('y=(h-th)/2'));
});

test('the scroll still tiles seamlessly inside the slice (wrap uses the real text width)', () => {
  const g = timetableVfReserved({ width: W, height: H }, spec('hello'), 400);
  assert.ok(g.includes('mod(floor(t*20)*'), 'integer px/frame stepping must survive');
  assert.ok(g.includes('tw+'), 'the wrap period must still use the measured text width');
});

test('an absurd reserve still leaves a usable slice rather than a zero-width crop', () => {
  const g = timetableVfReserved({ width: W, height: H }, spec('hello'), W + 999);
  const m = /crop=(\d+):/.exec(g);
  assert.ok(m, 'expected a crop');
  assert.ok(Number(m![1]) >= 16, `crop width collapsed: ${m![1]}`);
});

test('a prohibited ticker keeps its red inside the reserved graph too', () => {
  const g = timetableVfReserved({ width: W, height: H }, { ...spec('x'), prohibited: true }, 400);
  assert.ok(g.includes(TICKER_RED.replace('#', '0x')), 'prohibited text must stay red');
});
