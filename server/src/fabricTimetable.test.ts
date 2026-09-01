// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The `timetable` capability: another app reading this masjid's prayer times through the
 * platform's app-to-app broker.
 *
 * Two very different things are being pinned here and it is worth keeping them apart.
 *
 * The ENVELOPE tests are about who gets in. This is the second inbound Fabric route in the
 * app and the first one reachable by something other than the platform, so the interesting
 * cases are the ones where a request looks almost right: the secret with no caller, the
 * caller with no secret, and — the one that actually needed new code — a tunnelled path that
 * the router's `new URL()` normalises onto the route before the handler ever sees it.
 *
 * The CONTRACT tests are about what a consumer gets. OpenMasjidCompanion is not allowed to
 * calculate prayer times, Hijri dates or Iqamah changes itself; it shows whatever this returns
 * to musallis, and schedules their notifications from it. So the assertions worth having are
 * the ones a wrong answer would be invisible in: that the wire is 24-hour whatever the
 * timetable's own display setting says, that the zone reported is the zone the times were
 * computed in, that a scheduled Iqamah change lands on its date and not the day before, and
 * that Jumu'ah is only ever claimed on a day that is Friday in the MASJID's zone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const SECRET = 'test-app-secret-not-a-real-one';
process.env.OPENMASJID_APP_SECRET = SECRET;
process.env.OPENMASJID_BASE_URL = 'http://platform.invalid';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-fabtt-'));

// config reads env at import time, so everything below is required AFTER the env is set.
const { Store } = require('./store') as typeof import('./store');
const { normTimetable } = require('./validate') as typeof import('./validate');
const { fmtShort } = require('./render/svg') as typeof import('./render/svg');
const { checkBrokerEnvelope, rawPath, safeCaller } = require('./fabricInbound') as typeof import('./fabricInbound');
const ft = require('./fabricTimetable') as typeof import('./fabricTimetable');

const {
  handleFabricTimetable,
  buildFeed,
  hhmm,
  effectiveTimeZone,
  parseFrom,
  readLogo,
  base64Length,
  logoResponseCeilingHeadroom,
  TIMETABLE_GET_PATH,
  TIMETABLE_LIST_PATH,
  TIMETABLE_LOGO_PATH,
  TIMETABLE_PATHS,
  TIMETABLE_METHOD_BY_PATH,
  TIMETABLE_MAX_DAYS,
  TIMETABLE_MAX_BODY_BYTES,
  TIMETABLE_LOGO_MAX_BYTES,
} = ft;

const SERVER_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(SERVER_DIR, '..');
const src = (f: string) => fs.readFileSync(path.join(SERVER_DIR, 'src', f), 'utf8');

/** Madani Academy's real coordinates, so the times are plausible rather than arbitrary. */
const LAT = 40.2415;
const LNG = -75.2838;

/** 2026-08-21 is a Friday; 2026-08-20 is the Thursday before it. */
const FRIDAY = { y: 2026, m: 8, d: 21 };
const THURSDAY = { y: 2026, m: 8, d: 20 };

function timetable(over: Record<string, unknown> = {}) {
  return normTimetable({
    name: 'Main hall',
    masjidName: 'Madani Academy Masjid',
    latitude: LAT,
    longitude: LNG,
    timezone: 'America/New_York',
    timeFormat: '12h',
    ...over,
  });
}

function store(...tts: ReturnType<typeof timetable>[]) {
  const s = new Store();
  s.update((db) => {
    db.timetables = tts.length ? tts : [timetable()];
  });
  return s;
}

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

/** Minimal req/res doubles — enough for a handler that only reads headers and writes JSON. */
function call(
  s: InstanceType<typeof Store>,
  method: 'list' | 'get' | 'logo',
  headers: Record<string, string>,
  body: Record<string, unknown> = {},
  url?: string,
): Captured {
  const req = {
    headers,
    method: 'POST',
    url: url ?? TIMETABLE_PATHS[method],
  } as unknown as IncomingMessage;
  let status = 0;
  let chunk = '';
  const res = {
    writeHead(st: number) {
      status = st;
      return this;
    },
    end(b?: string) {
      chunk = b ?? '';
      return this;
    },
    headersSent: false,
  } as unknown as ServerResponse;
  handleFabricTimetable(req, res, method, body, s);
  return { status, body: JSON.parse(chunk || '{}') };
}

const good = { 'x-openmasjid-app-secret': SECRET, 'x-openmasjid-caller-app': 'companion' };

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

test('the broker, with the secret and a caller, gets the list', () => {
  const r = call(store(), 'list', good);
  assert.equal(r.status, 200);
  assert.equal(r.body.v, 1);
  assert.equal((r.body.timetables as unknown[]).length, 1);
});

