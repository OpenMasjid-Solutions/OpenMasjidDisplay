// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The rules that decide whether a WhatsApp announcement goes out.
 *
 * Two of them are worth stating plainly, because both fail silently in production if they
 * regress and neither is visible from a screenshot:
 *
 *  - **Exactly one automatic post per change.** The dedupe key lives in the persisted log, so
 *    a restart must not re-announce something the group already has. A masjid getting the
 *    same notice twice is the failure people actually complain about.
 *  - **A change added inside the window goes immediately.** There is no separate "urgent"
 *    path; it falls out of asking "is there a change between today and `daysBefore`?" every
 *    minute. If `minDays` ever crept back to 1, a same-day change would silently never send.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normTimetable, normSettings } from './validate';
import { normalizeIqamahSchedule } from './iqamahSchedule';
import { decideAnnounce, announceMessage, announceTimetable, WA_MAX_ATTEMPTS, WA_RETRY_MS } from './whatsappAnnounce';
import type { AnnounceDecision, AnnounceTarget } from './whatsappAnnounce';
import type { DB, Settings, Timetable, WhatsAppLogEntry } from './types';

const NOW = new Date('2026-08-15T15:00:00Z').getTime();
const GROUP = '120363012345678901@g.us';

function ttWith(schedule: unknown[], over: Record<string, unknown> = {}): Timetable {
  const tt = normTimetable({
    masjidName: 'Madani Academy Masjid',
    location: 'Lansdale, Pennsylvania',
    latitude: 40.2415,
    longitude: -75.2838,
    method: 'ISNA',
    asrMadhab: 'Hanafi',
    timezone: 'America/New_York',
    timeFormat: '12h',
    ...over,
  });
  tt.iqamahSchedule = normalizeIqamahSchedule(schedule);
  return tt;
}

function baseSettings(over: Record<string, unknown> = {}): Settings {
  return normSettings(
    { whatsapp: { iqamahChange: true, groupId: GROUP, groupLabel: 'Masjid Announcements', timetableId: '', daysBefore: 3, ...over } },
    normSettings({}, {
      defaultQuality: '1080p',
      scheduleTimezone: '',
      volunteerEnabled: false,
      volunteerRemote: true,
      whatsapp: { iqamahChange: false, groupId: '', groupLabel: '', timetableId: '', daysBefore: 1 },
    } as Settings),
  );
}

function dbWith(timetables: Timetable[], waOver: Record<string, unknown> = {}, log: WhatsAppLogEntry[] = []): DB {
  return {
    version: 1,
    admin: null,
    volunteerAuth: null,
    settings: baseSettings(waOver),
    timetables,
    sources: [],
    tvs: [],
    schedules: [],
    whatsappLog: log,
  };
}

/** Assert a decision was "post" and hand back the target, narrowed. */
function mustPost(d: AnnounceDecision): AnnounceTarget {
  assert.equal(d.act, 'post', d.act === 'skip' ? `expected a post, got: ${d.why}` : '');
  if (d.act !== 'post') throw new Error('unreachable');
  return d.target;
}

const queued = (effectiveFrom: string, over: Partial<WhatsAppLogEntry> = {}): WhatsAppLogEntry => ({
  at: new Date(NOW - 60_000).toISOString(),
  event: 'iqamah-change',
  recipient: GROUP,
  effectiveFrom,
  outcome: 'queued',
  ...over,
});

// ── The window ───────────────────────────────────────────────────────────────

test('a change inside the lead window is posted', () => {
  // 2026-08-17 is two days from NOW, inside daysBefore: 3.
  const db = dbWith([ttWith([{ from: '2026-08-17', asr: '17:15' }])]);
  const d = decideAnnounce(db, NOW);
  assert.equal(d.act, 'post');
  assert.equal(d.act === 'post' && d.target.effectiveFrom, '2026-08-17');
});

test('a change beyond the lead window waits', () => {
  const db = dbWith([ttWith([{ from: '2026-09-01', asr: '17:15' }])]);
  const d = decideAnnounce(db, NOW);
  assert.equal(d.act, 'skip');
  assert.match(d.act === 'skip' ? d.why : '', /next 3 days/);
});

test('a change taking effect TODAY still goes out — this is the last-minute case', () => {
  // The whole "added at the last minute" behaviour is this: minDays is 0, not 1. A same-day
  // entry satisfies the window on the very next check with no separate rule for urgency.
  const db = dbWith([ttWith([{ from: '2026-08-15', asr: '17:15' }])], { daysBefore: 0 });
  const d = decideAnnounce(db, NOW);
  assert.equal(d.act, 'post');
  assert.equal(d.act === 'post' && d.target.effectiveFrom, '2026-08-15');
});

test('with daysBefore 0, tomorrow is still too early', () => {
  const db = dbWith([ttWith([{ from: '2026-08-16', asr: '17:15' }])], { daysBefore: 0 });
  assert.equal(decideAnnounce(db, NOW).act, 'skip');
});

