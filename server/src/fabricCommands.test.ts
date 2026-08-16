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

test('a whole change can be made through the endpoint, and it lands in the store', async () => {
  const s = store();
  const c = new FabricCommands({ store: s });
  const say = (text: string) => call(c, good, { command: 'iqamah-change', text, requestId: 'r', locale: 'en' });

  await say('');
  await say('2026-09-01');
  await say('1');
  await say('5:45');
  const done = await say('save');

  assert.equal(done.body.ok, true);
  assert.match(String(done.body.text), /Saved\./);
  assert.deepEqual(s.db.timetables[0].iqamahSchedule, [{ from: '2026-09-01', fajr: '05:45' }]);
});

test('nothing is written until save', async () => {
  const s = store();
  const c = new FabricCommands({ store: s });
  const say = (text: string) => call(c, good, { command: 'iqamah-change', text });
  await say('');
  await say('2026-09-01');
  await say('1');
  await say('5:45');
  assert.equal(s.db.timetables[0].iqamahSchedule, undefined, 'not before save');
  await say('exit');
  assert.equal(s.db.timetables[0].iqamahSchedule, undefined, 'and not after exit');
});

test('a refusal is ok:false with a sentence, not an HTTP error', async () => {
  // The platform shows the app's own words for a refusal; an HTTP 4xx would become a generic
  // "that did not work" instead.
  const c = new FabricCommands({ store: store() });
  await call(c, good, { command: 'iqamah-change', text: '' });
  const r = await call(c, good, { command: 'iqamah-change', text: '1/9/2026' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.match(String(r.body.error), /two different days/);
});