test('a wrong secret is refused, and not told which half was wrong', () => {
  const r = call(store(), 'list', { ...good, 'x-openmasjid-app-secret': 'nope' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'forbidden');
});

test('no secret at all is refused', () => {
  const r = call(store(), 'list', { 'x-openmasjid-caller-app': 'companion' });
  assert.equal(r.status, 403);
});

test('the secret alone is not enough — a genuine broker call always names its caller', () => {
  const r = call(store(), 'list', { 'x-openmasjid-app-secret': SECRET });
  assert.equal(r.status, 403);
});

test('a malformed caller id is refused rather than logged raw', () => {
  const r = call(store(), 'list', { ...good, 'x-openmasjid-caller-app': 'bad id\nInjected: line' });
  assert.equal(r.status, 403);
  assert.equal(safeCaller('bad id\nInjected: line'), '(malformed)');
});

test('the caller is checked for SHAPE only — the grant list is the platform\u2019s, not a copy here', () => {
  // Any app id the platform might legitimately start using has to work. A route that refused
  // an unexpected-but-valid caller would fail closed and silently, and the capability grant
  // has already been checked by the platform before it ever forwarded this.
  for (const caller of ['companion', 'students', 'donations', 'some-new-app', 'omos:platform']) {
    const r = call(store(), 'list', { ...good, 'x-openmasjid-caller-app': caller });
    assert.equal(r.status, 200, `caller ${caller} should have been let through`);
  }
});

test('no secret of our OWN answers not_ready, not a refusal', () => {
  // The platform should retry rather than conclude the capability does not exist. Tested on
  // the envelope directly: config reads the env once, at import.
  const req = { headers: good, method: 'POST', url: TIMETABLE_LIST_PATH } as unknown as IncomingMessage;
  const r = checkBrokerEnvelope(req, TIMETABLE_LIST_PATH, '');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 503);
  assert.equal(r.ok === false && r.error, 'not_ready');
});

test('the tunnelled dot-segment path is refused even though the router normalises it', () => {
  const r = call(store(), 'list', good, {}, '/display/../fabric/timetable/list');
  assert.equal(r.status, 403);
});

test('the dot-segment path that motivates the raw check really does normalise onto this route', () => {
  // Pinning the premise, not the fix. api.ts derives `pathname` with `new URL()`, so matching
  // on it alone would accept a request the tunnel can deliver. If this ever stops being true
  // the raw-path check is still correct, but the comment explaining why it exists would be wrong.
  assert.equal(new URL('/display/../fabric/timetable/list', 'http://localhost').pathname, TIMETABLE_LIST_PATH);
  assert.equal(new URL('/display/../fabric/timetable/get', 'http://localhost').pathname, TIMETABLE_GET_PATH);
});

test('every request line that normalises onto this route is refused by the raw check', () => {
  // This table is the actual reason the raw check exists, and it is longer than "one dot-dot".
  // Every one of these makes api.ts's `pathname` equal the route path exactly, so the branch
  // matches and the handler runs. Percent-encoded dot segments normalise too (the URL spec
  // treats `%2e` as a dot when deciding what a double-dot segment is), an absolute-form request
  // target keeps only its path, a protocol-relative target donates its first segment to the
  // host, and a backslash is a separator. None of them can be spelled without the raw target
  // differing from the bare path, which is what makes the check structural rather than a
  // blocklist of the tricks somebody happened to think of.
  const shapes = [
    '/display/../fabric/timetable/list',
    '/display/%2e%2e/fabric/timetable/list',
    '/display/%2E%2E/fabric/timetable/list',
    '/display/.%2e/fabric/timetable/list',
    '/x/y/../../fabric/timetable/list',
    'http://evil.example/fabric/timetable/list',
    '//evil.example/fabric/timetable/list',
    '/fabric/./timetable/list',
    '\\fabric/timetable/list',
  ];
  for (const url of shapes) {
    assert.equal(
      new URL(url, 'http://localhost').pathname,
      TIMETABLE_LIST_PATH,
      `${url} was expected to normalise onto the route — if it no longer does, this row is dead weight`,
    );
    assert.equal(call(store(), 'list', good, {}, url).status, 403, `${url} must be refused`);
  }
});

test('the tunnel\u2019s own prefixed form never matches', () => {
  // This one the dispatcher already refuses, because `pathname` keeps the prefix. Asserted
  // anyway: it is the shape a real tunnelled request has, and the handler must not accept it
  // if it is ever reached another way.
  const r = call(store(), 'list', good, {}, '/display/fabric/timetable/list');
  assert.equal(r.status, 403);
});

test('a query string on the exact path is tolerated', () => {
  // The raw check is about the PATH. A legitimate call carries no query, but refusing one
  // would be a brittle way to fail if the platform ever appended a trace id.
  const r = call(store(), 'list', good, {}, `${TIMETABLE_LIST_PATH}?trace=abc`);
  assert.equal(r.status, 200);
  assert.equal(rawPath({ url: `${TIMETABLE_LIST_PATH}?trace=abc` } as IncomingMessage), TIMETABLE_LIST_PATH);
});

test('each method is bound to its OWN path — list cannot be reached down the get route', () => {
  const r = call(store(), 'list', good, {}, TIMETABLE_GET_PATH);
  assert.equal(r.status, 403);
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test('list reports id and name and nothing else', () => {
  const r = call(store(), 'list', good);
  const rows = r.body.timetables as Record<string, unknown>[];
  assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'name']);
  assert.match(String(rows[0].id), /^tt_[0-9a-f]{8}$/);
  assert.equal(rows[0].name, 'Main hall');
});

