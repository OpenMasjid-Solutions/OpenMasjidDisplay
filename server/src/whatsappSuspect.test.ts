// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * What to do when the platform withdraws its own "sent".
 *
 * A masjid's WhatsApp session expired the way WhatsApp Desktop signs itself out, and nothing
 * noticed: the gateway kept accepting messages and OpenMasjidOS kept recording them `sent`, for over
 * a day, while none of them arrived. It detects that within about ten minutes now, but the messages
 * already inside the window keep their `sent` record — and the platform cannot re-send them, because
 * it deletes a message's contents the moment it hands it over. This app still has the timetable, so
 * it is the only thing that can.
 *
 * Two things are easy to get wrong here and both are worse than doing nothing:
 *
 *  - **Re-announcing a change that has already taken effect.** "From Friday, Asr will be at 5:30" is
 *    a correction before Friday and a confusion after it.
 *  - **Re-announcing in a burst.** Whatever goes out uses the same single paced queue on a number
 *    that has just been re-linked, which is when it is watched hardest.
 *
 * So the decision here is narrow on purpose: it only changes whether the EXISTING dedupe still
 * counts a message as handled. Nothing is sent from this path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { markSuspectEntries, WA_SUSPECT_MS, decideAnnounce } from './whatsappAnnounce';
import type { WhatsAppLogEntry } from './types';

const DAY = 24 * 60 * 60_000;
/** A fixed "now" so "already in effect" is decided by the test, not by the calendar. */
const NOW = Date.parse('2026-08-20T12:00:00.000Z');

function entry(over: Partial<WhatsAppLogEntry> = {}): WhatsAppLogEntry {
  return {
    at: new Date(NOW - 2 * DAY).toISOString(),
    event: 'iqamah-change',
    recipient: 'group@g.us',
    effectiveFrom: '2026-08-28',
    outcome: 'sent',
    id: 'm1',
    settledAt: new Date(NOW - 2 * DAY + 60_000).toISOString(),
    ...over,
  };
}

/** A window covering the moment the entry above was queued. */
const covering = [{ from: NOW - 2 * DAY - 60_000, to: NOW - 2 * DAY + 30_000 }];

// ── what a window covers ────────────────────────────────────────────────────

test('a message is covered when the hand-off COULD have been inside the window', () => {
  // We do not know when the platform handed it to the gateway. We know it was somewhere between our
  // queueing it and our learning it was sent, because the verdict is polled once a minute, five at a
  // time. So the test is an interval overlap, not a point.
  const e = entry();
  assert.deepEqual(markSuspectEntries([e], covering, NOW), { pending: 1, stale: 0 });
  assert.equal(e.suspect, 'pending');
});

test('a window that opens after we already knew the answer covers nothing', () => {
  const e = entry();
  const after = [{ from: NOW - DAY, to: NOW }];
  assert.deepEqual(markSuspectEntries([e], after, NOW), { pending: 0, stale: 0 });
  assert.equal(e.suspect, undefined);
});

test('a message queued just before the link died is covered', () => {
  // The point test that would have missed it: `at` is BEFORE the window opens, but the hand-off
  // plainly was not — and this is the likeliest message of all to have been lost.
  const e = entry({
    at: new Date(NOW - 2 * DAY - 5 * 60_000).toISOString(),
    settledAt: new Date(NOW - 2 * DAY).toISOString(),
  });
  assert.equal(markSuspectEntries([e], covering, NOW).pending, 1);
});

test('only a sent message is ever marked', () => {
  // A queued one is still going to get a real verdict; a failed one is already being retried by the
  // ordinary path. Marking either would be inventing a second opinion about it.
  for (const outcome of ['queued', 'failed', 'expired'] as const) {
    const e = entry({ outcome });
    assert.deepEqual(markSuspectEntries([e], covering, NOW), { pending: 0, stale: 0 }, outcome);
    assert.equal(e.suspect, undefined);
  }
});

test('a message already judged is not judged twice', () => {
  for (const suspect of ['pending', 'resent', 'stale'] as const) {
    const e = entry({ suspect });
    assert.deepEqual(markSuspectEntries([e], covering, NOW), { pending: 0, stale: 0 }, suspect);
    assert.equal(e.suspect, suspect, 'and its verdict is left as it was');
  }
});

// ── the domain call the platform said it could not make for us ──────────────

