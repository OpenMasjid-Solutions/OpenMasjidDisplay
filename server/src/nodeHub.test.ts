// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * M0 acceptance: a MOCK NODE — a script speaking nothing but the published protocol —
 * gets adopted and driven by the real controller code.
 *
 * Deliberately end-to-end over real sockets: a real HTTP server for the node's local
 * adoption API, the real `adoptNode` client (including its address guard), real scrypt
 * token hashing/verification, a real `ws` upgrade through the real `routeUpgrades`, and
 * real protocol frames. The only stand-in is the Store, so no temp data volume or
 * MediaMTX is needed.
 *
 * If this file passes, the pairing and control path works; what it cannot cover is the
 * Pi hardware itself (decode, HDMI, boot) — that is M1's on-device acceptance.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { NodeHub } from './nodeHub';
import { routeUpgrades, type UpgradeTarget } from './ws';
import { adoptAtOrigin } from './nodeAdopt';
import { encodeFrame, parseControllerFrame, HEARTBEAT_MS, OFFLINE_AFTER_MS } from '../../packages/protocol/src/index';
import type { DB, PiNode } from './types';
import type { Store } from './store';

const SERIAL = '10000000abcd1a2b';
const CAPS = { codecs: ['h264'], maxHeight: 1080, maxFps: 30 };

/** A minimal Store stand-in with the surface NodeHub actually uses. */
function fakeStore(nodes: PiNode[] = [], piNodes = true): Store {
  const db = {
    version: 1,
    admin: null,
    settings: { defaultQuality: '1080p', scheduleTimezone: '', volunteerEnabled: false, volunteerRemote: true, piNodes },
    timetables: [],
    sources: [],
    tvs: [],
    schedules: [],
    nodes,
  } as unknown as DB;
  return { db, update: (fn: (d: DB) => void) => fn(db) } as unknown as Store;
}

/**
 * The mock node's local API: `GET /api/status` and one-shot `POST /api/adopt`, exactly as
 * PI_NODE_SPEC.md §9 describes. Returns the token it was handed, which is how the real
 * agent learns it — the controller never reveals it again.
 */
async function startMockNode(opts: { alreadyAdopted?: boolean } = {}) {
  const received: { token?: string; wsUrl?: string; controllerName?: string } = {};
  let adopted = !!opts.alreadyAdopted;
  const server = http.createServer((req, res) => {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/status' && req.method === 'GET') {
      return reply(200, { serial: SERIAL, model: 'Raspberry Pi Zero 2 W', fw: '0.62.0', caps: CAPS, adopted });
    }
    if (req.url === '/api/adopt' && req.method === 'POST') {
      if (adopted) return reply(409, { error: 'already adopted' });
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { nodeToken: string; wsUrl: string; controllerName: string };
        received.token = parsed.nodeToken;
        received.wsUrl = parsed.wsUrl;
        received.controllerName = parsed.controllerName;
        adopted = true;
        reply(200, { serial: SERIAL, model: 'Raspberry Pi Zero 2 W', fw: '0.62.0', caps: CAPS });
      });
      return;
    }
    reply(404, { error: 'not found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return { server, port, address: `127.0.0.1`, received, close: () => server.close() };
}

/** Mount a NodeHub on a real HTTP server and return a connect helper. */
async function startController(store: Store, extra: UpgradeTarget[] = []) {
  const events: string[] = [];
  const hub = new NodeHub(store, {
    onUnsupportedCodec: (_n, s, c) => events.push(`codec:${s}:${c}`),
    onNotify: (p) => events.push(`notify:${p.title ?? ''}`),
    onChanged: () => events.push('changed'),
  });
  const server = http.createServer((_req, res) => res.end('ok'));
  routeUpgrades(server, [...extra, hub]);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    hub,
    events,
    port,
    close: () => server.close(),
    connect(token: string, serial = SERIAL, path = '/ws/node') {
      return new WebSocket(`ws://127.0.0.1:${port}${path}?serial=${encodeURIComponent(serial)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    },
  };
}

/** Wait for the first controller frame of a given type. */
function nextFrame(ws: WebSocket, type: string, ms = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type} frame within ${ms}ms`)), ms);
    const onMsg = (raw: Buffer) => {
      const parsed = parseControllerFrame(raw.toString('utf8'));
      if (!parsed.ok) return reject(new Error(`controller sent an invalid frame: ${parsed.error}`));
      if (parsed.value.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(parsed.value as unknown as Record<string, unknown>);
    };
    ws.on('message', onMsg);
  });
}