test('list is NOT gated on the website widget being switched on', () => {
  // widget.enabled governs whether the masjid publishes times on their own WEBSITE. This is a
  // different channel the admin granted app-by-app on their own box, and copying that gate
  // here would hide timetables they clearly meant to share.
  const off = timetable({ name: 'Women\u2019s section' });
  const on = timetable({ name: 'Main hall', widget: { enabled: true } });
  const r = call(store(off, on), 'list', good);
  const names = (r.body.timetables as Record<string, unknown>[]).map((t) => t.name);
  assert.deepEqual(names, ['Women\u2019s section', 'Main hall']);
});

// ---------------------------------------------------------------------------
// get — the request
// ---------------------------------------------------------------------------

test('an unknown id is unknown_timetable, not a refusal', () => {
  const r = call(store(), 'get', good, { id: 'tt_deadbeef', from: '2026-08-21', days: 7 });
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'unknown_timetable');
});

test('the day range is enforced here, not trusted from the body', () => {
  const s = store();
  const id = s.db.timetables[0].id;
  const ok = (days: unknown) => call(s, 'get', good, { id, from: '2026-08-21', days }).status;
  assert.equal(ok(1), 200);
  assert.equal(ok(TIMETABLE_MAX_DAYS), 200);
  assert.equal(ok(TIMETABLE_MAX_DAYS + 1), 400);
  assert.equal(ok(0), 400);
  assert.equal(ok(-1), 400);
  assert.equal(ok(7.5), 400);
  assert.equal(ok(undefined), 400);
  assert.equal(ok('7'), 400, 'a numeric STRING is not an integer — reject it rather than coerce');
  assert.equal(ok(10_000), 400);
});

test('a from date that is not a real calendar date is refused', () => {
  const s = store();
  const id = s.db.timetables[0].id;
  const st = (from: unknown) => call(s, 'get', good, { id, from, days: 3 }).status;
  assert.equal(st('2026-08-21'), 200);
  assert.equal(st('2026-8-21'), 400, 'unpadded month');
  assert.equal(st('2026-02-30'), 400, 'February never has 30 days');
  assert.equal(st('2026-04-31'), 400, 'April never has 31 days');
  assert.equal(st('2026-13-01'), 400);
  assert.equal(st(''), 400);
  assert.equal(st(undefined), 400);
  assert.equal(st('21/08/2026'), 400);
  assert.equal(parseFrom('2026-02-29'), null, '2026 is not a leap year');
  assert.deepEqual(parseFrom('2024-02-29'), { y: 2024, m: 2, d: 29 }, '2024 is');
});

test('a timetable with no location says so instead of answering for latitude 0', () => {
  // buildModel asserts these are set. Passed nulls it would compute for the Gulf of Guinea and
  // return times that look entirely reasonable — which is the worst possible failure here.
  const s = store(timetable({ latitude: null, longitude: null }));
  const r = call(s, 'get', good, { id: s.db.timetables[0].id, from: '2026-08-21', days: 3 });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'no_location');
});

// ---------------------------------------------------------------------------
// get — the payload
// ---------------------------------------------------------------------------

test('the range starts on the requested day and runs consecutively', () => {
  const s = store();
  const r = call(s, 'get', good, { id: s.db.timetables[0].id, from: '2026-08-28', days: 6 });
  assert.equal(r.status, 200);
  const days = r.body.days as { date: string }[];
  assert.deepEqual(
    days.map((d) => d.date),
    ['2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02'],
    'a month boundary inside the range must not be skipped or repeated',
  );
});

test('a leap day is not skipped', () => {
  const s = store();
  const r = call(s, 'get', good, { id: s.db.timetables[0].id, from: '2024-02-27', days: 4 });
  assert.deepEqual(
    (r.body.days as { date: string }[]).map((d) => d.date),
    ['2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01'],
  );
});

