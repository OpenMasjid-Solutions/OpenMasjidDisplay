// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The inbound command endpoint's envelope.
 *
 * This is the ONLY route where something outside the app can make it change prayer times
 * without a session cookie, so the tests here are about who gets in, not about what the
 * command does (that is iqamahWizard.test.ts).
 *
 * Both headers are required. The secret alone is not enough and neither is the caller
 * header: an app id can never contain a colon, so `omos:platform` identifies the platform by
 * construction — but only if we actually check it.
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
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-cmd-'));

// config reads env at import time, so both are required AFTER the env is set.
const { Store } = require('./store') as typeof import('./store');
const { FabricCommands } = require('./fabricCommands') as typeof import('./fabricCommands');
const { normTimetable } = require('./validate') as typeof import('./validate');

function store() {
  const s = new Store();
  s.update((db) => {
    db.timetables = [
      normTimetable({
        name: 'Main hall',
        masjidName: 'Madani Academy Masjid',
        latitude: 40.2415,
        longitude: -75.2838,
        timezone: 'America/New_York',
        timeFormat: '12h',
      }),
    ];
  });
  return s;
}

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

/** Minimal req/res doubles — enough for a handler that only reads headers and writes JSON. */
function call(
  cmds: InstanceType<typeof FabricCommands>,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Captured> {
  const req = { headers, method: 'POST', url: '/fabric/commands/run' } as unknown as IncomingMessage;
  let status = 0;
  let chunk = '';
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(b?: string) {
      chunk = b ?? '';
      return this;
    },
    headersSent: false,
  } as unknown as ServerResponse;
  return cmds.handle(req, res, body).then(() => ({ status, body: JSON.parse(chunk || '{}') }));
}

const good = { 'x-openmasjid-app-secret': SECRET, 'x-openmasjid-caller-app': 'omos:platform' };