// ── Adoption ─────────────────────────────────────────────────────────────────

test('adoption handshake: the node is paired and only the token HASH is stored', async () => {
  const { verifyPassword } = await import('./auth');
  const node = await startMockNode();
  try {
    const out = await adoptAtOrigin(`http://127.0.0.1:${node.port}`, {
      controllerName: 'Test Masjid',
      wsUrl: 'ws://192.168.1.10:7860/ws/node',
      name: 'Main Hall',
    });
    assert.ok(!('error' in out), `adoption should succeed: ${'error' in out ? out.error : ''}`);
    const rec = out.node;

    // The node's identity came from the device, not from us.
    assert.equal(rec.serial, SERIAL);
    assert.equal(rec.model, 'Raspberry Pi Zero 2 W');
    assert.equal(rec.fw, '0.62.0');
    assert.deepEqual(rec.caps.codecs, ['h264']);
    assert.equal(rec.name, 'Main Hall');

    // The node got told who adopted it and where to dial home.
    assert.equal(node.received.controllerName, 'Test Masjid');
    assert.equal(node.received.wsUrl, 'ws://192.168.1.10:7860/ws/node');

    // The credential: a 256-bit hex token, kept ONLY as a scrypt hash. If a db.json leaks,
    // it must not be usable to impersonate this node.
    const token = node.received.token!;
    assert.match(token, /^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(rec);
    assert.ok(!serialized.includes(token), 'the plaintext token must never be in the record');
    assert.ok(rec.tokenHash && rec.tokenSalt, 'hash + salt must be stored');
    assert.notEqual(rec.tokenHash, token);
    // …and what the node was handed must actually authenticate against that hash.
    assert.equal(verifyPassword(token, { hash: rec.tokenHash, salt: rec.tokenSalt }), true);
    assert.equal(verifyPassword('0'.repeat(64), { hash: rec.tokenHash, salt: rec.tokenSalt }), false);
  } finally {
    node.close();
  }
});

test('a node that is already adopted refuses to be taken over', async () => {
  const node = await startMockNode({ alreadyAdopted: true });
  try {
    const out = await adoptAtOrigin(`http://127.0.0.1:${node.port}`, {
      controllerName: 'Test Masjid',
      wsUrl: 'ws://x/ws/node',
    });
    assert.ok('error' in out);
    assert.match(out.error, /already adopted/i);
    assert.match(out.error, /factory-reset/, 'the admin needs to be told how to recover it');
  } finally {
    node.close();
  }
});

test('adoption refuses a device that is not a display node', async () => {
  const impostor = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hello: 'i am a printer' }));
  });
  impostor.listen(0, '127.0.0.1');
  await once(impostor, 'listening');
  try {
    const out = await adoptAtOrigin(`http://127.0.0.1:${(impostor.address() as AddressInfo).port}`, {
      controllerName: 'x',
      wsUrl: 'ws://x/ws/node',
    });
    assert.ok('error' in out);
    assert.match(out.error, /does not look like a display node/);
  } finally {
    impostor.close();
  }
});