test('every day carries the five prayers and a Hijri label', () => {
  const f = buildFeed(timetable(), THURSDAY, 5);
  for (const d of f.days) {
    assert.deepEqual(Object.keys(d.prayers), ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']);
    for (const k of ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const) {
      assert.match(String(d.prayers[k].adhan), /^\d{2}:\d{2}$/, `${d.date} ${k} adhan`);
      assert.match(String(d.prayers[k].iqamah), /^\d{2}:\d{2}$/, `${d.date} ${k} iqamah`);
    }
    assert.match(d.hijri.label, /1[34]\d{2}/, `${d.date} hijri label should name a Hijri year`);
    assert.match(String(d.sunrise), /^\d{2}:\d{2}$/);
  }
});

test('the wire is 24-hour even when the timetable itself is set to 12-hour', () => {
  // The single most likely way this contract gets broken: reusing the display formatter, which
  // takes tt.timeFormat and would hand a consumer "9:25 PM" to parse.
  const twelve = buildFeed(timetable({ timeFormat: '12h' }), THURSDAY, 1);
  const twentyFour = buildFeed(timetable({ timeFormat: '24h' }), THURSDAY, 1);
  assert.equal(twelve.hourCycle, '12');
  assert.equal(twentyFour.hourCycle, '24');
  assert.equal(twelve.days[0].prayers.isha.adhan, twentyFour.days[0].prayers.isha.adhan);
  assert.match(String(twelve.days[0].prayers.isha.adhan), /^2\d:\d{2}$/, 'Isha in August is after 20:00');
  const flat = JSON.stringify(twelve);
  assert.ok(!/\d\s?(AM|PM)/.test(flat), 'no 12-hour string may reach the wire');
  assert.ok(!flat.includes('\u2014'), 'no em dash — the display formatter\u2019s empty value');
});

test('an Iqamah with no time set is null, not a dash and not a guess', () => {
  const tt = timetable();
  tt.iqamah = { ...tt.iqamah, asr: { mode: 'none' } };
  const d = buildFeed(tt, THURSDAY, 1).days[0];
  assert.equal(d.prayers.asr.iqamah, null);
  assert.match(String(d.prayers.asr.adhan), /^\d{2}:\d{2}$/, 'the Adhan is still calculated');
});

test('a scheduled Iqamah change lands on its own date and not the day before', () => {
  const tt = timetable();
  tt.iqamahSchedule = [{ from: '2026-08-25', fajr: '05:45', isha: '21:00' }];
  const days = buildFeed(tt, THURSDAY, 7).days;
  const on = days.find((d) => d.date === '2026-08-25')!;
  const before = days.find((d) => d.date === '2026-08-24')!;
  const after = days.find((d) => d.date === '2026-08-26')!;
  assert.equal(on.prayers.fajr.iqamah, '05:45');
  assert.equal(on.prayers.isha.iqamah, '21:00');
  assert.notEqual(before.prayers.fajr.iqamah, '05:45', 'the change must not leak backwards');
  assert.equal(after.prayers.fajr.iqamah, '05:45', 'and it carries forward');
});

test('a CSV per-day override beats a scheduled change, as it does on the screen', () => {
  const tt = timetable();
  tt.iqamahSchedule = [{ from: '2026-08-01', fajr: '05:45' }];
  tt.iqamahYear = { '08-22': { fajr: '05:10' } };
  const days = buildFeed(tt, THURSDAY, 4).days;
  assert.equal(days.find((d) => d.date === '2026-08-22')!.prayers.fajr.iqamah, '05:10');
  assert.equal(days.find((d) => d.date === '2026-08-23')!.prayers.fajr.iqamah, '05:45');
});

// ---------------------------------------------------------------------------
// Jumu'ah
// ---------------------------------------------------------------------------

test('Jumu\u2019ah is claimed only on Friday, and Friday in the masjid\u2019s zone', () => {
  const f = buildFeed(timetable({ jumuah: ['13:15'] }), THURSDAY, 8);
  for (const d of f.days) {
    const isFriday = new Date(`${d.date}T12:00:00Z`).getUTCDay() === 5;
    assert.equal(d.jumuah.length > 0, isFriday, `${d.date} jumuah presence`);
  }
  assert.equal(f.days.find((d) => d.date === '2026-08-21')!.jumuah[0].iqamah, '13:15');
});

test('several Jumu\u2019ah get numbered labels; a single one is not numbered', () => {
  const many = buildFeed(timetable({ jumuah: ['13:15', '14:00', '14:45'] }), FRIDAY, 1).days[0];
  assert.deepEqual(
    many.jumuah.map((j) => j.label),
    ["Jumu'ah 1", "Jumu'ah 2", "Jumu'ah 3"],
  );
  assert.deepEqual(
    many.jumuah.map((j) => j.iqamah),
    ['13:15', '14:00', '14:45'],
  );
  const one = buildFeed(timetable({ jumuah: ['13:30'] }), FRIDAY, 1).days[0];
  assert.deepEqual(
    one.jumuah.map((j) => j.label),
    ["Jumu'ah"],
  );
});

test('Jumu\u2019ah carries no Adhan, because this app has no such field', () => {
  // Not an omission. A timetable configures jamā'ah times only; the screen's Friday countdown
  // runs to the calculated DHUHR adhan relabelled "Jumu'ah". Filling this from Dhuhr would
  // look like a separately configured time. The information is still reachable, next door.
  const d = buildFeed(timetable({ jumuah: ['13:15'] }), FRIDAY, 1).days[0];
  assert.equal(d.jumuah[0].adhan, null);
  assert.match(String(d.prayers.dhuhr.adhan), /^\d{2}:\d{2}$/);
});

test('a scheduled Jumu\u2019ah change replaces the base times from its date', () => {
  const tt = timetable({ jumuah: ['13:15', '14:00'] });
  tt.iqamahSchedule = [{ from: '2026-08-25', jumuah: ['13:45'] }];
  const days = buildFeed(tt, THURSDAY, 14).days;
  assert.deepEqual(
    days.find((d) => d.date === '2026-08-21')!.jumuah.map((j) => j.iqamah),
    ['13:15', '14:00'],
  );
  assert.deepEqual(
    days.find((d) => d.date === '2026-08-28')!.jumuah.map((j) => j.iqamah),
    ['13:45'],
    'the Friday after the change takes the new time, and drops the second jamā\u2019ah',
  );
});

test('the Jumu\u2019ah label follows the timetable\u2019s language and its own override', () => {
  const ar = buildFeed(timetable({ language: 'ar', jumuah: ['13:15'] }), FRIDAY, 1).days[0];
  assert.equal(ar.jumuah[0].label, '\u0627\u0644\u062c\u0645\u0639\u0629');
  const named = buildFeed(timetable({ jumuah: ['13:15'], labels: { jumuah: 'Friday prayer' } }), FRIDAY, 1).days[0];
  assert.equal(named.jumuah[0].label, 'Friday prayer');
});

// ---------------------------------------------------------------------------
// Timezone — the field a consumer schedules notifications from
// ---------------------------------------------------------------------------

test('the zone reported is the zone the times were actually computed in', () => {
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(effectiveTimeZone(timetable({ timezone: 'Asia/Karachi' })), 'Asia/Karachi');
  assert.equal(effectiveTimeZone(timetable({ timezone: '' })), host, 'blank means this box\u2019s zone');
  assert.equal(effectiveTimeZone(timetable({ timezone: '   ' })), host);
  // The prayer engine silently falls back to the host zone for a name Intl does not know, so
  // reporting the stored string would name a zone the times are not in.
  const tt = timetable();
  tt.timezone = 'Mars/Olympus_Mons';
  assert.equal(effectiveTimeZone(tt), host);
});

test('the reported zone is always a zone Intl accepts', () => {
  for (const tz of ['America/New_York', '', 'not a zone']) {
    const tt = timetable();
    tt.timezone = tz;
    const got = effectiveTimeZone(tt);
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: got }), `${tz} -> ${got}`);
  }
});