test('a change that has already passed is never announced automatically', () => {
  const db = dbWith([ttWith([{ from: '2026-08-01', asr: '17:15' }])], { daysBefore: 14 });
  assert.equal(decideAnnounce(db, NOW).act, 'skip');
});

// ── Exactly once ─────────────────────────────────────────────────────────────

test('a change already queued to that group is not sent again', () => {
  const db = dbWith([ttWith([{ from: '2026-08-17', asr: '17:15' }])], {}, [queued('2026-08-17')]);
  const d = decideAnnounce(db, NOW);
  assert.equal(d.act, 'skip');
  assert.match(d.act === 'skip' ? d.why : '', /already been sent/);
});

test('the dedupe is per group — moving to a different group re-announces', () => {
  const db = dbWith([ttWith([{ from: '2026-08-17', asr: '17:15' }])], {}, [
    queued('2026-08-17', { recipient: '120363099999999999@g.us' }),
  ]);
  assert.equal(decideAnnounce(db, NOW).act, 'post');
});

test('a different change date is a different announcement', () => {
  const db = dbWith([ttWith([{ from: '2026-08-17', asr: '17:15' }])], {}, [queued('2026-06-01')]);
  assert.equal(decideAnnounce(db, NOW).act, 'post');
});

test('a FAILED attempt does not count as sent, but is not retried immediately', () => {
  const failed: WhatsAppLogEntry = { ...queued('2026-08-17'), outcome: 'failed', error: 'gateway down' };
  const db = dbWith([ttWith([{ from: '2026-08-17', asr: '17:15' }])], {}, [failed]);
  const soon = decideAnnounce(db, NOW);
  assert.equal(soon.act, 'skip');
  assert.match(soon.act === 'skip' ? soon.why : '', /retrying/);

  // …but it IS retried once the backoff has elapsed.
  assert.equal(decideAnnounce(db, NOW + WA_RETRY_MS + 1000).act, 'post');
});

test('repeated failures give up rather than retrying forever', () => {
  const log = Array.from({ length: WA_MAX_ATTEMPTS }, (_, i) => ({
    ...queued('2026-08-17'),
    at: new Date(NOW - (i + 2) * WA_RETRY_MS).toISOString(),
    outcome: 'failed' as const,
    error: 'that group has not been approved',
  }));
  const db = dbWith([ttWith([{ from: '2026-08-17', asr: '17:15' }])], {}, log);
  const d = decideAnnounce(db, NOW);
  assert.equal(d.act, 'skip');
  assert.match(d.act === 'skip' ? d.why : '', /Gave up/);
});

// ── The guards ───────────────────────────────────────────────────────────────

test('nothing is posted while the feature is switched off', () => {
  const db = dbWith([ttWith([{ from: '2026-08-17', asr: '17:15' }])], { iqamahChange: false });
  const d = decideAnnounce(db, NOW);
  assert.equal(d.act, 'skip');
  assert.match(d.act === 'skip' ? d.why : '', /switched off/);
});

test('nothing is posted without a group, even switched on', () => {
  const db = dbWith([ttWith([{ from: '2026-08-17', asr: '17:15' }])], { groupId: '' });
  const d = decideAnnounce(db, NOW);
  assert.equal(d.act, 'skip');
  assert.match(d.act === 'skip' ? d.why : '', /no whatsapp group/i);
});

test('a timetable with no location cannot be announced', () => {
  const db = dbWith([ttWith([{ from: '2026-08-17', asr: '17:15' }], { latitude: null, longitude: null })]);
  const d = decideAnnounce(db, NOW);
  assert.equal(d.act, 'skip');
  assert.match(d.act === 'skip' ? d.why : '', /location/);
});

// ── Which timetable ──────────────────────────────────────────────────────────

test('the chosen timetable is announced, not the first one', () => {
  const a = ttWith([{ from: '2026-08-17', asr: '17:15' }], { masjidName: 'First' });
  const b = ttWith([{ from: '2026-08-18', asr: '18:15' }], { masjidName: 'Second' });
  const db = dbWith([a, b], { timetableId: b.id });
  assert.equal(announceTimetable(db)?.id, b.id);
  const d = decideAnnounce(db, NOW);
  assert.equal(d.act === 'post' && d.target.effectiveFrom, '2026-08-18');
});

test('a chosen timetable that has since been deleted announces nothing', () => {
  // Better silent than announcing a different masjid's times because the id went stale.
  const db = dbWith([ttWith([{ from: '2026-08-17', asr: '17:15' }])], { timetableId: 'gone' });
  assert.equal(announceTimetable(db), null);
  assert.equal(decideAnnounce(db, NOW).act, 'skip');
});

test('with no timetable chosen it falls back to the first', () => {
  const a = ttWith([{ from: '2026-08-17', asr: '17:15' }]);
  const b = ttWith([{ from: '2026-08-18', asr: '18:15' }]);
  assert.equal(announceTimetable(dbWith([a, b]))?.id, a.id);
});