// ── The hub: exercised with a token minted exactly as adoptNode mints one.
test('a node with the right token connects; wrong or unknown credentials do not', async () => {
  const { hashPassword } = await import('./auth');
  const token = 'a'.repeat(64);
  const cred = hashPassword(token);
  const rec: PiNode = {
    id: 'node_1',
    serial: SERIAL,
    name: 'Main Hall',
    tokenHash: cred.hash,
    tokenSalt: cred.salt,
    fw: '0.0.0',
    model: '',
    caps: { codecs: [], maxHeight: 1080, maxFps: 30 },
    ip: '',
    lastSeen: 0,
    createdAt: new Date().toISOString(),
  };
  const store = fakeStore([rec]);
  const ctl = await startController(store);
  try {
    // Right token → connected.
    const ws = ctl.connect(token);
    await once(ws, 'open');
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();

    // Wrong token → 401, never opened.
    const bad = ctl.connect('b'.repeat(64));
    const err = await once(bad, 'error').then(() => 'rejected');
    assert.equal(err, 'rejected');

    // Unknown serial → 401 even with a valid token for another node.
    const unknown = ctl.connect(token, 'not-a-real-serial');
    await once(unknown, 'error');

    // No token at all → 401.
    const anon = new WebSocket(`ws://127.0.0.1:${ctl.port}/ws/node?serial=${SERIAL}`);
    await once(anon, 'error');
  } finally {
    ctl.close();
  }
});

test('the node endpoint does not exist while the piNodes setting is off', async () => {
  const { hashPassword } = await import('./auth');
  const token = 'c'.repeat(64);
  const cred = hashPassword(token);
  const store = fakeStore(
    [
      {
        id: 'node_1', serial: SERIAL, name: 'n', tokenHash: cred.hash, tokenSalt: cred.salt,
        fw: '0', model: '', caps: CAPS, ip: '', lastSeen: 0, createdAt: '',
      },
    ],
    false, // piNodes OFF
  );
  const ctl = await startController(store);
  try {
    const ws = ctl.connect(token);
    await once(ws, 'error'); // socket destroyed, no handshake
    assert.notEqual(ws.readyState, WebSocket.OPEN);
  } finally {
    ctl.close();
  }
});

test('the tunnel path prefix is accepted, and an unrelated ws path is not stolen', async () => {
  const { hashPassword } = await import('./auth');
  const token = 'd'.repeat(64);
  const cred = hashPassword(token);
  const store = fakeStore([
    { id: 'node_1', serial: SERIAL, name: 'n', tokenHash: cred.hash, tokenSalt: cred.salt, fw: '0', model: '', caps: CAPS, ip: '', lastSeen: 0, createdAt: '' },
  ]);
  // A stand-in for the panel hub, registered FIRST — this is the regression guard for the
  // single-upgrade-router change: with two independent 'upgrade' listeners, one would
  // destroy the other's sockets.
  let panelUpgrades = 0;
  const panel: UpgradeTarget = {
    matches: (p) => p === '/ws',
    handleUpgrade: (_req, socket) => {
      panelUpgrades += 1;
      socket.destroy();
    },
  };
  const ctl = await startController(store, [panel]);
  try {
    // Behind the OpenMasjidOS tunnel the app is served under /<appId>/…
    const prefixed = ctl.connect(token, SERIAL, '/display/ws/node');
    await once(prefixed, 'open');
    assert.equal(prefixed.readyState, WebSocket.OPEN, 'a tunnel-prefixed path must connect');
    prefixed.close();

    // The panel path still reaches the panel target, not the node hub.
    const panelWs = new WebSocket(`ws://127.0.0.1:${ctl.port}/ws`);
    await once(panelWs, 'error');
    assert.equal(panelUpgrades, 1, 'the panel endpoint must still receive its own upgrades');
  } finally {
    ctl.close();
  }
});

// ── Driving a connected node ─────────────────────────────────────────────────