test('the platform, with both headers, gets through', async () => {
  const c = new FabricCommands({ store: store() });
  const r = await call(c, good, { command: 'iqamah-change', text: '', requestId: 'r1', locale: 'en' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(String(r.body.text), /What date does it start\?/);
});

test('a wrong secret is refused', async () => {
  const c = new FabricCommands({ store: store() });
  const r = await call(c, { ...good, 'x-openmasjid-app-secret': 'nope' }, { command: 'iqamah-change' });
  assert.equal(r.status, 403);
  assert.equal(r.body.ok, false);
});

test('a missing secret is refused', async () => {
  const c = new FabricCommands({ store: store() });
  const r = await call(c, { 'x-openmasjid-caller-app': 'omos:platform' }, { command: 'iqamah-change' });
  assert.equal(r.status, 403);
});

test('the RIGHT secret with the wrong caller is still refused', async () => {
  // Another installed app knows its own secret, not ours — but if the caller header were
  // unchecked, anything that ever learned this secret could drive the wizard. Both, or nothing.
  const c = new FabricCommands({ store: store() });
  for (const caller of ['donations', 'omos', 'omos:platform-x', '', 'OMOS:PLATFORM']) {
    const r = await call(c, { ...good, 'x-openmasjid-caller-app': caller }, { command: 'iqamah-change' });
    assert.equal(r.status, 403, `caller "${caller}" must not get in`);
  }
});

test('a caller header that is absent entirely is refused', async () => {
  const c = new FabricCommands({ store: store() });
  const r = await call(c, { 'x-openmasjid-app-secret': SECRET }, { command: 'iqamah-change' });
  assert.equal(r.status, 403);
});

test('an unknown command is 404 unknown_command, which the platform words for us', async () => {
  const c = new FabricCommands({ store: store() });
  const r = await call(c, good, { command: 'drop-tables' });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'unknown_command');
});

/** Drive a whole exchange the way the platform does: carry the token it gave us. */
function exchange(c: InstanceType<typeof FabricCommands>) {
  let token: string | undefined;
  return async (text: string) => {
    const r = await call(c, good, { command: 'iqamah-change', text, followUpToken: token, requestId: 'r', locale: 'en' });
    token = (r.body.followUp as { token?: string })?.token;
    return r;
  };
}

test('a whole change can be made through the endpoint, and it lands in the store', async () => {
  const s = store();
  const say = exchange(new FabricCommands({ store: s }));

  await say('');
  await say('2026-09-01');
  await say('1');
  await say('5:45 am');
  const done = await say('save');

  assert.equal(done.body.ok, true);
  assert.match(String(done.body.text), /Saved\./);
  assert.deepEqual(s.db.timetables[0].iqamahSchedule, [{ from: '2026-09-01', fajr: '05:45' }]);
});

test('nothing is written until save', async () => {
  const s = store();
  const say = exchange(new FabricCommands({ store: s }));
  await say('');
  await say('2026-09-01');
  await say('1');
  await say('5:45 am');
  assert.equal(s.db.timetables[0].iqamahSchedule, undefined, 'not before save');
  await say('exit');
  assert.equal(s.db.timetables[0].iqamahSchedule, undefined, 'and not after exit');
});

test('a terminal refusal is ok:false with a sentence, not an HTTP error', async () => {
  // The platform shows the app's own words for a refusal; an HTTP 4xx would become a generic
  // "that did not work" instead. This one is terminal — there is nothing to answer.
  const s = store();
  s.update((db) => {
    db.timetables[0].latitude = null;
    db.timetables[0].longitude = null;
  });
  const c = new FabricCommands({ store: s });
  const r = await call(c, good, { command: 'iqamah-change', text: '' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.match(String(r.body.error), /masjid location/);
  assert.equal(r.body.followUp, undefined, 'and it does not invite an answer');
});

// ── follow-up exchanges ──────────────────────────────────────────────────────

test('a followUp token is handed back while the wizard wants an answer', async () => {
  const c = new FabricCommands({ store: store() });
  const r = await call(c, good, { command: 'iqamah-change', text: '' });
  const token = (r.body.followUp as { token?: string })?.token;
  assert.ok(token, 'the sender should be able to just answer, not retype !display 1');
  assert.match(token!, /^[A-Za-z0-9._:-]{1,128}$/, "the platform validates before echoing, so an invalid token would be dropped");
});

test('the whole flow runs on plain answers once the token is held', async () => {
  const s = store();
  const c = new FabricCommands({ store: s });
  let token: string | undefined;
  const say = async (text: string) => {
    const r = await call(c, good, { command: 'iqamah-change', text, followUpToken: token });
    token = (r.body.followUp as { token?: string })?.token;
    return r;
  };
  await say('');
  await say('9/1/2026');
  await say('1');
  await say('5:45 am');
  const done = await say('save');

  assert.equal(done.body.ok, true);
  assert.equal(done.body.followUp, undefined, 'omitting followUp is how the exchange ends');
  assert.deepEqual(s.db.timetables[0].iqamahSchedule, [{ from: '2026-09-01', fajr: '05:45' }]);
});

test('the token stays stable across the exchange', async () => {
  const c = new FabricCommands({ store: store() });
  const first = await call(c, good, { command: 'iqamah-change', text: '' });
  const t1 = (first.body.followUp as { token: string }).token;
  const second = await call(c, good, { command: 'iqamah-change', text: '9/1/2026', followUpToken: t1 });
  assert.equal((second.body.followUp as { token: string }).token, t1);
});

test('two senders mid-flow do not collide — the token IS the sender', async () => {
  // The body carries no phone number, so before follow-ups there was one shared session and
  // two admins would overwrite each other's draft. The platform binds a token to one sender,
  // so keying on it keys on the person.
  const s = store();
  const c = new FabricCommands({ store: s });
  const start = async () => (await call(c, good, { command: 'iqamah-change', text: '' })).body;
  const a = (await start()).followUp as { token: string };
  const b = (await start()).followUp as { token: string };
  assert.notEqual(a.token, b.token);

  await call(c, good, { command: 'iqamah-change', text: '9/1/2026', followUpToken: a.token });
  await call(c, good, { command: 'iqamah-change', text: '10/1/2026', followUpToken: b.token });
  const aNext = await call(c, good, { command: 'iqamah-change', text: '1', followUpToken: a.token });
  // A's exchange still knows A's date.
  assert.match(String(aNext.body.text), /Fajr/);
  await call(c, good, { command: 'iqamah-change', text: '5:45 am', followUpToken: a.token });
  const aSave = await call(c, good, { command: 'iqamah-change', text: 'save', followUpToken: a.token });
  assert.match(String(aSave.body.text), /September 1, 2026/, "A's date, not B's");
});

test('a retry keeps the exchange open — an ok:false would end it', async () => {
  const c = new FabricCommands({ store: store() });
  const first = await call(c, good, { command: 'iqamah-change', text: '' });
  const token = (first.body.followUp as { token: string }).token;
  const r = await call(c, good, { command: 'iqamah-change', text: 'not a date', followUpToken: token });
  assert.equal(r.body.ok, true, 'a typo must not drop the admin out of the conversation');
  assert.ok((r.body.followUp as { token?: string })?.token, 'and it still wants an answer');
});

test('an unknown token starts a fresh exchange rather than answering into nothing', async () => {
  // The exchange it belonged to is gone — expired, or ended by the platform without telling
  // us. "save" must not resolve against someone else's draft; it starts over asking for a date.
  const s = store();
  const c = new FabricCommands({ store: s });
  const r = await call(c, good, { command: 'iqamah-change', text: 'save', followUpToken: 'iq.nope' });
  assert.equal(r.body.ok, true);
  assert.match(String(r.body.text), /date/i);
  assert.equal(s.db.timetables[0].iqamahSchedule, undefined, 'and nothing was written');
});

// ── LAN-only ─────────────────────────────────────────────────────────────────

test('a request carrying forwarding headers is refused, even with perfect credentials', async () => {
  // "Exact path only" is not enough on its own: the router derives the path with `new URL()`,
  // which NORMALISES dot segments, so `/display/../fabric/commands/run` collapses onto this
  // route. The platform builds its header set from scratch and never sends x-forwarded-*, so
  // their presence means the request came through an ingress — which this route never accepts.
  const c = new FabricCommands({ store: store() });
  for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded']) {
    const r = await call(c, { ...good, [h]: 'anything' }, { command: 'iqamah-change', text: '' });
    assert.equal(r.status, 403, `${h} must not get through`);
  }
});

test('the dot-segment path that motivates it really does normalise onto this route', () => {
  // Pinning the premise, not the fix: if this ever stops being true the header check is still
  // correct, but the comment explaining why it exists would be wrong.
  assert.equal(new URL('/display/../fabric/commands/run', 'http://localhost').pathname, '/fabric/commands/run');
});
