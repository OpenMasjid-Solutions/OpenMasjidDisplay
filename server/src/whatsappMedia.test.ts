// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Sending the Iqāmah-change POSTER, now that the platform can carry an image.
 *
 * The failure this file exists to prevent is a **silent downgrade**: rendering the poster,
 * failing to attach it, and posting the short caption on its own. That caption is written to
 * sit *under* an image — it names what moved and nothing else — so delivered alone it is an
 * announcement with no timetable in it, and it would look perfectly fine in the log.
 *
 * The other one is cheaper but just as real: rasterising a 1080×1350 poster on a Raspberry Pi
 * for a platform that was never going to accept it. The capability read costs nothing, so it
 * happens first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normTimetable, normSettings } from './validate';
import { normalizeIqamahSchedule } from './iqamahSchedule';
import type { DB, Settings, Timetable } from './types';
import type { WhatsAppAvailability, WhatsAppMedia } from './fabric';

const NOW = new Date('2026-08-15T15:00:00Z').getTime();
const GROUP = '120363012345678901@g.us';
/** Stands in for a rendered poster — the bytes never reach a decoder here. */
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const CAN_SEND: WhatsAppAvailability = { available: true, reason: 'ready', media: true, maxMediaBytes: 2_097_152, outcomes: true };
const NO_MEDIA: WhatsAppAvailability = { available: true, reason: 'ready', media: false, maxMediaBytes: 0, outcomes: false };

interface Sent {
  group: string;
  text: string;
  media?: WhatsAppMedia;
}

function timetable(): Timetable {
  const tt = normTimetable({
    masjidName: 'Madani Academy Masjid',
    latitude: 40.2415,
    longitude: -75.2838,
    method: 'ISNA',
    asrMadhab: 'Hanafi',
    timezone: 'America/New_York',
    timeFormat: '12h',
  });
  tt.iqamahSchedule = normalizeIqamahSchedule([{ from: '2026-08-17', asr: '17:15' }]);
  return tt;
}

function settings(): Settings {
  const empty: Settings = {
    defaultQuality: '1080p',
    scheduleTimezone: '',
    volunteerEnabled: false,
    volunteerRemote: true,
    whatsapp: { iqamahChange: false, groupId: '', groupLabel: '', timetableId: '', daysBefore: 1 },
  webScreensBeta: false,
  };
  return normSettings({ whatsapp: { iqamahChange: true, groupId: GROUP, daysBefore: 3 } }, empty);
}

/**
 * An announcer over a REAL Store in a temp dir, with the network and the renderer stubbed.
 * A real store matters: the dedupe reads the persisted log back, so an in-memory fake would
 * pass the "not posted twice" test while proving nothing about a restart.
 */
/**
 * Wait until the Store's debounced write has actually landed on disk.
 *
 * Polls the file rather than sleeping for a plausible duration: a sleep asserts nothing about
 * what it waited for, so on a slow runner the test fails for a reason unrelated to the code.
 */
