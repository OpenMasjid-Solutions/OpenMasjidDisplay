// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The agent, driven by the REAL controller.
 *
 * This is the closest thing to M1's on-device acceptance that can run without a Pi: the
 * actual `Agent` state machine, the actual `ControllerClient`, the actual local HTTP API,
 * and the actual `NodeHub` from server/, talking over real sockets with real scrypt token
 * auth. Only `Platform` is faked — that is precisely why the seam exists (platform.ts).
 *
 * What this cannot prove: that `cog` renders, that `v4l2h264dec` decodes, that HDMI comes
 * up with the TV off at boot. Those need hardware and are M1's remaining acceptance.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Agent } from './agent';
import { AgentStore } from './store';
import { createLocalApi } from './localApi';
import type { Platform, Proc } from './platform';
import { NodeHub } from '../../../server/src/nodeHub';
import { routeUpgrades } from '../../../server/src/ws';
import { hashPassword } from '../../../server/src/auth';
import type { DB, PiNode } from '../../../server/src/types';
import type { Store } from '../../../server/src/store';
import type { NodeCapsMsg, NodeHealthMsg } from '../../../packages/protocol/src/index';

const SERIAL = '10000000feedface';
const TOKEN = 'a'.repeat(64);
const CAPS: NodeCapsMsg = { codecs: ['h264'], maxHeight: 1080, maxFps: 30 };

/** Records what the "display" was asked to do, so tests can assert on the screen. */
class FakePlatform implements Platform {
  launched: Array<{ kind: 'kiosk' | 'player'; url: string }> = [];
  blanked = 0;
  rebooted = 0;
  wiped = 0;
  synced = true;
  private procs: FakeProc[] = [];

  serial(): string {
    return SERIAL;
  }
  model(): string {
    return 'Raspberry Pi Zero 2 W';
  }
  caps(): NodeCapsMsg {
    return CAPS;
  }
  health(): NodeHealthMsg {
    return { tempC: 44.2, memFreeMb: 200, uptimeS: 120, wifiRssi: -55, ip: '192.168.1.77' };
  }
  clockSynced(): boolean {
    return this.synced;
  }
  startKiosk(url: string): Proc {
    this.launched.push({ kind: 'kiosk', url });
    const p = new FakeProc();
    this.procs.push(p);
    return p;
  }
  startPlayer(url: string): Proc {
    this.launched.push({ kind: 'player', url });
    const p = new FakeProc();
    this.procs.push(p);
    return p;
  }
  blank(): void {
    this.blanked += 1;
  }
  reboot(): void {
    this.rebooted += 1;
  }
  wipeData(): void {
    this.wiped += 1;
  }
  /** Simulate the newest child dying on its own. */
  crashNewest(): void {
    this.procs.filter((p) => p.running).slice(-1)[0]?.crash();
  }
  get hasRunning(): boolean {
    return this.procs.some((p) => p.running);
  }
  get last(): { kind: string; url: string } | undefined {
    return this.launched[this.launched.length - 1];
  }
}

class FakeProc implements Proc {
  running = true;
  private cbs: Array<(i: { code: number | null; signal: string | null }) => void> = [];
  onExit(cb: (i: { code: number | null; signal: string | null }) => void): void {
    this.cbs.push(cb);
  }
  async stop(): Promise<void> {
    this.running = false;
  }
  crash(): void {
    this.running = false;
    for (const cb of this.cbs) cb({ code: 1, signal: null });
  }
}

function fakeControllerStore(nodes: PiNode[]): Store {
  const db = {
    version: 1,
    admin: null,
    settings: { defaultQuality: '1080p', scheduleTimezone: '', volunteerEnabled: false, volunteerRemote: true, piNodes: true },
    timetables: [],
    sources: [],
    tvs: [],
    schedules: [],
    nodes,
  } as unknown as DB;
  return { db, update: (fn: (d: DB) => void) => fn(db) } as unknown as Store;
}

