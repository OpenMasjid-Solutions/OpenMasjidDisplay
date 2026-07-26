// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The wire contract's tests. These matter more than most: the controller and a node
 * are independently versioned (a masjid updates the container while its nodes keep
 * their firmware for years), so every rule encoded here is a compatibility promise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  TOKEN_HEX_LEN,
  OFFLINE_AFTER_MS,
  HEARTBEAT_MS,
  encodeFrame,
  parseNodeFrame,
  parseControllerFrame,
  parseAdoptRequest,
  parseAdoptResponse,
  parseNodeStatusResponse,
  type ControllerFrame,
  type NodeFrame,
} from './index';

const caps = { codecs: ['h264'], maxHeight: 1080, maxFps: 30 };
const doc = { id: 'tt_1', orientation: 'landscape', quality: '1080p', timezone: 'America/New_York' };

// ── Round trips ──────────────────────────────────────────────────────────────

test('every controller frame round-trips through encode → parse', () => {
  const frames: ControllerFrame[] = [
    { type: 'set_content', cmdId: 'c1', content: { type: 'timetable', doc: doc as never, assets: [] } },
    { type: 'set_content', cmdId: 'c2', content: { type: 'stream', url: 'rtsp://cam/1', transport: 'tcp', relay: false } },
    { type: 'set_content', cmdId: 'c3', content: { type: 'off' } },
    { type: 'set_content', cmdId: 'c4', content: { type: 'status_screen' } },
    { type: 'identify', cmdId: 'c5', seconds: 30 },
    { type: 'reboot', cmdId: 'c6' },
    { type: 'factory_reset', cmdId: 'c7' },
    { type: 'ping', cmdId: 'c8' },
    { type: 'update', cmdId: 'c9', version: '1.2.3', url: 'https://x/y', sha256: 'a'.repeat(64), sig: 'sig' },
  ];
  for (const f of frames) {
    const r = parseControllerFrame(encodeFrame(f));
    assert.ok(r.ok, `${f.type} should parse: ${r.ok ? '' : r.error}`);
    assert.deepEqual(r.value, f);
  }
});

test('every node frame round-trips through encode → parse', () => {
  const frames: NodeFrame[] = [
    { type: 'hello', serial: 'abc123', fw: '0.62.0', model: 'Raspberry Pi Zero 2 W', caps },
    { type: 'status', mode: 'timetable', contentRef: { kind: 'timetable', id: 'tt_1' }, health: { tempC: 48.5, memFreeMb: 210, uptimeS: 900, wifiRssi: -61, ip: '192.168.1.40' } },
    { type: 'status', mode: 'starting' },
    { type: 'event', event: 'unsupported_codec', detail: 'h265 not decodable', sourceId: 'src_9', codec: 'h265' },
    { type: 'event', event: 'stream_error', detail: '' },
    { type: 'ack', cmdId: 'c1', ok: true },
    { type: 'ack', cmdId: 'c2', ok: false, error: 'no such source' },
  ];
  for (const f of frames) {
    const r = parseNodeFrame(encodeFrame(f));
    assert.ok(r.ok, `${f.type} should parse: ${r.ok ? '' : r.error}`);
    assert.deepEqual(r.value, f);
  }
});

test('encodeFrame always stamps the protocol version', () => {
  const raw = encodeFrame({ type: 'ping', cmdId: 'x' });
  assert.equal((JSON.parse(raw) as { v: number }).v, PROTOCOL_VERSION);
});

// ── Version negotiation ──────────────────────────────────────────────────────

test('a frame from a different protocol major is rejected, not guessed at', () => {
  const future = JSON.stringify({ v: PROTOCOL_VERSION + 1, type: 'ping', cmdId: 'x' });
  const r = parseControllerFrame(future);
  assert.ok(!r.ok);
  assert.match(r.error, /unsupported protocol version/);
});

test('a frame with no version is rejected', () => {
  const r = parseControllerFrame(JSON.stringify({ type: 'ping', cmdId: 'x' }));
  assert.ok(!r.ok);
  assert.match(r.error, /missing protocol version/);
});

// ── Forward compatibility: the rule that keeps screens lit ───────────────────