async function connectedNode() {
  const { hashPassword } = await import('./auth');
  const token = 'e'.repeat(64);
  const cred = hashPassword(token);
  const rec: PiNode = {
    id: 'node_1', serial: SERIAL, name: 'Main Hall', tokenHash: cred.hash, tokenSalt: cred.salt,
    fw: '0.0.0', model: '', caps: { codecs: [], maxHeight: 720, maxFps: 30 }, ip: '', lastSeen: 0,
    createdAt: new Date().toISOString(),
  };
  const store = fakeStore([rec]);
  const ctl = await startController(store);
  const ws = ctl.connect(token);
  await once(ws, 'open');
  return { ctl, ws, store, rec };
}

test('hello updates the stored firmware, model and capabilities', async () => {
  const { ctl, ws, store } = await connectedNode();
  try {
    ws.send(encodeFrame({ type: 'hello', serial: SERIAL, fw: '0.62.0', model: 'Raspberry Pi Zero 2 W', caps: CAPS }));
    await waitFor(() => store.db.nodes![0].fw === '0.62.0');
    assert.equal(store.db.nodes![0].model, 'Raspberry Pi Zero 2 W');
    assert.deepEqual(store.db.nodes![0].caps.codecs, ['h264']);
  } finally {
    ws.close();
    ctl.close();
  }
});

test('a node claiming a different serial than it authenticated as is disconnected', async () => {
  const { ctl, ws, store } = await connectedNode();
  try {
    ws.send(encodeFrame({ type: 'hello', serial: 'someone-elses-serial', fw: '9.9.9', model: 'x', caps: CAPS }));
    await once(ws, 'close');
    assert.notEqual(store.db.nodes![0].fw, '9.9.9', 'it must not overwrite another record');
  } finally {
    ctl.close();
  }
});

test('status heartbeats record health and keep the node fresh', async () => {
  const { ctl, ws, store } = await connectedNode();
  try {
    ws.send(
      encodeFrame({
        type: 'status',
        mode: 'timetable',
        health: { tempC: 47.5, memFreeMb: 190, uptimeS: 400, wifiRssi: -58, ip: '192.168.1.44' },
      }),
    );
    await waitFor(() => store.db.nodes![0].health?.tempC === 47.5);
    assert.equal(store.db.nodes![0].ip, '192.168.1.44');
    assert.equal(ctl.hub.isFresh('node_1'), true);
    // Freshness is time-based, so an old heartbeat must read as stale.
    assert.equal(ctl.hub.isFresh('node_1', Date.now() + OFFLINE_AFTER_MS + 1000), false);
    assert.ok(OFFLINE_AFTER_MS > HEARTBEAT_MS, 'sanity: the window must exceed the heartbeat');
  } finally {
    ws.close();
    ctl.close();
  }
});

test('set_content reaches the node, and is not re-sent when nothing changed', async () => {
  const { ctl, ws } = await connectedNode();
  try {
    const doc = { id: 'tt_1', name: 'Main', orientation: 'landscape', quality: '1080p', timezone: 'America/New_York' };
    const wait = nextFrame(ws, 'set_content');
    assert.equal(ctl.hub.setContent('node_1', { type: 'timetable', doc: doc as never, assets: [] }), true);
    const frame = await wait;
    assert.equal(frame.type, 'set_content');
    const content = frame.content as { type: string; doc: { id: string } };
    assert.equal(content.type, 'timetable');
    assert.equal(content.doc.id, 'tt_1');

    // The orchestrator calls this every 15s reconcile; an unchanged push must be a no-op,
    // or a timetable screen would relaunch its kiosk four times a minute.
    assert.equal(ctl.hub.setContent('node_1', { type: 'timetable', doc: doc as never, assets: [] }), false);
    // A real change does send.
    const wait2 = nextFrame(ws, 'set_content');
    assert.equal(ctl.hub.setContent('node_1', { type: 'off' }), true);
    assert.equal(((await wait2).content as { type: string }).type, 'off');
  } finally {
    ws.close();
    ctl.close();
  }
});

