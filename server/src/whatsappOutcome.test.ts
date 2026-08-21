// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Following a WhatsApp message past the 202 (OpenMasjidOS 0.51.1+).
 *
 * For a long time `queued` was the last thing anybody knew, and while the platform's queue had
 * a head-of-line block — one held-up message stopping every message behind it, from every app,
 * and a failing one pausing the whole queue for its retry delay — the symptom here was a
 * poster that never arrived with nothing at either end able to say so. The platform now hands
 * back an id and answers what became of it.
 *
 * Two things in this file are the ones that actually bite:
 *
 *  - **A confirmed message must not be announced again.** The dedupe used to read "is there a
 *    queued entry?", which was the same question as "has this been handled?" only because
 *    `queued` was the only success. Now that an entry can become `sent`, that check stops
 *    matching at exactly the moment the platform confirms delivery — and the next tick posts
 *    the same change to the group a second time. Success becoming a duplicate is a worse
 *    outcome than the bug it came from.
 *  - **"We could not ask" is not "it failed".** An unreachable platform, a 404 from a bounded
 *    history, a timeout — none of them may turn a delivered notice into a failed one, because
 *    the app's response to a failure is to send it again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normTimetable, normSettings } from './validate';
import { normalizeIqamahSchedule } from './iqamahSchedule';
import { decideAnnounce, WA_MAX_ATTEMPTS, WA_RETRY_MS, WA_OUTCOME_WINDOW_MS } from './whatsappAnnounce';
import type { DB, Settings, Timetable, WhatsAppLogEntry } from './types';
import type { WhatsAppAvailability, WhatsAppOutcome } from './fabric';

const NOW = new Date('2026-08-15T15:00:00Z').getTime();
const GROUP = '120363012345678901@g.us';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const CAN_ASK: WhatsAppAvailability = { available: true, reason: 'ready', media: true, maxMediaBytes: 2_097_152, outcomes: true };
const CANNOT_ASK: WhatsAppAvailability = { ...CAN_ASK, outcomes: false };

function timetable(): Timetable {
  const tt = normTimetable({
    masjidName: 'Madani Academy Masjid',
    latitude: 40.2415, longitude: -75.2838,
    method: 'ISNA', asrMadhab: 'Hanafi', timezone: 'America/New_York', timeFormat: '12h',
  });
  tt.iqamahSchedule = normalizeIqamahSchedule([{ from: '2026-08-17', asr: '17:15' }]);
  return tt;
}

function settings(): Settings {
  const empty = {
    defaultQuality: '1080p', scheduleTimezone: '', volunteerEnabled: false, volunteerRemote: true,
    whatsapp: { iqamahChange: false, groupId: '', groupLabel: '', timetableId: '', daysBefore: 1 },
    webScreensBeta: false,
  } as Settings;
  return normSettings({ whatsapp: { iqamahChange: true, groupId: GROUP, daysBefore: 3 } }, empty);
}

function dbWith(log: WhatsAppLogEntry[]): DB {
  return {
    version: 1, admin: null, volunteerAuth: null, settings: settings(),
    timetables: [timetable()], sources: [], tvs: [], schedules: [], whatsappLog: log,
  } as unknown as DB;
}

const entry = (over: Partial<WhatsAppLogEntry> = {}): WhatsAppLogEntry => ({
  at: new Date(NOW - 60_000).toISOString(),
  event: 'iqamah-change',
  recipient: GROUP,
  effectiveFrom: '2026-08-17',
  outcome: 'queued',
  id: 'wa_1',
  ...over,
});

// ── the dedupe, which has to count a confirmed message ──────────────────────

test('a message the platform CONFIRMED is not announced a second time', () => {
  const d = decideAnnounce(dbWith([entry({ outcome: 'sent', settledAt: new Date(NOW - 30_000).toISOString() })]), NOW);
  assert.equal(d.act, 'skip', d.act === 'post' ? 'a confirmed notice was about to be re-sent to the group' : '');
  assert.match(d.act === 'skip' ? d.why : '', /already been sent/);
});

test('a message still in the queue is not announced a second time either', () => {
  const d = decideAnnounce(dbWith([entry()]), NOW);
  assert.equal(d.act, 'skip');
});

// ── a verdict of "it did not go" re-opens the retry ─────────────────────────

