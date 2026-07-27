// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The controller's side of asset sync: hashing uploads and turning them into asset refs.
 *
 * Uses the real uploads directory (config.dataDir, which is `server/data` under test and
 * gitignored) with uniquely-named files that are removed afterwards — the hash cache is
 * keyed on mtime, so a fake filesystem would not exercise the thing most likely to break.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApi } from './api';
import { hashPassword } from './auth';
import { config } from './config';
import { uploadSha256, uploadBySha256 } from './render/background';
import { assetsForTimetable, nodeAssetPath } from './nodeAssets';
import { normTimetable } from './validate';
import type { Timetable } from './types';

const uploads = () => path.join(config.dataDir, 'uploads');

/** Write a throwaway upload; returns its filename and the sha of its bytes. */
function putUpload(tag: string, bytes: Buffer): { name: string; sha: string } {
  fs.mkdirSync(uploads(), { recursive: true });
  const name = `tt_test${tag}.${crypto.randomBytes(4).toString('hex')}.png`;
  fs.writeFileSync(path.join(uploads(), name), bytes);
  return { name, sha: crypto.createHash('sha256').update(bytes).digest('hex') };
}
const rmUpload = (name: string) => {
  try {
    fs.rmSync(path.join(uploads(), name), { force: true });
  } catch {
    /* ignore */
  }
};

const tt = (over: Partial<Timetable>): Timetable => ({ ...normTimetable({ name: 'T' }), ...over });

test('an upload hashes to its content, and is findable by that hash', () => {
  const bytes = Buffer.from('89504e470d0a1a0a-some-image-bytes');
  const { name, sha } = putUpload('a', bytes);
  try {
    assert.equal(uploadSha256(name), sha);
    const found = uploadBySha256(sha);
    assert.ok(found, 'the hash must resolve back to a file');
    assert.equal(found.name, name);
    assert.deepEqual(fs.readFileSync(found.path), bytes);
  } finally {
    rmUpload(name);
  }
});

test('the hash follows the bytes when a file is replaced in place', () => {
  // The cache is keyed on mtime; if that invalidation is wrong, a masjid replacing its logo
  // would leave every node showing the old one forever, with the hash claiming it is current.
  const first = putUpload('b', Buffer.from('first bytes'));
  try {
    assert.equal(uploadSha256(first.name), first.sha);
    const next = Buffer.from('completely different bytes');
    const nextSha = crypto.createHash('sha256').update(next).digest('hex');
    // Bump mtime explicitly: a same-second rewrite can otherwise land on the same value.
    fs.writeFileSync(path.join(uploads(), first.name), next);
    fs.utimesSync(path.join(uploads(), first.name), new Date(), new Date(Date.now() + 2000));
    assert.equal(uploadSha256(first.name), nextSha, 'a replaced upload must hash to the NEW bytes');
  } finally {
    rmUpload(first.name);
  }
});

test('a missing or unsafe filename hashes to null rather than throwing', () => {
  assert.equal(uploadSha256('does-not-exist.png'), null);
  assert.equal(uploadSha256(''), null);
  // Traversal is refused by safeName upstream of the read.
  assert.equal(uploadSha256('../../../etc/passwd'), null);
  assert.equal(uploadBySha256('not-a-hash'), null);
  assert.equal(uploadBySha256('0'.repeat(64)), null);
});

test('a timetable with no uploads needs no assets', () => {
  assert.deepEqual(assetsForTimetable(tt({ backgroundImage: '', logoImage: '' })), []);
});

test('background and logo become content-addressed refs', () => {
  const bg = putUpload('bg', Buffer.from('the background photo'));
  const logo = putUpload('logo', Buffer.from('the masjid logo'));
  try {
    const refs = assetsForTimetable(tt({ backgroundImage: bg.name, logoImage: logo.name }));
    assert.equal(refs.length, 2);
    const byId = new Map(refs.map((r) => [r.id, r]));
    // `id` is the RENDER SLOT, not the filename — the node keys its options off the slot, so
    // neither end depends on what the admin happened to call the file.
    assert.equal(byId.get('bg')?.sha256, bg.sha);
    assert.equal(byId.get('logo')?.sha256, logo.sha);
    assert.equal(byId.get('bg')?.url, nodeAssetPath(bg.sha));
    // A PATH, not an absolute URL: the node resolves it against the controller origin it
    // already dials, so this works on a LAN, behind a tunnel, and from the cloud alike.
    assert.ok(byId.get('bg')!.url.startsWith('/'), 'must be a path');
  } finally {
    rmUpload(bg.name);
    rmUpload(logo.name);
  }
});