test('a change still ahead is re-announced; one already in effect is not', () => {
  const ahead = entry({ effectiveFrom: '2026-08-28' });
  const today = entry({ effectiveFrom: '2026-08-20' });
  const past = entry({ effectiveFrom: '2026-08-14' });
  assert.deepEqual(markSuspectEntries([ahead, today, past], covering, NOW), { pending: 2, stale: 1 });
  assert.equal(ahead.suspect, 'pending');
  // A change taking effect TODAY still has a job to do — somebody turns up at the wrong time
  // otherwise — which is the same reason the announce window itself uses minDays 0.
  assert.equal(today.suspect, 'pending', 'a change taking effect today is still worth announcing');
  assert.equal(past.suspect, 'stale', 'after the change, the wording of the notice is simply wrong');
});

// ── what that does, and what it deliberately does not do ───────────────────

test('a pending message stops counting as handled, so the ordinary path re-announces it', () => {
  const db = {
    settings: { whatsapp: { iqamahChange: true, groupId: 'group@g.us', daysBefore: 30 } },
    whatsappLog: [entry({ suspect: 'pending' })],
  } as never;
  // Not asserting a post here — decideAnnounce needs a whole timetable for that, and this file is
  // about the judgement rather than the plumbing. What matters is that the dedupe's answer changed.
  const src = fs.readFileSync(path.resolve(__dirname, 'whatsappAnnounce.ts'), 'utf8');
  assert.match(
    src,
    /e\.outcome === 'sent' && e\.suspect !== 'pending'/,
    'a sent message the platform has disowned must not read as handled',
  );
  assert.equal(typeof decideAnnounce, 'function');
  void db;
});

test('nothing is sent from the suspect path', () => {
  // The volume answer. A re-send rejoins the paced path — one message per change, the same backoff,
  // the same attempt budget — so a masjid with several suspect notices cannot produce a burst on a
  // number that was re-linked five minutes ago.
  const src = fs.readFileSync(path.resolve(__dirname, 'whatsappAnnounce.ts'), 'utf8');
  const start = src.indexOf('private async checkSuspect()');
  assert.ok(start > 0, 'checkSuspect must exist');
  const body = src.slice(start, src.indexOf('\n  }', start));
  assert.ok(!/this\.send\(|this\.post\(/.test(body), 'the suspect check must not send anything itself');
});

test('a suspect message cannot re-open itself for ever', () => {
  // Without this it stays 'pending', keeps reading as not-handled, and re-announces on every pass.
  // The only place that can honestly close it is where the replacement is written.
  const src = fs.readFileSync(path.resolve(__dirname, 'whatsappAnnounce.ts'), 'utf8');
  const rec = src.slice(src.indexOf('private record('), src.indexOf('private async checkSuspect()'));
  assert.match(rec, /suspect = 'resent'/, 'writing a new entry has to close the suspect one');
  assert.match(rec, /e\.effectiveFrom === entry\.effectiveFrom/, 'and only for the same change');
  assert.match(rec, /e\.recipient === entry\.recipient/, 'and the same group');
});

// ── asking ─────────────────────────────────────────────────────────────────

test('"could not ask" is not "nothing is wrong"', () => {
  // The same distinction the message-status lookup makes, and the platform asked for it explicitly:
  // an older platform, a timeout or a 404 must not read as an all-clear. The client returns null for
  // those and an array only when the platform actually answered.
  const src = fs.readFileSync(path.resolve(__dirname, 'fabric.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export async function whatsappSuspectWindows'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /if \(!res\.ok\) return null;/, 'a non-OK response is unknown');
  assert.match(fn.slice(0, fn.indexOf('\n}')), /redirect: 'error'/, 'and the SSRF guard is not optional');
});

test('a nonsense window matches nothing rather than everything', () => {
  // A window with from > to, or a missing end, compared naively could match the whole log — and the
  // consequence of that is announcing a masjid's entire history to its group.
  const e = entry();
  for (const w of [
    { from: NOW, to: NOW - DAY },
    { from: NaN, to: NOW },
    { from: NOW - DAY, to: NaN },
  ]) {
    assert.deepEqual(markSuspectEntries([entry()], [w], NOW), { pending: 0, stale: 0 }, JSON.stringify(w));
  }
  assert.equal(e.suspect, undefined);
});

test('the poll is hourly — often enough for a failure that ran for a day', () => {
  assert.ok(WA_SUSPECT_MS >= 15 * 60_000, 'more often than this buys nothing; the window takes ~10 minutes to appear');
  assert.ok(WA_SUSPECT_MS <= 6 * 60 * 60_000, 'the failure this exists for went unnoticed for over a day');
});