test('a message the platform later FAILED is retried, once the backoff has passed', () => {
  const settledAt = new Date(NOW - WA_RETRY_MS - 1000).toISOString();
  const d = decideAnnounce(dbWith([entry({ outcome: 'failed', settledAt, error: 'the gateway rejected it' })]), NOW);
  assert.equal(d.act, 'post', 'a notice that did not arrive has to be sent again');
});

test('an EXPIRED message counts as a failure, not as a delivery', () => {
  // It differs from `failed` only in whose patience ran out — the group still has nothing.
  const settledAt = new Date(NOW - WA_RETRY_MS - 1000).toISOString();
  const d = decideAnnounce(dbWith([entry({ outcome: 'expired', settledAt, error: 'expired' })]), NOW);
  assert.equal(d.act, 'post');
});

test('the backoff runs from when we LEARNED it failed, not from when it was queued', () => {
  // Queued well over the retry window ago, reported failed a moment ago. Backing off from the
  // queue time would retry at once and, if the cause is still there, burn the whole budget in
  // minutes — five attempts spent before anybody could look at it.
  const d = decideAnnounce(
    dbWith([entry({
      at: new Date(NOW - WA_RETRY_MS * 3).toISOString(),
      outcome: 'failed',
      settledAt: new Date(NOW - 5_000).toISOString(),
    })]),
    NOW,
  );
  assert.equal(d.act, 'skip');
  assert.match(d.act === 'skip' ? d.why : '', /Waiting before retrying/);
});

test('expired attempts count against the same budget as failed ones', () => {
  const old = (i: number) => new Date(NOW - WA_RETRY_MS - i * 1000).toISOString();
  const log = Array.from({ length: WA_MAX_ATTEMPTS }, (_, i) =>
    entry({ id: `wa_${i}`, outcome: i % 2 ? 'expired' : 'failed', settledAt: old(i + 1) }),
  );
  const d = decideAnnounce(dbWith(log), NOW);
  assert.equal(d.act, 'skip');
  assert.match(d.act === 'skip' ? d.why : '', new RegExp(`Gave up after ${WA_MAX_ATTEMPTS}`));
});

// ── asking the platform ────────────────────────────────────────────────────

/** An announcer over a real Store, with the platform stubbed. A real store matters: the
 *  reconcile writes through it and the dedupe reads it back. */