test('a UTC+13 masjid gets the days it asked for, not the day after', () => {
  // zonedNoon rather than UTC noon. A 12:00-UTC anchor lands on the NEXT calendar date in
  // Auckland/Apia, so every day of the range would be shifted by one.
  const f = buildFeed(timetable({ timezone: 'Pacific/Auckland' }), { y: 2026, m: 8, d: 20 }, 3);
  assert.deepEqual(
    f.days.map((d) => d.date),
    ['2026-08-20', '2026-08-21', '2026-08-22'],
  );
  assert.equal(f.timezone, 'Pacific/Auckland');
});

test('Friday is decided in the masjid\u2019s zone, not in UTC', () => {
  // Kiritimati is UTC+14: its Friday starts while UTC is still on Thursday. The date strings
  // are the masjid's own, so the Friday in the payload is the masjid's Friday.
  const f = buildFeed(timetable({ timezone: 'Pacific/Kiritimati', jumuah: ['13:00'] }), THURSDAY, 4);
  const withJumuah = f.days.filter((d) => d.jumuah.length).map((d) => d.date);
  assert.deepEqual(withJumuah, ['2026-08-21']);
});

// ---------------------------------------------------------------------------
// Formatting: one flooring implementation, kept honest
// ---------------------------------------------------------------------------

test('hhmm agrees with the renderer\u2019s own 24-hour formatter', () => {
  // Two implementations exist because the screen needs an em dash where a JSON feed needs
  // null. They must not diverge on anything else — a phone showing a time a minute later than
  // the board on the wall is a discrepancy nobody can explain. Note iqamahCsv.ts's look-alike
  // ROUNDS; these floor. That is the disagreement this test exists to prevent a third time.
  const cases = [0, 0.5, 5.9833, 12, 12.999, 13.0830195, 17.2, 20.98333, 23.9999, 6 + 59 / 60 + 59 / 3600];
  for (const h of cases) {
    assert.equal(hhmm(h), fmtShort(h, '24h'), `hours=${h}`);
  }
});

test('hhmm wraps rather than overflowing, and answers null for nothing', () => {
  assert.equal(hhmm(24), '00:00');
  assert.equal(hhmm(25.5), '01:30', 'buildModel expresses tomorrow\u2019s Fajr as hours+24');
  assert.equal(hhmm(-0.5), '23:30');
  assert.equal(hhmm(null), null);
  assert.equal(hhmm(undefined), null);
  assert.equal(hhmm(Number.NaN), null);
  assert.equal(hhmm(Number.POSITIVE_INFINITY), null);
});

// ---------------------------------------------------------------------------
// logo — the masjid's own mark, so a musalli's home-screen icon is theirs
// ---------------------------------------------------------------------------

const { saveLogo } = require('./render/background') as typeof import('./render/background');

/** A real 1x1 PNG. Real bytes, because the whole point of this path is that it sniffs them. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');

/** Put `bytes` on disk as this timetable's logo, with whatever EXTENSION `mime` implies —
 *  which is how a file whose name disagrees with its content gets made. */