async function persisted(dir: string, until: (db: Partial<DB>) => boolean, timeoutMs = 10_000): Promise<void> {
  const file = path.join(dir, 'db.json');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (until(JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DB>)) return;
    } catch {
      /* absent, or caught mid-write: both mean keep waiting */
    }
    if (Date.now() > deadline) throw new Error(`${file} never reached the expected state in ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function harness(opts: {
  cap?: WhatsAppAvailability;
  render?: () => Promise<Buffer>;
  send?: (s: Sent) => { queued: boolean; error?: string };
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-wa-'));
  const prevDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  // config + store read DATA_DIR at import time, so both are loaded after it is set.
  // Forget the cached modules so `config` re-reads DATA_DIR and this harness gets ITS OWN
  // directory.
  //
  // Without this the tests in this file are not isolated, and it is invisible: `config` reads
  // DATA_DIR once, at its first require, so only the FIRST harness got the directory it had just
  // made. Every later one made a fresh temp dir, set DATA_DIR to it, and then got a Store still
  // pointed at the first — which the first harness's cleanup had already deleted and Store's
  // constructor silently recreated.
  //
  // The cost was a test passing for the wrong reason. 'a queued post is not repeated' reopens the
  // store to prove the dedupe survives a restart; with a shared directory, the log entry it found
  // could be one an EARLIER test had written for the same change. Both the real write and a
  // leftover satisfy `already been sent`, so the assertion could not tell them apart.
  for (const m of ['./config', './store', './whatsappAnnounce']) {
    delete require.cache[require.resolve(m)];
  }
  const { Store } = require('./store') as typeof import('./store');
  const { WhatsAppAnnouncer, decideAnnounce } = require('./whatsappAnnounce') as typeof import('./whatsappAnnounce');
  const { config } = require('./config') as typeof import('./config');
  // Now that each harness really does get its own, this is `dir` — asserted rather than assumed,
  // because the whole point is that it used not to be.
  const storeDir = config.dataDir;

  const store = new Store();
  store.update((db) => {
    db.timetables = [timetable()];
    db.settings = settings();
    // Zero the log explicitly. `config` caches dataDir at import, so every harness in this
    // process shares one directory, and the store's 150 ms debounced write can land AFTER a
    // previous test deleted it — leaving a db.json whose log silently dedupes this test's
    // post. Resetting the field is deterministic; relying on the directory being gone is not.
    db.whatsappLog = [];
  });
  const sent: Sent[] = [];
  const a = new WhatsAppAnnouncer({
    store,
    now: () => NOW,
    capability: async () => opts.cap ?? CAN_SEND,
    render: opts.render ?? (async () => PNG),
    send: async (group, text, media) => {
      const rec: Sent = { group, text, media };
      sent.push(rec);
      return opts.send ? opts.send(rec) : { queued: true };
    },
  });
  return {
    a,
    store,
    sent,
    storeDir,
    decideAnnounce,
    cleanup: () => {
      if (prevDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prevDataDir;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the poster is attached when the platform can carry it', async () => {
  const h = harness();
  try {
    const r = await h.a.tick();
    assert.equal(r.queued, true);
    assert.equal(r.asImage, true);
    assert.equal(h.sent.length, 1);
    const m = h.sent[0].media;
    assert.ok(m, 'the image must be attached');
    assert.equal(m.mimeType, 'image/png');
    assert.equal(m.filename, 'iqamah-change-2026-08-17.png');
    assert.equal(Buffer.from(m.data, 'base64').toString('hex'), PNG.toString('hex'));
    assert.equal(h.store.db.whatsappLog?.[0].asImage, true);
  } finally {
    h.cleanup();
  }
});

test('the caption is short, names what moved, and fits the platform limit', async () => {
  const h = harness();
  try {
    await h.a.tick();
    const text = h.sent[0].text;
    assert.match(text, /^\*IQĀMAH TIME IS CHANGING\*/, 'the headline is the group notification preview');
    assert.match(text, /Asr .+ → 5:15 PM/, 'it must still say what changed if the image never loads');
    assert.ok(text.length <= 1024, `the platform refuses a caption over 1024, got ${text.length}`);
    assert.ok(!text.includes('Maghrib'), 'the poster carries the table; repeating it under the image is noise');
    assert.ok(
      !text.includes('Madani Academy Masjid'),
      'the poster names the masjid in the largest type on the image, right above this line',
    );
  } finally {
    h.cleanup();
  }
});

test('without media support the FULL notice goes as text — never the caption alone', async () => {
  const h = harness({ cap: NO_MEDIA });
  try {
    const r = await h.a.tick();
    assert.equal(r.asImage, false);
    assert.equal(h.sent[0].media, undefined);
    for (const p of ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']) {
      assert.match(h.sent[0].text, new RegExp(`${p} — `), `${p} must be listed`);
    }
    assert.equal(h.store.db.whatsappLog?.[0].asImage, undefined);
  } finally {
    h.cleanup();
  }
});

test('nothing is rendered when the platform cannot take an image', async () => {
  let rendered = 0;
  const h = harness({
    cap: NO_MEDIA,
    render: async () => {
      rendered++;
      return PNG;
    },
  });
  try {
    await h.a.tick();
    assert.equal(rendered, 0, 'the capability must be read BEFORE the render');
  } finally {
    h.cleanup();
  }
});

test('a failed render falls back to the full text rather than sending nothing', async () => {
  const h = harness({
    render: async () => {
      throw new Error('resvg exploded');
    },
  });
  try {
    const r = await h.a.tick();
    assert.equal(r.queued, true);
    assert.equal(r.asImage, false);
    assert.equal(h.sent[0].media, undefined);
    assert.match(h.sent[0].text, /Maghrib — /, 'the fallback must be the WHOLE notice');
  } finally {
    h.cleanup();
  }
});

test('a poster over the cap falls back to text instead of being refused', async () => {
  const h = harness({ cap: { ...CAN_SEND, maxMediaBytes: 32 }, render: async () => Buffer.alloc(64) });
  try {
    const r = await h.a.tick();
    assert.equal(r.asImage, false);
    assert.equal(h.sent[0].media, undefined);
    assert.match(h.sent[0].text, /Maghrib — /);
  } finally {
    h.cleanup();
  }
});

test('the size cap is the platform’s, not a number baked in here', async () => {
  // Identical bytes, two different platform answers — only the tighter one refuses them.
  const png = Buffer.alloc(1000);
  const roomy = harness({ cap: { ...CAN_SEND, maxMediaBytes: 2000 }, render: async () => png });
  try {
    assert.equal((await roomy.a.tick()).asImage, true);
  } finally {
    roomy.cleanup();
  }
  const tight = harness({ cap: { ...CAN_SEND, maxMediaBytes: 500 }, render: async () => png });
  try {
    assert.equal((await tight.a.tick()).asImage, false);
  } finally {
    tight.cleanup();
  }
});

test('a refused post is logged as failed, and the change stays outstanding', async () => {
  const h = harness({ send: () => ({ queued: false, error: 'That group has not been approved.' }) });
  try {
    const r = await h.a.tick();
    assert.equal(r.queued, false);
    const entry = h.store.db.whatsappLog?.[0];
    assert.equal(entry?.outcome, 'failed');
    assert.match(entry?.error ?? '', /not been approved/);
    assert.equal(h.decideAnnounce(h.store.db, NOW).act, 'skip', 'backed off');
    assert.equal(h.decideAnnounce(h.store.db, NOW + 31 * 60_000).act, 'post', 'retried after the backoff');
  } finally {
    h.cleanup();
  }
});

test('a queued post is not repeated — on the next tick, or after a restart', async () => {
  const h = harness();
  try {
    assert.equal((await h.a.tick()).queued, true);
    await h.a.tick();
    await h.a.tick();
    assert.equal(h.sent.length, 1, 'exactly one post per change');

    // The dedupe lives in the PERSISTED log, so a store reopened over the same dir knows too.
    // The debounced write has to land before the reopen — without that the reopened store reads
    // a db with no settings either, and the assertion would pass on "no group chosen" while
    // proving nothing about the dedupe. Hence checking the REASON below, not just the verdict.
    //
    // Waits FOR THE FILE, not for a duration. This was `setTimeout(r, 400)` — a bet that a 150 ms
    // debounce completes within 400 ms, which on a loaded CI runner it does not. It failed
    // exactly once, on a docs-only commit, and passed everywhere else; a sleep that is usually
    // long enough is a test that fails for reasons unrelated to the code.
    await persisted(h.storeDir, (db) => (db.whatsappLog?.length ?? 0) > 0);
    const { Store } = require('./store') as typeof import('./store');
    const after = h.decideAnnounce(new Store().db, NOW);
    assert.equal(after.act, 'skip');
    assert.match(after.act === 'skip' ? after.why : '', /already been sent/);
  } finally {
    h.cleanup();
  }
});

test('the log records the change date and the format, never the message', async () => {
  const h = harness();
  try {
    await h.a.tick();
    const entry = h.store.db.whatsappLog?.[0];
    assert.deepEqual(Object.keys(entry ?? {}).sort(), ['asImage', 'at', 'effectiveFrom', 'event', 'outcome', 'recipient']);
    assert.equal(entry?.effectiveFrom, '2026-08-17');
    assert.equal(entry?.recipient, GROUP);
    // Nothing in the entry may contain a rendered time or a caption fragment.
    assert.ok(!JSON.stringify(entry).includes('IQĀMAH'));
    assert.ok(!JSON.stringify(entry).includes('5:15'));
  } finally {
    h.cleanup();
  }
});