function harness(opts: { cap?: WhatsAppAvailability; status?: (id: string) => WhatsAppOutcome; sendId?: string | undefined } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-wa-out-'));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const { Store } = require('./store') as typeof import('./store');
  const { WhatsAppAnnouncer } = require('./whatsappAnnounce') as typeof import('./whatsappAnnounce');

  const store = new Store();
  store.update((db) => {
    db.timetables = [timetable()];
    db.settings = settings();
    db.whatsappLog = [];
  });
  const asked: string[] = [];
  let caps = 0;
  let clock = NOW;
  const a = new WhatsAppAnnouncer({
    store,
    now: () => clock,
    capability: async () => { caps++; return opts.cap ?? CAN_ASK; },
    render: async () => PNG,
    send: async () => ('sendId' in opts ? { queued: true, id: opts.sendId } : { queued: true, id: 'wa_sent_1' }),
    status: async (id) => { asked.push(id); return opts.status ? opts.status(id) : { state: 'queued' }; },
  });
  return {
    a, store, asked,
    capabilityCalls: () => caps,
    advance: (ms: number) => { clock += ms; },
    log: () => store.db.whatsappLog ?? [],
    cleanup: () => {
      if (prev === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the id the platform hands back is stored against what was announced', async () => {
  const h = harness();
  try {
    await h.a.tick();
    assert.equal(h.log().length, 1);
    assert.equal(h.log()[0].id, 'wa_sent_1', 'without this, "did that notice go out?" is unanswerable');
    assert.equal(h.log()[0].outcome, 'queued');
  } finally {
    h.cleanup();
  }
});

test('an older platform that hands back no id still posts, and simply cannot be followed up', async () => {
  const h = harness({ sendId: undefined });
  try {
    await h.a.tick();
    assert.equal(h.log()[0].outcome, 'queued');
    assert.equal(h.log()[0].id, undefined);
    // And nothing is asked about, because there is nothing to ask with.
    await h.a.tick();
    assert.deepEqual(h.asked, []);
  } finally {
    h.cleanup();
  }
});

test('a queued entry becomes sent once the platform says so', async () => {
  const h = harness({ status: () => ({ state: 'sent' }) });
  try {
    await h.a.tick(); // posts
    await h.a.tick(); // reconciles
    assert.deepEqual(h.asked, ['wa_sent_1']);
    assert.equal(h.log()[0].outcome, 'sent');
    assert.ok(h.log()[0].settledAt, 'when we learned it is what the backoff and the panel both read');
  } finally {
    h.cleanup();
  }
});

test('a queued entry becomes failed, with the platform\'s own reason', async () => {
  const h = harness({ status: () => ({ state: 'failed', reason: 'the gateway is not linked' }) });
  try {
    await h.a.tick();
    await h.a.tick();
    assert.equal(h.log()[0].outcome, 'failed');
    assert.equal(h.log()[0].error, 'the gateway is not linked');
  } finally {
    h.cleanup();
  }
});

test('a platform that cannot be asked leaves the entry exactly as it was', async () => {
  // Three different ways of not knowing, and none of them may look like a failure: the app's
  // answer to a failure is to send the message again, to a group that may already have it.
  for (const status of [
    () => ({ state: null }) as WhatsAppOutcome,
    () => ({ state: 'queued' }) as WhatsAppOutcome,
  ]) {
    const h = harness({ status });
    try {
      await h.a.tick();
      await h.a.tick();
      assert.equal(h.log()[0].outcome, 'queued');
      assert.equal(h.log()[0].settledAt, undefined);
    } finally {
      h.cleanup();
    }
  }
});

test('a platform without the status endpoint is not asked at all', async () => {
  const h = harness({ cap: CANNOT_ASK, status: () => ({ state: 'sent' }) });
  try {
    await h.a.tick();
    await h.a.tick();
    assert.deepEqual(h.asked, [], 'outcomes: false means the endpoint is not there to call');
    assert.equal(h.log()[0].outcome, 'queued');
  } finally {
    h.cleanup();
  }
});

test('nothing outstanding means no request at all', async () => {
  const h = harness({ status: () => ({ state: 'sent' }) });
  try {
    await h.a.tick(); // posts, one capability read for the poster
    const afterPost = h.capabilityCalls();
    await h.a.tick(); // reconciles the one queued entry
    await h.a.tick(); // nothing left waiting
    assert.equal(h.capabilityCalls(), afterPost + 1, 'a masjid with nothing pending should not poll the platform');
  } finally {
    h.cleanup();
  }
});

test('an entry too old to be worth asking about is left alone', async () => {
  const h = harness({ status: () => ({ state: 'sent' }) });
  try {
    h.store.update((db) => {
      db.whatsappLog = [entry({ at: new Date(NOW - WA_OUTCOME_WINDOW_MS - 1000).toISOString() })];
    });
    await h.a.tick();
    assert.deepEqual(h.asked, [], 'the platform keeps only its most recent outcomes; an old id is gone');
    assert.equal(h.log()[0].outcome, 'queued');
  } finally {
    h.cleanup();
  }
});

test('a settled failure re-opens the announcement, once the backoff from the VERDICT has passed', async () => {
  // The reconcile runs before the decision so the decision sees the current truth rather than a
  // stale `queued`. It does not shortcut the backoff: the wait runs from the moment we learned the
  // message failed, or one persistent fault would spend all five attempts inside a minute.
  const h = harness({ status: () => ({ state: 'failed', reason: 'gateway down' }) });
  try {
    h.store.update((db) => {
      db.whatsappLog = [entry({ at: new Date(NOW - 5 * 60_000).toISOString(), settledAt: undefined })];
    });
    const first = await h.a.tick();
    assert.equal(first.queued, false, 'the verdict has only just arrived');
    assert.match(first.reason ?? '', /Waiting before retrying/);
    assert.equal(h.log()[0].outcome, 'failed', 'but the verdict IS recorded');

    h.advance(WA_RETRY_MS + 1000);
    const second = await h.a.tick();
    assert.equal(second.queued, true, 'and then it goes again');
    const log = h.log();
    assert.equal(log[0].outcome, 'failed', 'the old entry keeps its verdict');
    assert.equal(log[1].outcome, 'queued', 'and the retry is its own entry');
  } finally {
    h.cleanup();
  }
});