function withLogo(bytes: Buffer, mime = 'image/png') {
  const tt = timetable();
  tt.logoImage = saveLogo(tt.id, mime, bytes);
  return tt;
}

test('a timetable with no logo answers null, which is not an error', () => {
  const s = store();
  const r = call(s, 'logo', good, { id: s.db.timetables[0].id });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { v: 1, id: s.db.timetables[0].id, logo: null });
});

test('a PNG logo comes back byte-for-byte, base64 with no data: prefix', () => {
  const tt = withLogo(PNG);
  const r = call(store(tt), 'logo', good, { id: tt.id });
  assert.equal(r.status, 200);
  const logo = r.body.logo as { mime: string; bytes: number; data: string };
  assert.equal(logo.mime, 'image/png');
  assert.equal(logo.bytes, PNG.length, 'bytes is the DECODED length');
  assert.ok(!logo.data.startsWith('data:'), 'no data: prefix — the consumer adds its own');
  assert.deepEqual(Buffer.from(logo.data, 'base64'), PNG, 'and it must decode back to the original');
});

test('an SVG logo is refused, even though the screens render it perfectly well', () => {
  // An SVG is a script container, and this image becomes an app icon on a phone after being
  // parsed and re-encoded by the consumer. 415 rather than a silent null so an admin wondering
  // why their logo did not carry over has something to find.
  const tt = withLogo(SVG, 'image/svg+xml');
  const r = call(store(tt), 'logo', good, { id: tt.id });
  assert.equal(r.status, 415);
  assert.equal(r.body.error, 'logo_not_raster');
});

test('an SVG named .png is still refused — the bytes decide, never the extension', () => {
  // The case a denylist on the file extension would wave straight through.
  const tt = withLogo(SVG, 'image/png');
  assert.ok(tt.logoImage.endsWith('.png'), 'the file really is named .png');
  const r = call(store(tt), 'logo', good, { id: tt.id });
  assert.equal(r.status, 415);
  assert.equal(r.body.error, 'logo_not_raster');
});

test('an oversized logo is refused rather than truncated by the broker', () => {
  // A response over the ceiling arrives cut in half, which is a corrupt image that nothing in
  // the chain reports as corrupt. Better to say so.
  const tt = withLogo(Buffer.concat([PNG, Buffer.alloc(TIMETABLE_LOGO_MAX_BYTES)]));
  const r = call(store(tt), 'logo', good, { id: tt.id });
  assert.equal(r.status, 413);
  assert.equal(r.body.error, 'logo_too_large');
});

test('a logo exactly at the cap is still served', () => {
  const tt = withLogo(Buffer.concat([PNG, Buffer.alloc(TIMETABLE_LOGO_MAX_BYTES - PNG.length)]));
  const r = call(store(tt), 'logo', good, { id: tt.id });
  assert.equal(r.status, 200);
  assert.equal((r.body.logo as { bytes: number }).bytes, TIMETABLE_LOGO_MAX_BYTES);
});

test('the cap is derived from the broker ceiling, not guessed', () => {
  // Raising TIMETABLE_LOGO_MAX_BYTES without redoing this arithmetic is exactly the mistake
  // this asserts against: base64 costs a third more, so the encoded answer is what has to fit.
  const { encoded, ceiling } = logoResponseCeilingHeadroom();
  assert.equal(base64Length(3), 4);
  assert.equal(base64Length(1), 4, 'padding counts');
  assert.ok(encoded < ceiling, `${encoded} must fit inside ${ceiling}`);
  assert.ok(encoded < ceiling * 0.95, `only ${ceiling - encoded} bytes spare — too tight`);
});