/** Stand up the real controller hub on an ephemeral port. */
async function startController() {
  const cred = hashPassword(TOKEN);
  const rec: PiNode = {
    id: 'node_1', serial: SERIAL, name: 'Main Hall', tokenHash: cred.hash, tokenSalt: cred.salt,
    fw: '0.0.0', model: '', caps: { codecs: [], maxHeight: 720, maxFps: 30 }, ip: '', lastSeen: 0,
    createdAt: new Date().toISOString(),
  };
  const store = fakeControllerStore([rec]);
  const events: string[] = [];
  const hub = new NodeHub(store, {
    onUnsupportedCodec: (_n, s, c) => events.push(`codec:${s}:${c}`),
    onNotify: () => {},
    onChanged: () => {},
  });
  // Serves the node-asset route the same way api.ts does: content-addressed, and gated on
  // (serial, bearer token) rather than an admin cookie.
  const assets = new Map<string, Buffer>();
  const assetRequests: string[] = [];
  const server = http.createServer((q, r) => {
    const url = new URL(q.url ?? '/', 'http://x');
    const m = /^\/api\/node\/assets\/([0-9a-f]{64})$/.exec(url.pathname);
    if (m) {
      assetRequests.push(m[1]);
      const authed =
        (q.headers.authorization ?? '') === `Bearer ${TOKEN}` && url.searchParams.get('serial') === SERIAL;
      if (!authed) {
        r.writeHead(401);
        return r.end('{}');
      }
      const bytes = assets.get(m[1]);
      if (!bytes) {
        r.writeHead(404);
        return r.end('{}');
      }
      r.writeHead(200, { 'content-type': 'image/png' });
      return r.end(bytes);
    }
    r.end('ok');
  });
  routeUpgrades(server, [hub]);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    hub,
    store,
    events,
    assets,
    assetRequests,
    wsUrl: `ws://127.0.0.1:${port}/ws/node`,
    close: () => server.close(),
  };
}

/** A temp /data for the agent's store. */
function tempData(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-agent-'));
  return dir;
}