test('an unknown Timetable field survives instead of blanking the screen', () => {
  // The scenario: a newer controller adds a Timetable feature; an older node must still
  // render everything it DOES understand rather than rejecting the whole document.
  const raw = encodeFrame({
    type: 'set_content',
    cmdId: 'c1',
    content: { type: 'timetable', doc: { ...doc, someFutureFeature: { enabled: true }, tickerSpeed: 7 } as never, assets: [] },
  });
  const r = parseControllerFrame(raw);
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.equal(r.value.type, 'set_content');
  const content = r.value.type === 'set_content' ? r.value.content : null;
  assert.ok(content && content.type === 'timetable');
  const passed = content.doc as unknown as Record<string, unknown>;
  assert.deepEqual(passed.someFutureFeature, { enabled: true }, 'unknown key must pass through untouched');
  assert.equal(passed.tickerSpeed, 7);
});

test('a timetable document missing an essential field IS rejected', () => {
  for (const [field, bad] of [
    ['orientation', { ...doc, orientation: 'sideways' }],
    ['quality', { ...doc, quality: '4k' }],
    ['id', { ...doc, id: '' }],
  ] as const) {
    const r = parseControllerFrame(
      encodeFrame({ type: 'set_content', cmdId: 'c1', content: { type: 'timetable', doc: bad as never, assets: [] } }),
    );
    assert.ok(!r.ok, `${field} should have been rejected`);
    assert.match(r.error, new RegExp(field), `error should name the field: ${r.ok ? '' : r.error}`);
  }
});

test('telemetry is lenient: one bad health field does not cost the heartbeat', () => {
  // Dropping heartbeats would trip the offline alarm and page a volunteer over a bad
  // sensor reading, so a nonsense temperature is discarded and the frame still lands.
  const raw = JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'status',
    mode: 'timetable',
    health: { tempC: 'hot', memFreeMb: 200, uptimeS: -5, wifiRssi: -60, ip: '10.0.0.5' },
  });
  const r = parseNodeFrame(raw);
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.ok(r.value.type === 'status');
  assert.equal(r.value.health?.tempC, undefined, 'the bad field is dropped');
  assert.equal(r.value.health?.memFreeMb, 200, 'the good fields survive');
  assert.equal(r.value.health?.uptimeS, undefined, 'out-of-range is dropped too');
  assert.equal(r.value.health?.ip, '10.0.0.5');
});

test('commands are strict: a bad scalar is rejected with a field-named error', () => {
  const r = parseControllerFrame(JSON.stringify({ v: PROTOCOL_VERSION, type: 'identify', cmdId: 'c1', seconds: 9999 }));
  assert.ok(!r.ok);
  assert.match(r.error, /seconds/);
});

test('a command with no cmdId is rejected (an ack could never be matched)', () => {
  const r = parseControllerFrame(JSON.stringify({ v: PROTOCOL_VERSION, type: 'reboot' }));
  assert.ok(!r.ok);
  assert.match(r.error, /cmdId/);
});

// ── Hostile input ────────────────────────────────────────────────────────────

test('malformed input never throws — it returns an error', () => {
  const cases: string[] = [
    '',
    'not json',
    '[]',
    'null',
    '"a string"',
    '42',
    JSON.stringify({ v: PROTOCOL_VERSION }),
    JSON.stringify({ v: PROTOCOL_VERSION, type: 'nope' }),
    JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello' }),
    JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', serial: 'a', fw: 'b', caps: {} }),
    JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', serial: 'a', fw: 'b', caps: { codecs: 'h264', maxHeight: 1, maxFps: 1 } }),
    JSON.stringify({ v: 'one', type: 'ping', cmdId: 'x' }),
  ];
  for (const raw of cases) {
    for (const parse of [parseNodeFrame, parseControllerFrame]) {
      const r = parse(raw);
      assert.ok(!r.ok, `should have rejected: ${raw.slice(0, 60)}`);
      assert.equal(typeof r.error, 'string');
      assert.ok(r.error.length > 0);
    }
  }
});

test('an oversized frame is refused before JSON.parse allocates it', () => {
  const r = parseNodeFrame('x'.repeat(MAX_FRAME_BYTES + 1));
  assert.ok(!r.ok);
  assert.match(r.error, /frame too large/);
});

test('array and string caps are enforced', () => {
  const tooManyCodecs = JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'hello',
    serial: 'a',
    fw: 'b',
    caps: { codecs: Array.from({ length: 20 }, () => 'h264'), maxHeight: 1080, maxFps: 30 },
  });
  const r = parseNodeFrame(tooManyCodecs);
  assert.ok(!r.ok);
  assert.match(r.error, /at most 8 items/);

  const tooManyAssets = encodeFrame({
    type: 'set_content',
    cmdId: 'c1',
    content: {
      type: 'timetable',
      doc: doc as never,
      assets: Array.from({ length: 65 }, (_, i) => ({ id: `a${i}`, sha256: 'b'.repeat(64), url: 'https://x' })),
    },
  });
  const r2 = parseControllerFrame(tooManyAssets);
  assert.ok(!r2.ok);
  assert.match(r2.error, /at most 64 items/);
});