test('a logoImage naming a file that is not there is no logo, not a failure', () => {
  // A restore that missed /data/uploads. The screens fall back to the built-in mark in exactly
  // this situation, so the honest answer here is the same one.
  const tt = timetable();
  tt.logoImage = 'nope.logo.png';
  const r = call(store(tt), 'logo', good, { id: tt.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.logo, null);
});

test('a logoImage that tries to escape the uploads directory reads nothing', () => {
  for (const evil of ['../../db.json', '../db.json', '/etc/passwd', 'a/../../db.json', '..']) {
    const tt = timetable();
    tt.logoImage = evil;
    const r = call(store(tt), 'logo', good, { id: tt.id });
    assert.equal(r.status, 200, evil);
    assert.equal(r.body.logo, null, evil);
  }
});

test('logo refuses an unknown id and a missing id, like get does', () => {
  const s = store();
  assert.equal(call(s, 'logo', good, { id: 'tt_deadbeef' }).status, 404);
  assert.equal(call(s, 'logo', good, { id: 'tt_deadbeef' }).body.error, 'unknown_timetable');
  assert.equal(call(s, 'logo', good, {}).status, 400);
  assert.equal(call(s, 'logo', good, { id: 42 }).status, 400);
});

test('logo needs no location, unlike get', () => {
  // A masjid can have uploaded their logo before setting coordinates, and the icon is still
  // theirs. Gating this on a location would be borrowing an unrelated failure.
  const tt = withLogo(PNG);
  tt.latitude = null;
  tt.longitude = null;
  const r = call(store(tt), 'logo', good, { id: tt.id });
  assert.equal(r.status, 200);
  assert.equal((r.body.logo as { mime: string }).mime, 'image/png');
});

test('logo is bound to its own path like the other two methods', () => {
  const tt = withLogo(PNG);
  assert.equal(call(store(tt), 'logo', good, { id: tt.id }, TIMETABLE_GET_PATH).status, 403);
  assert.equal(call(store(tt), 'logo', good, { id: tt.id }, TIMETABLE_LIST_PATH).status, 403);
  assert.equal(call(store(tt), 'logo', good, { id: tt.id }, '/display/../fabric/timetable/logo').status, 403);
});

test('readLogo is the whole decision, and it is pure', () => {
  // Called twice on the same timetable it must answer identically — no cache to go stale, no
  // clock, nothing recorded.
  const tt = withLogo(PNG);
  assert.deepEqual(readLogo(tt), readLogo(tt));
});

test('the path/method mapping is one source of truth in both directions', () => {
  const methods = Object.keys(TIMETABLE_PATHS) as (keyof typeof TIMETABLE_PATHS)[];
  assert.deepEqual(methods.sort(), ['get', 'list', 'logo']);
  for (const m of methods) {
    assert.equal(TIMETABLE_METHOD_BY_PATH.get(TIMETABLE_PATHS[m]), m, `${m} must round-trip`);
    assert.equal(TIMETABLE_PATHS[m], `/fabric/timetable/${m}`);
  }
});

test('the reverse lookup has no prototype hole', () => {
  // The key is an attacker-supplied pathname. A plain object would answer `constructor` with a
  // truthy function off the prototype chain, and the branch tests only truthiness.
  for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '']) {
    assert.equal(TIMETABLE_METHOD_BY_PATH.get(k), undefined, k);
  }
});

// ---------------------------------------------------------------------------
// Properties of the whole route
// ---------------------------------------------------------------------------

test('the answer depends only on the timetable and the range — there is no clock in it', () => {
  const tt = timetable();
  const a = buildFeed(tt, THURSDAY, 9);
  const b = buildFeed(tt, THURSDAY, 9);
  assert.deepEqual(a, b);
  // No `isToday`, no countdown, nothing that would make the same request answer differently an
  // hour later — which is what lets a consumer cache it and a test assert on it.
  const flat = JSON.stringify(a);
  assert.ok(!flat.includes('isToday'));
  assert.ok(!flat.includes('inSeconds'));
});

test('a full 45-day answer fits the broker\u2019s 256 KB ceiling with room to spare', () => {
  // The worst case a masjid can actually configure: the day cap, eight Jumu'ah jamā'āt, the
  // longest names the store allows, and Arabic labels (three bytes a character in UTF-8).
  const tt = timetable({
    language: 'ar',
    name: '\u0645'.repeat(80),
    masjidName: '\u0645'.repeat(80),
    jumuah: ['12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00'],
    timezone: 'Asia/Karachi',
  });
  const bytes = Buffer.byteLength(JSON.stringify(buildFeed(tt, THURSDAY, TIMETABLE_MAX_DAYS)), 'utf8');
  assert.ok(bytes < 128 * 1024, `a 45-day answer was ${bytes} bytes — half the ceiling is the alarm line`);
});