test('an upload that has gone missing is skipped, not sent as a broken ref', () => {
  // The controller does the same thing in this situation: fall back to the themed scene.
  const refs = assetsForTimetable(tt({ backgroundImage: 'gone-forever.png', logoImage: '' }));
  assert.deepEqual(refs, []);
});

test('the asset route authenticates by NODE TOKEN, without an admin session', async () => {
  // REGRESSION: this route was first placed after the "everything else requires auth" gate,
  // so every request 401'd on the missing admin cookie and no node could ever fetch its
  // masjid's logo. Unit tests could not see it — only a real request through createApi can.
  const bytes = Buffer.from('89504e470d0a1a0a-route-test');
  const { name, sha } = putUpload('route', bytes);
  const token = 'a'.repeat(64);
  const cred = hashPassword(token);
  const db = {
    version: 1,
    admin: { hash: 'x', salt: 'y', createdAt: '' },
    settings: { defaultQuality: '1080p', scheduleTimezone: '', volunteerEnabled: false, volunteerRemote: true, piNodes: true },
    timetables: [tt({ backgroundImage: name })],
    sources: [],
    tvs: [],
    schedules: [],
    nodes: [
      {
        id: 'node_1', serial: 'feedface', name: 'Hall', tokenHash: cred.hash, tokenSalt: cred.salt,
        fw: '0.62.0', model: 'Pi', caps: { codecs: ['h264'], maxHeight: 1080, maxFps: 30 },
        ip: '', lastSeen: 0, createdAt: '',
      },
    ],
  };
  const store = { db, secret: crypto.randomBytes(32), update: (fn: (d: unknown) => void) => fn(db) };
  const handler = createApi({
    store: store as never,
    orchestrator: { getStatuses: () => [] } as never,
    volunteer: async () => {},
  });
  const server = http.createServer((q, r) => void handler(q, r));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/api/node/assets`;

  try {
    // With the node's own credential — and NO cookie — the bytes come back.
    const ok = await fetch(`${base}/${sha}?serial=feedface`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(ok.status, 200, 'a node must be able to fetch without an admin session');
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), bytes);

    // Every way of getting it wrong is a 401, not a leak.
    assert.equal((await fetch(`${base}/${sha}?serial=feedface`)).status, 401);
    assert.equal(
      (await fetch(`${base}/${sha}?serial=feedface`, { headers: { authorization: `Bearer ${'b'.repeat(64)}` } })).status,
      401,
    );
    assert.equal((await fetch(`${base}/${sha}`, { headers: { authorization: `Bearer ${token}` } })).status, 401, 'the serial selects which hash to check');
    // Authenticated but unknown content is a 404.
    assert.equal(
      (await fetch(`${base}/${'e'.repeat(64)}?serial=feedface`, { headers: { authorization: `Bearer ${token}` } })).status,
      404,
    );
    // And the admin surface is still shut to an anonymous caller.
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 401);

    // With the feature off the route does not exist at all.
    db.settings.piNodes = false;
    assert.equal(
      (await fetch(`${base}/${sha}?serial=feedface`, { headers: { authorization: `Bearer ${token}` } })).status,
      404,
    );
  } finally {
    server.close();
    rmUpload(name);
  }
});

test('deleting a node screen also releases its node, rather than orphaning it', async () => {
  // REGRESSION: DELETE /api/tvs/:id used to filter db.tvs only. The PiNode survived with a
  // dangling screenId — still authenticating, never pushed content again (the orchestrator
  // only iterates node SCREENS), so the TV froze on its last frame forever. The panel renders
  // nodes through their screen, so the orphan was invisible AND un-removable, it kept
  // consuming a slot against the collection cap, and the same serial could not be re-adopted.
  const cred = hashPassword('a'.repeat(64));
  const screen = { id: 'tv_1', name: 'Hall', kind: 'node', nodeId: 'node_1', defaultContent: { kind: 'off' }, createdAt: '' };
  const db = {
    version: 1,
    admin: { hash: 'x', salt: 'y', createdAt: '' },
    settings: { defaultQuality: '1080p', scheduleTimezone: '', volunteerEnabled: false, volunteerRemote: true, piNodes: true },
    timetables: [tt({})],
    sources: [],
    tvs: [screen],
    schedules: [],
    nodes: [{ id: 'node_1', serial: 'feedface', name: 'Hall', tokenHash: cred.hash, tokenSalt: cred.salt, fw: '1', model: '', caps: { codecs: ['h264'], maxHeight: 1080, maxFps: 30 }, ip: '', lastSeen: 0, screenId: 'tv_1', createdAt: '' }],
  };
  const store = { db, secret: crypto.randomBytes(32), update: (fn: (d: unknown) => void) => fn(db) };
  let resetCalled = '';
  const handler = createApi({
    store: store as never,
    orchestrator: { getStatuses: () => [] } as never,
    volunteer: async () => {},
    nodeHub: { factoryReset: (id: string) => { resetCalled = id; return true; } } as never,
  });
  const server = http.createServer((q, r) => void handler(q, r));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // Drive the REAL route, which means holding a real session. First-run setup mints one,
    // so start from no admin and let /api/setup issue the cookie.
    db.admin = null as never;
    const setup = await fetch(`${base}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-pass-1234' }),
    });
    assert.equal(setup.status, 200, 'setup should mint a session');
    const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0];
    assert.ok(cookie, 'expected a session cookie');

    const del = await fetch(`${base}/api/tvs/tv_1`, { method: 'DELETE', headers: { cookie } });
    assert.equal(del.status, 200);

    assert.deepEqual(db.tvs, [], 'the screen is gone');
    assert.deepEqual(db.nodes, [], 'and its node record went with it, rather than being orphaned');
    assert.equal(resetCalled, 'node_1', 'and the Pi was told to wipe itself');
  } finally {
    server.close();
  }
});

