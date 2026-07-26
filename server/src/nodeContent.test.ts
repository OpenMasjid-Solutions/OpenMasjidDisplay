// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The Pi-node decision logic: what a node is told to show, and — the point of the whole
 * feature — that a node screen costs the controller no video work.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { planNodeContent } from './nodeContent';
import { isNodeScreen } from './orchestrator';
import { nodeOrigin, controllerWsUrl } from './nodeAdopt';
import { normTv, normSource } from './validate';
import type { NodeCaps, Source, Timetable, Tv } from './types';

const CAPS: NodeCaps = { codecs: ['h264'], maxHeight: 1080, maxFps: 30 };
const RELAY = 'rtsp://192.168.1.10:8554';

// Normalize first (so id/createdAt are generated the way the store would), THEN overlay
// the raw fields. The second spread is not redundant: normSource intentionally refuses to
// take `videoCodec` from input — it is only ever learned from a node's `unsupported_codec`
// event — so a test that wants a learned codec has to set it after normalization, exactly
// as the hub does.
const src = (over: Partial<Source> = {}): Source => ({
  ...normSource({ name: 'Cam', url: 'rtsp://cam.local/stream', mode: 'direct', ...over }),
  ...over,
});

const tt = { id: 'tt_1', name: 'Main', orientation: 'landscape', quality: '1080p' } as unknown as Timetable;

const plan = (over: Partial<Parameters<typeof planNodeContent>[0]> = {}) =>
  planNodeContent({ content: { kind: 'off' }, relayBase: RELAY, usedByDecoder: false, caps: CAPS, ...over });

// ── Timetables: the zero-cost path ───────────────────────────────────────────

test('a timetable is sent as a document, not a video stream', () => {
  const p = plan({ content: { kind: 'timetable', id: 'tt_1' }, timetable: tt });
  assert.equal(p.content.type, 'timetable');
  assert.ok(p.content.type === 'timetable' && p.content.doc.id === 'tt_1');
  // Nothing for the controller to transcode — this is the compute win.
  assert.equal(p.normalizeSourceId, undefined);
  assert.equal(p.problem, undefined);
});

test('a deleted timetable turns the screen off rather than rendering something stale', () => {
  const p = plan({ content: { kind: 'timetable', id: 'gone' }, timetable: undefined });
  assert.equal(p.content.type, 'off');
});

// ── Sources: direct play vs relay ────────────────────────────────────────────

test('a decodable source plays DIRECT — not one byte through the controller', () => {
  const s = src();
  const p = plan({ content: { kind: 'source', id: s.id }, source: s });
  assert.ok(p.content.type === 'stream');
  assert.equal(p.content.url, 'rtsp://cam.local/stream');
  assert.equal(p.content.relay, false);
  assert.equal(p.normalizeSourceId, undefined, 'no transcode should be started');
});

test('an unknown codec still tries direct first (we learn by failing once, not by probing)', () => {
  const s = src({ videoCodec: '' });
  const p = plan({ content: { kind: 'source', id: s.id }, source: s });
  assert.ok(p.content.type === 'stream' && p.content.relay === false);
});

test('a codec the node cannot decode is relayed through the controller', () => {
  const s = src({ videoCodec: 'h265', mode: 'normalize' });
  const p = plan({ content: { kind: 'source', id: s.id }, source: s });
  assert.ok(p.content.type === 'stream');
  assert.equal(p.content.relay, true);
  assert.equal(p.content.url, `${RELAY}/${s.id}`);
  assert.equal(p.normalizeSourceId, s.id, 'the controller must transcode this source');
});

test('caps are matched case-insensitively (a node may report H264)', () => {
  const s = src({ videoCodec: 'H264' });
  const p = plan({ content: { kind: 'source', id: s.id }, source: s });
  assert.ok(p.content.type === 'stream' && p.content.relay === false, 'H264 == h264, so play direct');
});

test('nodePlayback always-relay routes through the controller even for a decodable codec', () => {
  const s = src({ nodePlayback: 'always-relay', mode: 'normalize', videoCodec: 'h264' });
  const p = plan({ content: { kind: 'source', id: s.id }, source: s });
  assert.ok(p.content.type === 'stream' && p.content.relay === true);
  assert.equal(p.normalizeSourceId, s.id);
});

test('nodePlayback direct-only never relays, even for an undecodable codec', () => {
  const s = src({ nodePlayback: 'direct-only', videoCodec: 'h265' });
  const p = plan({ content: { kind: 'source', id: s.id }, source: s });
  assert.ok(p.content.type === 'stream' && p.content.relay === false);
  assert.equal(p.normalizeSourceId, undefined);
});

test('a disabled or missing source turns the screen off', () => {
  assert.equal(plan({ content: { kind: 'source', id: 'x' }, source: undefined }).content.type, 'off');
  assert.equal(plan({ content: { kind: 'source', id: 'x' }, source: src({ enabled: false }) }).content.type, 'off');
});

// ── The regression that matters: never break a legacy screen for a node ──────

test('relaying a DIRECT source that a decoder screen is using is refused, with an explanation', () => {
  // Transcoding into src_<id> would fight the MediaMTX proxy path that decoder screen is
  // reading. A legacy screen must not regress to make a node work.
  const s = src({ videoCodec: 'h265', mode: 'direct' });
  const p = plan({ content: { kind: 'source', id: s.id }, source: s, usedByDecoder: true });
  assert.equal(p.normalizeSourceId, undefined, 'must NOT start a conflicting transcode');
  assert.ok(p.problem, 'the admin must be told what to change');
  assert.match(p.problem!, /normalize/, 'the fix should be named');
});