test('the capability is read-only, and this is asserted rather than intended', () => {
  // A provider that can write turns a leaked secret into an attacker repointing a masjid's
  // prayer times. The module must never reach for the store's writer.
  const s = src('fabricTimetable.ts');
  assert.ok(!/\.update\s*\(/.test(s), 'fabricTimetable.ts must never call store.update');
  assert.ok(!/\bdb\s*\./.test(s.replace(/store\.db\./g, '')), 'nor mutate the db object directly');
  // It reads the filesystem now, for the logo. Read-only has to mean the disk as well: this
  // module handles a request from another app and must not be a way to write one byte anywhere.
  for (const w of ['writeFileSync', 'appendFileSync', 'unlinkSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'renameSync', 'createWriteStream', 'writeFile', 'copyFileSync', 'chmodSync', 'openSync', 'truncateSync', 'symlinkSync']) {
    assert.ok(!s.includes(w), `fabricTimetable.ts must never call fs.${w}`);
  }
  // The routes a string check on `fs.*` would miss entirely.
  assert.ok(!s.includes('fs/promises'), 'nor the promises API, where the writers are named differently');
  assert.ok(!s.includes('child_process'), 'nor shell out');
  assert.ok(!/saveLogo|saveAsset|saveBackground|removeLogo|saveAnnouncement/.test(s), 'nor reach for an asset WRITER');
  // Reading is expected — the logo lives on disk — so pin that it is ONLY these two.
  assert.deepEqual(
    [...s.matchAll(/\bfs\.(\w+)/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).sort(),
    ['readFileSync', 'statSync'],
  );
});

test('api.ts registers the two exact paths and nothing prefixed', () => {
  const s = src('api.ts');
  // Registered from the constants, so the route, the handler's own check, the manifest and the
  // docs cannot drift apart into three different opinions about the path.
  assert.match(s, /TIMETABLE_METHOD_BY_PATH\.get\(pathname\)/);
  assert.match(s, /readBody\(req, TIMETABLE_MAX_BODY_BYTES\)/, 'the body cap must be the exported constant');
  assert.equal(TIMETABLE_MAX_BODY_BYTES, 8_000);
  // Not the tunnel's form, and not a regex that would tolerate a base-path segment the way the
  // public widget's deliberately does.
  // A string literal here would be a SECOND registration, free to drift from the constant the
  // handler re-checks against. A mention in a comment is fine and there is one.
  assert.ok(!/['"`]\/fabric\/timetable/.test(s), 'the paths must come from the constants, never be spelled out as literals');
  assert.equal(TIMETABLE_LIST_PATH, '/fabric/timetable/list');
  assert.equal(TIMETABLE_GET_PATH, '/fabric/timetable/get');
  assert.equal(TIMETABLE_LOGO_PATH, '/fabric/timetable/logo');
});

test('a GET on a capability path says so, instead of returning the panel', () => {
  // The static branch further down answers ANY non-/api/ GET with index.html, so matching only
  // on POST would hand somebody debugging their integration a page of HTML with a 200 on it.
  // The branch therefore matches on the path alone and answers 405 itself.
  const s = src('api.ts');
  const branch = s.indexOf('TIMETABLE_METHOD_BY_PATH.get(pathname)');
  const spa = s.indexOf("if (!pathname.startsWith('/api/') && method === 'GET')");
  assert.ok(branch > 0 && spa > 0);
  assert.ok(branch < spa, 'the capability paths must be claimed before the static/SPA catch-all');
  const arm = s.slice(branch, branch + 1400);
  assert.match(arm, /method !== 'POST'.*method_not_allowed/s);
  // The guard itself must not mention the method — checked on the text BETWEEN the lookup and
  // the 405, so it holds whatever spelling a future edit uses. A pattern matching one particular
  // spelling of the mistake is worth very little: the first version of this assertion pinned
  // `TIMETABLE_GET_PATH) && method === 'POST'`, and the very next refactor moved the lookup onto
  // its own line, at which point it could never have fired again. What matters is not how the
  // guard is written but that a GET reaches the 405 rather than the SPA.
  // Comments stripped, because the comment explaining the rule necessarily says "method".
  const guard = arm
    .slice(0, arm.indexOf("method !== 'POST'"))
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
  assert.ok(
    !/\bmethod\b/.test(guard),
    'the guard must not test the request method — folding that in sends a GET to index.html and\n' +
      `leaves the 405 below it dead:\n${guard}`,
  );
});

test('the route sits above the session gate and behind a limiter', () => {
  const s = src('api.ts');
  const route = s.indexOf('TIMETABLE_METHOD_BY_PATH.get(pathname)');
  const gate = s.indexOf("if (!authed(req)) return sendJson(res, 401,");
  assert.ok(route > 0 && gate > 0);
  assert.ok(route < gate, 'the broker has no session cookie of ours, so it must be reachable above the gate');
  // And therefore it carries its own limiter, keyed on the socket like every other check that
  // sits in front of a secret comparison.
  assert.match(s, /fabricAppLimiter\.allow\(req\)/);
  assert.match(s, /const fabricAppLimiter = new RequestLimiter\(60, 60_000, true\)/);
  assert.match(s, /fabricAppLimiter\.prune\(\)/, 'an untracked limiter map is a leak');
});

test('the manifest declares the capability, and still keeps commands out of it', () => {
  const y = fs.readFileSync(path.join(REPO_DIR, 'manifest.yaml'), 'utf8');
  const block = /^fabric:\r?\n((?:[ \t].*\r?\n|\r?\n)*)/m.exec(y);
  assert.ok(block, 'manifest.yaml must carry a fabric: block');
  const provided = [...block![1].matchAll(/^\s*-\s*capability:\s*(\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(provided, ['timetable']);
  assert.ok(!provided.includes('commands'), 'commands is reserved: in provides it would expose the wizard');
  // The path segment IS the capability name, which is what makes one grant unable to reach
  // another capability's handler.
  assert.equal(TIMETABLE_LIST_PATH, `/fabric/${provided[0]}/list`);
});

test('the docs describe the capability that actually ships', () => {
  const doc = fs.readFileSync(path.join(REPO_DIR, 'docs', 'USING_THE_FABRIC.md'), 'utf8');
  assert.ok(doc.includes(TIMETABLE_LIST_PATH), 'USING_THE_FABRIC.md must name the list path');
  assert.ok(doc.includes(TIMETABLE_GET_PATH), 'USING_THE_FABRIC.md must name the get path');
  assert.ok(doc.includes(String(TIMETABLE_MAX_DAYS)), 'and the day cap a consumer has to respect');
});