test('an asset sha256 must be lowercase hex of the right length', () => {
  for (const sha of ['A'.repeat(64), 'z'.repeat(64), 'ab', 'a'.repeat(63)]) {
    const r = parseControllerFrame(
      encodeFrame({
        type: 'set_content',
        cmdId: 'c1',
        content: { type: 'timetable', doc: doc as never, assets: [{ id: 'bg', sha256: sha, url: 'https://x' }] },
      }),
    );
    assert.ok(!r.ok, `sha256 ${sha.slice(0, 8)}… should be rejected`);
    assert.match(r.error, /sha256/);
  }
});

test('codecs are normalized to lowercase so capability checks are case-safe', () => {
  const r = parseNodeFrame(
    JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', serial: 'a', fw: 'b', caps: { codecs: ['H264'], maxHeight: 1080, maxFps: 30 } }),
  );
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.ok(r.value.type === 'hello');
  assert.deepEqual(r.value.caps.codecs, ['h264']);
});

// ── Defaults ─────────────────────────────────────────────────────────────────

test('stream defaults to TCP transport and non-relay', () => {
  const r = parseControllerFrame(
    JSON.stringify({ v: PROTOCOL_VERSION, type: 'set_content', cmdId: 'c1', content: { type: 'stream', url: 'rtsp://a/b' } }),
  );
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.ok(r.value.type === 'set_content' && r.value.content.type === 'stream');
  // TCP because MediaMTX is configured tcp-only (MTX_RTSPTRANSPORTS=tcp) and TCP
  // survives the packet loss typical of masjid Wi-Fi far better than UDP.
  assert.equal(r.value.content.transport, 'tcp');
  assert.equal(r.value.content.relay, false);
});

test('timetable assets default to an empty list', () => {
  const r = parseControllerFrame(
    JSON.stringify({ v: PROTOCOL_VERSION, type: 'set_content', cmdId: 'c1', content: { type: 'timetable', doc } }),
  );
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.ok(r.value.type === 'set_content' && r.value.content.type === 'timetable');
  assert.deepEqual(r.value.content.assets, []);
});

// ── The node's local HTTP API ────────────────────────────────────────────────

test('adopt requires a ws(s) URL and a 256-bit hex token', () => {
  const good = { controllerName: 'Masjid HQ', wsUrl: 'wss://x/ws/node', nodeToken: 'a'.repeat(TOKEN_HEX_LEN) };
  assert.ok(parseAdoptRequest(good).ok);
  assert.ok(parseAdoptRequest({ ...good, wsUrl: 'ws://x/ws/node' }).ok, 'plain ws is allowed on a LAN');

  for (const [why, body] of [
    ['http scheme', { ...good, wsUrl: 'http://x' }],
    ['no scheme', { ...good, wsUrl: '/ws/node' }],
    ['short token', { ...good, nodeToken: 'ab' }],
    ['uppercase token', { ...good, nodeToken: 'A'.repeat(TOKEN_HEX_LEN) }],
    ['non-hex token', { ...good, nodeToken: 'g'.repeat(TOKEN_HEX_LEN) }],
    ['no name', { ...good, controllerName: '' }],
    ['not an object', 'nope'],
  ] as const) {
    const r = parseAdoptRequest(body);
    assert.ok(!r.ok, `${why} should be rejected`);
  }
});

test('the node status/adopt replies are validated on the controller side', () => {
  const ok = { serial: 'abc', model: 'Pi Zero 2 W', fw: '0.62.0', caps, adopted: false };
  assert.ok(parseNodeStatusResponse(ok).ok);
  assert.ok(parseAdoptResponse(ok).ok);
  // A hostile or broken node on the LAN must not be able to corrupt our record.
  assert.ok(!parseNodeStatusResponse({ ...ok, caps: { codecs: [1], maxHeight: 1080, maxFps: 30 } }).ok);
  assert.ok(!parseNodeStatusResponse({ ...ok, serial: '' }).ok);
  assert.ok(!parseAdoptResponse({ ...ok, fw: 123 }).ok);
});

// ── Constants ────────────────────────────────────────────────────────────────

test('the offline window is a multiple of the heartbeat, with slack for lost frames', () => {
  // If these ever cross, nodes flap online/offline on a single dropped heartbeat.
  assert.ok(OFFLINE_AFTER_MS >= HEARTBEAT_MS * 3, 'need room for at least two missed heartbeats');
});