test('the same source in normalize mode CAN be shared with a decoder screen', () => {
  const s = src({ videoCodec: 'h265', mode: 'normalize' });
  const p = plan({ content: { kind: 'source', id: s.id }, source: s, usedByDecoder: true });
  assert.equal(p.normalizeSourceId, s.id, 'the existing transcode is reused');
  assert.equal(p.problem, undefined);
});

test('a cloud controller cannot relay a LAN camera, and says so instead of going black silently', () => {
  const s = src({ videoCodec: 'h265', mode: 'normalize' });
  const p = plan({ content: { kind: 'source', id: s.id }, source: s, relayBase: '' });
  assert.equal(p.content.type, 'off');
  assert.match(p.problem!, /H\.264|locally/, 'should suggest the actual remedies');
});

test('a problem message never leaks a stream URL (they can embed camera credentials)', () => {
  const s = src({ url: 'rtsp://admin:hunter2@cam.local/1', videoCodec: 'h265', mode: 'direct' });
  const withDecoder = plan({ content: { kind: 'source', id: s.id }, source: s, usedByDecoder: true });
  const cloud = plan({ content: { kind: 'source', id: s.id }, source: src({ url: s.url, videoCodec: 'h265', mode: 'normalize' }), relayBase: '' });
  for (const p of [withDecoder, cloud]) {
    assert.ok(p.problem);
    assert.ok(!p.problem!.includes('hunter2'), 'credentials must not appear in an admin message');
    assert.ok(!p.problem!.includes('rtsp://'), 'no stream URL in an admin message');
  }
});

// ── Screen kind ──────────────────────────────────────────────────────────────

test('a screen is only treated as a node when it is BOTH kind:node and bound', () => {
  const base = normTv({ name: 'Hall' });
  assert.equal(isNodeScreen(base), false, 'a plain screen stays on the legacy decoder path');
  assert.equal(isNodeScreen({ ...base, kind: 'node' } as Tv), false, 'kind alone is not enough');
  assert.equal(isNodeScreen({ ...base, kind: 'node', nodeId: 'node_1' } as Tv), true);
  assert.equal(isNodeScreen({ ...base, nodeId: 'node_1' } as Tv), false);
});

test('a normal screen save cannot change kind or orphan a node', () => {
  // kind/nodeId are owned by the adoption flow; a screen edit must preserve them, exactly
  // like iqamahYear/iqamahSchedule are preserved by normTimetable.
  const bound = { ...normTv({ name: 'Hall' }), kind: 'node', nodeId: 'node_1' } as Tv;
  const saved = normTv({ name: 'Renamed', kind: 'decoder', nodeId: 'node_evil' }, bound);
  assert.equal(saved.name, 'Renamed');
  assert.equal(saved.kind, 'node', 'kind came from the stored record, not the body');
  assert.equal(saved.nodeId, 'node_1', 'the binding cannot be repointed by a screen save');

  const plain = normTv({ name: 'Lobby', kind: 'node', nodeId: 'node_1' });
  assert.equal(plain.kind, undefined, 'a new screen cannot declare itself a node');
  assert.equal(plain.nodeId, undefined);
});

test('nodePlayback is normalized and videoCodec is not settable from a request body', () => {
  assert.equal(normSource({ name: 'c', url: 'rtsp://a/b' }).nodePlayback, 'auto');
  assert.equal(normSource({ name: 'c', url: 'rtsp://a/b', nodePlayback: 'nonsense' }).nodePlayback, 'auto');
  assert.equal(normSource({ name: 'c', url: 'rtsp://a/b', nodePlayback: 'always-relay' }).nodePlayback, 'always-relay');
  // Learned from a node event only — an admin (or a compromised SSO session) cannot force
  // every source to be relayed by claiming a codec.
  assert.equal(normSource({ name: 'c', url: 'rtsp://a/b', videoCodec: 'h265' }).videoCodec, '');
  const learned = { ...normSource({ name: 'c', url: 'rtsp://a/b' }), videoCodec: 'h265' };
  assert.equal(normSource({ name: 'c', url: 'rtsp://a/b' }, learned).videoCodec, 'h265', 'but it survives a save');
});

// ── Adoption address safety (SSRF) ───────────────────────────────────────────

test('adoption only accepts local addresses', () => {
  for (const ok of ['192.168.1.40', '10.0.0.5', '172.16.4.4', '169.254.9.9', '127.0.0.1', 'omd-node-1a2b.local', 'node.lan']) {
    assert.ok('origin' in nodeOrigin(ok), `${ok} should be accepted`);
  }
  for (const nope of [
    '8.8.8.8',
    'example.com',
    '169.254.169.254', // cloud metadata, denied by name even though link-local
    'metadata.google.internal',
    'admin@evil.com',
    '192.168.1.40:9999',
    'http://192.168.1.40:80/x',
    '',
    '999.1.1.1',
  ]) {
    assert.ok('error' in nodeOrigin(nope), `${nope} should be refused`);
  }
});

test('a node address is normalized to a bare http origin', () => {
  const o = nodeOrigin(' HTTP://192.168.1.40/status ');
  assert.deepEqual(o, { origin: 'http://192.168.1.40' });
});

test('the callback URL the node is given follows how the admin reached us', () => {
  assert.equal(controllerWsUrl({ host: '192.168.1.10:7860' }), 'ws://192.168.1.10:7860/ws/node');
  assert.equal(
    controllerWsUrl({ host: 'internal', 'x-forwarded-host': 'masjid.org', 'x-forwarded-proto': 'https' }),
    'wss://masjid.org/ws/node',
  );
  assert.equal(controllerWsUrl({}), '', 'no host = we cannot tell the node where to call');
});