test('identify and reboot are delivered with distinct command ids', async () => {
  const { ctl, ws } = await connectedNode();
  try {
    const w1 = nextFrame(ws, 'identify');
    assert.equal(ctl.hub.identify('node_1', 30), true);
    const idFrame = await w1;
    assert.equal(idFrame.seconds, 30);

    const w2 = nextFrame(ws, 'reboot');
    assert.equal(ctl.hub.reboot('node_1'), true);
    const rebootFrame = await w2;
    assert.notEqual(rebootFrame.cmdId, idFrame.cmdId, 'command ids must be unique per connection');

    // Commands to a node that is not connected fail cleanly rather than throwing.
    assert.equal(ctl.hub.identify('node_missing', 5), false);
    assert.equal(ctl.hub.reboot('node_missing'), false);
  } finally {
    ws.close();
    ctl.close();
  }
});

test('an unsupported_codec event is surfaced so the controller can arrange a relay', async () => {
  const { ctl, ws } = await connectedNode();
  try {
    ws.send(encodeFrame({ type: 'event', event: 'unsupported_codec', detail: 'cannot decode', sourceId: 'src_9', codec: 'H265' }));
    await waitFor(() => ctl.events.some((e) => e.startsWith('codec:')));
    // Lowercased by the protocol so the capability check is case-safe.
    assert.ok(ctl.events.includes('codec:src_9:h265'), `got ${JSON.stringify(ctl.events)}`);
  } finally {
    ws.close();
    ctl.close();
  }
});

test('a garbage frame is ignored without dropping the connection', async () => {
  const { ctl, ws } = await connectedNode();
  try {
    ws.send('not json at all');
    ws.send(JSON.stringify({ v: 999, type: 'status', mode: 'timetable' }));
    ws.send(JSON.stringify({ v: 1, type: 'nonsense' }));
    // Still alive and still driveable afterwards. Reaching into the private members is
    // deliberate: `ping` has no public sender because nothing but a keepalive needs one.
    const wait = nextFrame(ws, 'ping');
    const conn = (ctl.hub as unknown as { conns: Map<string, unknown> }).conns.get('node_1');
    assert.ok(conn, 'the connection should be registered');
    const send = (ctl.hub as unknown as { send(c: unknown, f: unknown): boolean }).send.bind(ctl.hub);
    assert.equal(send(conn, { type: 'ping', cmdId: 'p1' }), true);
    await wait;
    assert.equal(ws.readyState, WebSocket.OPEN);
  } finally {
    ws.close();
    ctl.close();
  }
});

test('a reconnect supersedes the old socket and re-pushes content', async () => {
  const { hashPassword } = await import('./auth');
  const token = 'f'.repeat(64);
  const cred = hashPassword(token);
  const store = fakeStore([
    { id: 'node_1', serial: SERIAL, name: 'n', tokenHash: cred.hash, tokenSalt: cred.salt, fw: '0', model: '', caps: CAPS, ip: '', lastSeen: 0, createdAt: '' },
  ]);
  const ctl = await startController(store);
  try {
    const first = ctl.connect(token);
    await once(first, 'open');
    assert.equal(ctl.hub.setContent('node_1', { type: 'off' }), true);
    assert.equal(ctl.hub.setContent('node_1', { type: 'off' }), false, 'deduped while connected');

    const second = ctl.connect(token);
    await once(second, 'open');
    // A reconnected node has forgotten what it was showing. `hello` clears the dedupe so
    // the next reconcile re-pushes — otherwise a node that rebooted would sit blank.
    second.send(encodeFrame({ type: 'hello', serial: SERIAL, fw: '0.62.0', model: 'x', caps: CAPS }));
    await waitFor(() => store.db.nodes![0].fw === '0.62.0');
    assert.equal(ctl.hub.setContent('node_1', { type: 'off' }), true, 'content must be re-sent after a reconnect');
    second.close();
  } finally {
    ctl.close();
  }
});

/** Poll a predicate until true, or fail. Frames arrive asynchronously. */
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met in time');
}