// ── "Send now" ───────────────────────────────────────────────────────────────

test('Send now reaches past the window and past the dedupe', () => {
  // Far outside daysBefore: 3, and already queued — the automatic path would refuse both.
  const db = dbWith([ttWith([{ from: '2026-11-01', asr: '17:15' }])], {}, [queued('2026-11-01')]);
  assert.equal(decideAnnounce(db, NOW).act, 'skip');
  const manual = decideAnnounce(db, NOW, true);
  assert.equal(manual.act, 'post');
  assert.equal(manual.act === 'post' && manual.target.effectiveFrom, '2026-11-01');
});

test('Send now falls back to the most recent past change, like the poster', () => {
  const db = dbWith([ttWith([{ from: '2026-06-01', asr: '17:15' }])]);
  const manual = decideAnnounce(db, NOW, true);
  assert.equal(manual.act, 'post');
  assert.equal(manual.act === 'post' && manual.target.effectiveFrom, '2026-06-01');
});

test('Send now still refuses when the feature is off but a group is set', () => {
  // The switch governs the SCHEDULE; the button is an explicit act. But a group is still
  // required, because there is nowhere else for it to go.
  const db = dbWith([ttWith([{ from: '2026-08-17', asr: '17:15' }])], { iqamahChange: false });
  assert.equal(decideAnnounce(db, NOW, true).act, 'post');
  const noGroup = dbWith([ttWith([{ from: '2026-08-17', asr: '17:15' }])], { iqamahChange: false, groupId: '' });
  assert.equal(decideAnnounce(noGroup, NOW, true).act, 'skip');
});

// ── The message ──────────────────────────────────────────────────────────────

test('the message names the change, marks what moved, and strikes the old time', () => {
  const db = dbWith([ttWith([{ from: '2026-08-17', asr: '17:15' }])]);
  const msg = announceMessage(mustPost(decideAnnounce(db, NOW)));

  assert.match(msg, /^\*IQĀMAH TIME IS CHANGING\*/, 'the headline leads — it is the group notification preview');
  assert.match(msg, /Madani Academy Masjid/);
  assert.match(msg, /From Monday, 17 August 2026 \(in 2 days\)/);
  // The changed row is bold and carries the previous time struck through.
  assert.match(msg, /\*Asr — 5:15 PM\*\s+\(was ~\d{1,2}:\d{2} [AP]M~\)/);
  // …and an unchanged row is plain, so the eye lands on the difference.
  assert.match(msg, /\nFajr — \d{1,2}:\d{2} AM\n/);
  assert.ok(!msg.includes('Sunrise'), 'sunrise has no jamaah, so it cannot change');
});

test('several changes read as plural', () => {
  const db = dbWith([ttWith([{ from: '2026-08-17', fajr: '05:45', asr: '17:15' }])]);
  const d = decideAnnounce(db, NOW);
  assert.match(announceMessage(mustPost(d)), /^\*IQĀMAH TIMES ARE CHANGING\*/);
});

test('a past change is announced in the past tense', () => {
  const db = dbWith([ttWith([{ from: '2026-06-01', asr: '17:15' }])]);
  const d = decideAnnounce(db, NOW, true);
  const msg = announceMessage(mustPost(d));
  assert.match(msg, /^\*IQĀMAH TIME HAS CHANGED\*/);
  assert.match(msg, /Since Monday, 1 June 2026 \(in effect for 75 days\)/);
});

test("a masjid name containing WhatsApp's formatting characters cannot break the message", () => {
  // There is no escape syntax in WhatsApp markup, so a stray '*' would open a bold run that
  // swallows the rest of the notice. The characters are stripped instead.
  const db = dbWith([ttWith([{ from: '2026-08-17', asr: '17:15' }], { masjidName: 'Masjid *An-Noor* ~x~ _y_' })]);
  const d = decideAnnounce(db, NOW);
  const msg = announceMessage(mustPost(d));
  assert.match(msg, /Masjid An-Noor x y/);
  // Every remaining '*' must be part of a balanced pair we put there ourselves.
  assert.equal((msg.match(/\*/g) ?? []).length % 2, 0);
});

test('Jumuah is included when the timetable has it', () => {
  const db = dbWith([ttWith([{ from: '2026-08-17', asr: '17:15', jumuah: ['13:30', '14:30'] }])]);
  const d = decideAnnounce(db, NOW);
  assert.match(announceMessage(mustPost(d)), /Jumu'ah — 1:30 PM · 2:30 PM/);
});

test('a CSV-driven timetable announces too — the same detector serves both', () => {
  // A masjid that uploads a year of times has no iqamahSchedule entries at all, and this
  // used to be the case that quietly did nothing.
  const tt = ttWith([]);
  tt.iqamahYear = { '08-17': { asr: '17:15' } };
  assert.equal(decideAnnounce(dbWith([tt]), NOW).act, 'post');
});