test('deleting a plain decoder screen leaves node records alone', async () => {
  const cred = hashPassword('a'.repeat(64));
  const db = {
    version: 1,
    admin: null,
    settings: { defaultQuality: '1080p', scheduleTimezone: '', volunteerEnabled: false, volunteerRemote: true, piNodes: true },
    timetables: [tt({})],
    sources: [],
    tvs: [{ id: 'tv_plain', name: 'Lobby', defaultContent: { kind: 'off' }, createdAt: '' }],
    schedules: [],
    nodes: [{ id: 'node_1', serial: 'feedface', name: 'Hall', tokenHash: cred.hash, tokenSalt: cred.salt, fw: '1', model: '', caps: { codecs: ['h264'], maxHeight: 1080, maxFps: 30 }, ip: '', lastSeen: 0, createdAt: '' }],
  };
  const store = { db, secret: crypto.randomBytes(32), update: (fn: (d: unknown) => void) => fn(db) };
  let reset = false;
  const handler = createApi({
    store: store as never,
    orchestrator: { getStatuses: () => [] } as never,
    volunteer: async () => {},
    nodeHub: { factoryReset: () => { reset = true; return true; } } as never,
  });
  const server = http.createServer((q, r) => void handler(q, r));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const setup = await fetch(`${base}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-pass-1234' }),
    });
    const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0];
    assert.equal((await fetch(`${base}/api/tvs/tv_plain`, { method: 'DELETE', headers: { cookie } })).status, 200);
    assert.deepEqual(db.tvs, []);
    assert.equal(db.nodes.length, 1, 'an unrelated node must not be collateral damage');
    assert.equal(reset, false, 'and nothing should be told to factory-reset');
  } finally {
    server.close();
  }
});

test('two slots sharing one file produce the same hash (one transfer on the node)', () => {
  const shared = putUpload('shared', Buffer.from('one image, two jobs'));
  try {
    const refs = assetsForTimetable(tt({ backgroundImage: shared.name, logoImage: shared.name }));
    assert.equal(refs.length, 2);
    assert.equal(refs[0].sha256, refs[1].sha256);
    assert.deepEqual(
      refs.map((r) => r.id),
      ['bg', 'logo'],
    );
  } finally {
    rmUpload(shared.name);
  }
});