async function waitFor(pred: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${what} not met within ${ms}ms`);
}

const DOC = { id: 'tt_1', name: 'Main', orientation: 'landscape', quality: '1080p', timezone: 'America/New_York' };

// ── The full loop ────────────────────────────────────────────────────────────

test('end to end: adopt over HTTP, dial home, receive content, drive the display', async () => {
  const ctl = await startController();
  const dataDir = tempData();
  const platform = new FakePlatform();
  const store = new AgentStore(dataDir);
  const agent = new Agent({ store, platform, fw: '0.62.0', kioskOrigin: 'http://127.0.0.1:9999', assetDir: path.join(dataDir, 'assets') });

  // The node's own local API, as an admin's controller would reach it.
  const api = createLocalApi({
    store, platform, fw: '0.62.0', kioskDir: dataDir,
    viewJson: () => agent.view(),
    onAdopted: () => agent.onAdopted(),
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const nodePort = (api.address() as AddressInfo).port;
  const nodeUrl = `http://127.0.0.1:${nodePort}`;

  try {
    await agent.start();
    // Before adoption the TV shows the status page, so an admin can read the address off it.
    assert.equal(platform.last?.kind, 'kiosk');
    assert.equal(agent.mode, 'status_screen');
    let view = agent.view();
    assert.equal(view.kind, 'status');
    assert.ok(view.kind === 'status' && view.adopted === false);
    assert.ok(view.kind === 'status' && view.ip === '192.168.1.77', 'the page needs the address to display');

    // 1) The controller asks who it is.
    const status = (await (await fetch(`${nodeUrl}/api/status`)).json()) as { serial: string; adopted: boolean };
    assert.equal(status.serial, SERIAL);
    assert.equal(status.adopted, false);

    // 2) The controller adopts it, handing over the token it minted.
    const adoptRes = await fetch(`${nodeUrl}/api/adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerName: 'Test Masjid', wsUrl: ctl.wsUrl, nodeToken: TOKEN }),
    });
    assert.equal(adoptRes.status, 200);
    assert.equal(((await adoptRes.json()) as { serial: string }).serial, SERIAL);

    // 3) The node persists it and dials home. The controller learns its real caps.
    await waitFor(() => ctl.hub.isFresh('node_1'), 4000, 'node connects');
    await waitFor(() => ctl.store.db.nodes![0].fw === '0.62.0', 3000, 'hello lands');
    assert.equal(ctl.store.db.nodes![0].model, 'Raspberry Pi Zero 2 W');
    assert.deepEqual(ctl.store.db.nodes![0].caps.codecs, ['h264']);
    await waitFor(() => ctl.store.db.nodes![0].health?.tempC === 44.2, 3000, 'heartbeat lands');

    // 4) The controller tells it to show a timetable → the kiosk is launched.
    assert.equal(ctl.hub.setContent('node_1', { type: 'timetable', doc: DOC as never, assets: [] }), true);
    await waitFor(() => agent.mode === 'timetable', 3000, 'switches to timetable');
    assert.equal(platform.last?.kind, 'kiosk');
    view = agent.view();
    assert.equal(view.kind, 'timetable');
    assert.deepEqual(view.kind === 'timetable' ? view.doc : null, DOC, 'the kiosk gets the document verbatim');

    // 5) …then a camera → the player is launched with the URL as given.
    const launchesBefore = platform.launched.length;
    assert.equal(
      ctl.hub.setContent('node_1', { type: 'stream', url: 'rtsp://cam.local/1', transport: 'tcp', relay: false }),
      true,
    );
    await waitFor(() => agent.mode === 'stream', 3000, 'switches to stream');
    assert.equal(platform.last?.kind, 'player');
    assert.equal(platform.last?.url, 'rtsp://cam.local/1');
    assert.ok(platform.launched.length > launchesBefore);

    // 6) …then off → blanked, no process.
    assert.equal(ctl.hub.setContent('node_1', { type: 'off' }), true);
    await waitFor(() => agent.mode === 'off', 3000, 'switches off');
    assert.ok(platform.blanked >= 1);

    // 7) Adoption is ONE-SHOT: a second attempt is refused forever.
    const second = await fetch(`${nodeUrl}/api/adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerName: 'Attacker', wsUrl: 'ws://evil/ws/node', nodeToken: 'b'.repeat(64) }),
    });
    assert.equal(second.status, 409, 'an adopted node must not be re-pointed');
    assert.equal(store.adoption?.controllerName, 'Test Masjid');
  } finally {
    await agent.stop();
    api.close();
    ctl.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the masjid’s own photo and logo are fetched, cached and served to the kiosk', async () => {
  const ctl = await startController();
  const dataDir = tempData();
  const platform = new FakePlatform();
  const store = new AgentStore(dataDir);
  store.adopt({ controllerName: 'Test Masjid', wsUrl: ctl.wsUrl, nodeToken: TOKEN, adoptedAt: '' });
  const agent = new Agent({ store, platform, fw: '0.62.0', kioskOrigin: 'http://127.0.0.1:9999', assetDir: path.join(dataDir, 'assets') });

  // The node serves what it cached to its own kiosk browser.
  const api = createLocalApi({
    store, platform, fw: '0.62.0', kioskDir: dataDir,
    viewJson: () => agent.view(),
    readAsset: (sha) => agent.readAsset(sha),
    onAdopted: () => agent.onAdopted(),
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const nodeUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452deadbeef', 'hex');
  const sha = crypto.createHash('sha256').update(png).digest('hex');
  ctl.assets.set(sha, png);

  try {
    await agent.start();
    await waitFor(() => ctl.hub.isFresh('node_1'), 4000, 'connects');
    ctl.hub.setContent('node_1', {
      type: 'timetable',
      doc: DOC as never,
      assets: [{ id: 'bg', sha256: sha, url: `/api/node/assets/${sha}` }],
    });
    await waitFor(() => agent.mode === 'timetable', 4000, 'timetable up');

    // The kiosk is handed a LOCAL url for the photo, not a data URI — a browser fetches
    // `<image href>` happily, and base64-ing a multi-megabyte photo into the document every
    // second on a 512 MB board would not end well.
    const view = agent.view();
    assert.ok(view.kind === 'timetable');
    assert.equal(view.assets?.bg, `/assets/${sha}`);

    // …and that URL really serves the bytes, byte-for-byte.
    const res = await fetch(`${nodeUrl}/assets/${sha}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png', 'sniffed from the magic number');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);

    // A re-push of the same timetable must not re-download it.
    const fetches = ctl.assetRequests.length;
    ctl.hub.setContent('node_1', { type: 'off' });
    await waitFor(() => agent.mode === 'off', 3000, 'off');
    ctl.hub.setContent('node_1', {
      type: 'timetable',
      doc: DOC as never,
      assets: [{ id: 'bg', sha256: sha, url: `/api/node/assets/${sha}` }],
    });
    await waitFor(() => agent.mode === 'timetable', 4000, 'timetable again');
    assert.equal(ctl.assetRequests.length, fetches, 'a cached hash is never re-fetched');

    // An unknown hash is 404 rather than a path into the box.
    assert.equal((await fetch(`${nodeUrl}/assets/${'e'.repeat(64)}`)).status, 404);
    assert.equal((await fetch(`${nodeUrl}/assets/not-a-hash`)).status, 404);
  } finally {
    await agent.stop();
    api.close();
    ctl.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an asset the controller cannot serve does not stop the timetable', async () => {
  // A masjid would far rather see the timetable without its logo than not see the timetable.
  const ctl = await startController();
  const dataDir = tempData();
  const platform = new FakePlatform();
  const store = new AgentStore(dataDir);
  store.adopt({ controllerName: 'M', wsUrl: ctl.wsUrl, nodeToken: TOKEN, adoptedAt: '' });
  const agent = new Agent({ store, platform, fw: '0.62.0', kioskOrigin: 'http://127.0.0.1:9999', assetDir: path.join(dataDir, 'assets') });
  try {
    await agent.start();
    await waitFor(() => ctl.hub.isFresh('node_1'), 4000, 'connects');
    // Nothing registered in ctl.assets → the fetch 404s.
    ctl.hub.setContent('node_1', {
      type: 'timetable',
      doc: DOC as never,
      assets: [{ id: 'logo', sha256: 'f'.repeat(64), url: `/api/node/assets/${'f'.repeat(64)}` }],
    });
    await waitFor(() => agent.mode === 'timetable', 5000, 'the timetable still comes up');
    const view = agent.view();
    assert.ok(view.kind === 'timetable');
    assert.equal(view.assets?.logo, undefined, 'the slot is simply absent → themed scene');
  } finally {
    await agent.stop();
    ctl.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('losing the controller does NOT change what is on the screen', async () => {
  // The invariant the whole design rests on: a container restart must not blank a masjid.
  const ctl = await startController();
  const dataDir = tempData();
  const platform = new FakePlatform();
  const store = new AgentStore(dataDir);
  store.adopt({ controllerName: 'Test Masjid', wsUrl: ctl.wsUrl, nodeToken: TOKEN, adoptedAt: '' });
  const agent = new Agent({ store, platform, fw: '0.62.0', kioskOrigin: 'http://127.0.0.1:9999', assetDir: path.join(dataDir, 'assets') });
  try {
    await agent.start();
    await waitFor(() => ctl.hub.isFresh('node_1'), 4000, 'connects');
    ctl.hub.setContent('node_1', { type: 'timetable', doc: DOC as never, assets: [] });
    await waitFor(() => agent.mode === 'timetable', 3000, 'timetable up');
    const launches = platform.launched.length;

    // The controller goes away entirely.
    ctl.close();
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(agent.mode, 'timetable', 'the screen must keep showing the timetable');
    assert.equal(platform.launched.length, launches, 'and must not relaunch anything');
    const view = agent.view();
    assert.equal(view.kind, 'timetable', 'and the page still has its document');
  } finally {
    await agent.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a timetable is withheld until the clock is NTP-synced', async () => {
  // A Pi has no RTC. Prayer times from a 1970 clock are worse than an honest notice.
  const ctl = await startController();
  const dataDir = tempData();
  const platform = new FakePlatform();
  platform.synced = false;
  const store = new AgentStore(dataDir);
  store.adopt({ controllerName: 'M', wsUrl: ctl.wsUrl, nodeToken: TOKEN, adoptedAt: '' });
  const agent = new Agent({ store, platform, fw: '0.62.0', kioskOrigin: 'http://127.0.0.1:9999', assetDir: path.join(dataDir, 'assets') });
  try {
    await agent.start();
    await waitFor(() => ctl.hub.isFresh('node_1'), 4000, 'connects');
    ctl.hub.setContent('node_1', { type: 'timetable', doc: DOC as never, assets: [] });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(agent.mode, 'status_screen', 'must not draw times from an unset clock');
    const view = agent.view();
    assert.ok(view.kind === 'status' && /clock/i.test(view.note), `note should explain: ${JSON.stringify(view)}`);

    // Once NTP lands, the retry picks it up on its own.
    platform.synced = true;
    await waitFor(() => agent.mode === 'timetable', 8000, 'timetable appears after sync');
  } finally {
    await agent.stop();
    ctl.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('identify takes the screen briefly, then the content comes back', async () => {
  const ctl = await startController();
  const dataDir = tempData();
  const platform = new FakePlatform();
  const store = new AgentStore(dataDir);
  store.adopt({ controllerName: 'Test Masjid', wsUrl: ctl.wsUrl, nodeToken: TOKEN, adoptedAt: '' });
  const agent = new Agent({ store, platform, fw: '0.62.0', kioskOrigin: 'http://127.0.0.1:9999', assetDir: path.join(dataDir, 'assets') });
  try {
    await agent.start();
    await waitFor(() => ctl.hub.isFresh('node_1'), 4000, 'connects');
    ctl.hub.setContent('node_1', { type: 'stream', url: 'rtsp://cam/1', transport: 'tcp', relay: false });
    await waitFor(() => agent.mode === 'stream', 3000, 'stream up');

    assert.equal(ctl.hub.identify('node_1', 1), true);
    await waitFor(() => agent.mode === 'status_screen', 3000, 'identify shows');
    const view = agent.view();
    assert.ok(view.kind === 'status' && view.identify, 'the page is told to show the identity');

    // …and the camera returns without the controller having to re-send anything.
    await waitFor(() => agent.mode === 'stream', 5000, 'content restored');
  } finally {
    await agent.stop();
    ctl.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a crashing player is restarted, then falls back to a status screen that explains it', async () => {
  const ctl = await startController();
  const dataDir = tempData();
  const platform = new FakePlatform();
  const store = new AgentStore(dataDir);
  store.adopt({ controllerName: 'M', wsUrl: ctl.wsUrl, nodeToken: TOKEN, adoptedAt: '' });
  // Fast restart timer: the real backoff is 1s → 2s → 4s → …, correct on a Pi and far too
  // slow to sit through here. This is the behaviour under test, not the delay.
  const agent = new Agent({
    store, platform, fw: '0.62.0', kioskOrigin: 'http://127.0.0.1:9999', assetDir: path.join(dataDir, 'assets'),
    setTimer: (fn, _ms) => setTimeout(fn, 5),
  });
  try {
    await agent.start();
    await waitFor(() => ctl.hub.isFresh('node_1'), 4000, 'connects');
    ctl.hub.setContent('node_1', { type: 'stream', url: 'rtsp://cam/1', transport: 'tcp', relay: false });
    await waitFor(() => agent.mode === 'stream', 3000, 'stream up');

    // Crash it more times than the supervisor tolerates. Wait for each relaunch first —
    // crashing while nothing is running would be a no-op and the loop would prove nothing.
    const launchesAtStart = platform.launched.length;
    for (let i = 0; i < 8 && agent.mode === 'stream'; i++) {
      await waitFor(() => platform.hasRunning, 3000, 'a player is running');
      platform.crashNewest();
      await new Promise((r) => setTimeout(r, 30));
    }
    await waitFor(() => agent.mode === 'status_screen', 8000, 'gives up to the status screen');
    assert.ok(platform.launched.length > launchesAtStart + 3, 'it should have retried several times before giving up');
    const view = agent.view();
    assert.ok(view.kind === 'status' && view.note.length > 0, 'the screen must say what went wrong');
  } finally {
    await agent.stop();
    ctl.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an unknown command is NAKed with a reason, not silently accepted', async () => {
  const ctl = await startController();
  const dataDir = tempData();
  const platform = new FakePlatform();
  const store = new AgentStore(dataDir);
  store.adopt({ controllerName: 'M', wsUrl: ctl.wsUrl, nodeToken: TOKEN, adoptedAt: '' });
  const agent = new Agent({ store, platform, fw: '0.62.0', kioskOrigin: 'http://127.0.0.1:9999', assetDir: path.join(dataDir, 'assets') });
  try {
    await agent.start();
    await waitFor(() => ctl.hub.isFresh('node_1'), 4000, 'connects');
    // `update` is M3; the agent must refuse it clearly so the panel can show why.
    const conns = (ctl.hub as unknown as { conns: Map<string, { ws: { send(s: string): void } }> }).conns;
    const send = (ctl.hub as unknown as { send(c: unknown, f: unknown): boolean }).send.bind(ctl.hub);
    assert.equal(
      send(conns.get('node_1'), {
        type: 'update', cmdId: 'u1', version: '9.9.9', url: 'https://x/y', sha256: 'a'.repeat(64), sig: 'sig',
      }),
      true,
    );
    // The agent stays up and keeps serving; the NAK is visible in the controller's log.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ctl.hub.isFresh('node_1'), true, 'a NAK must not drop the connection');
  } finally {
    await agent.stop();
    ctl.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('factory_reset clears the adoption and wipes the device', async () => {
  const ctl = await startController();
  const dataDir = tempData();
  const platform = new FakePlatform();
  const store = new AgentStore(dataDir);
  store.adopt({ controllerName: 'M', wsUrl: ctl.wsUrl, nodeToken: TOKEN, adoptedAt: '' });
  const agent = new Agent({ store, platform, fw: '0.62.0', kioskOrigin: 'http://127.0.0.1:9999', assetDir: path.join(dataDir, 'assets') });
  try {
    await agent.start();
    await waitFor(() => ctl.hub.isFresh('node_1'), 4000, 'connects');
    assert.equal(ctl.hub.factoryReset('node_1'), true);
    await waitFor(() => !store.adopted, 3000, 'adoption cleared');
    await waitFor(() => platform.wiped === 1, 3000, 'device wiped');
    // And it is adoptable again: a fresh store on the same dir reads as unadopted.
    assert.equal(new AgentStore(dataDir).adopted, false);
  } finally {
    await agent.stop();
    ctl.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the node refuses to connect with a token the controller did not issue', async () => {
  const ctl = await startController();
  const dataDir = tempData();
  const platform = new FakePlatform();
  const store = new AgentStore(dataDir);
  store.adopt({ controllerName: 'M', wsUrl: ctl.wsUrl, nodeToken: 'c'.repeat(64), adoptedAt: '' });
  const agent = new Agent({ store, platform, fw: '0.62.0', kioskOrigin: 'http://127.0.0.1:9999', assetDir: path.join(dataDir, 'assets') });
  try {
    await agent.start();
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(ctl.hub.isFresh('node_1'), false, 'a wrong token must never establish a session');
    // …and the screen still shows something useful rather than going dark.
    assert.equal(agent.mode, 'status_screen');
  } finally {
    await agent.stop();
    ctl.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ── The local API's own guards ────────────────────────────────────────────────

test('the local API gates /api/view to loopback and other /api to the token', async () => {
  const dataDir = tempData();
  const platform = new FakePlatform();
  const store = new AgentStore(dataDir);
  store.adopt({ controllerName: 'M', wsUrl: 'ws://x/ws/node', nodeToken: TOKEN, adoptedAt: '' });
  const api = createLocalApi({
    store, platform, fw: '0.62.0', kioskDir: dataDir,
    viewJson: () => ({ kind: 'status' }),
    onAdopted: () => {},
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  try {
    // We ARE loopback in this test, so the view is served.
    assert.equal((await fetch(`${base}/api/view`)).status, 200);
    // An unknown authed route needs the token: 401 without, 404 with (it exists as a route
    // space but nothing is there) — never a 404 that leaks the difference to an anonymous
    // caller on the LAN.
    assert.equal((await fetch(`${base}/api/whatever`)).status, 401);
    assert.equal((await fetch(`${base}/api/whatever`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 404);
    assert.equal((await fetch(`${base}/api/whatever`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    // A GET-only surface.
    assert.equal((await fetch(`${base}/`, { method: 'DELETE' })).status, 405);
  } finally {
    api.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
