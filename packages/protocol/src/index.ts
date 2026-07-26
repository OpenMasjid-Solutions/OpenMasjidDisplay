// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * @openmasjid/protocol — the wire contract between the controller and a Raspberry Pi
 * display node, validated on BOTH ends by the same code.
 *
 * Shape: the node dials the controller (always outbound, so the controller may be
 * cloud-hosted and the node needs no inbound port), authenticates with its adoption
 * token, then the two exchange JSON frames over WSS. Every frame is a tagged union on
 * `type`, inside an envelope carrying the protocol version `v`.
 *
 * ── Why validate at all, when both ends ship from this repo? ──
 * They do NOT ship together. A masjid updates the container from the App Store while
 * its nodes run whatever firmware they were flashed with, possibly for years. The two
 * sides are independently versioned, so each must treat the other's frames as
 * untrusted input.
 *
 * ── DEVIATION FROM PI_NODE_SPEC.md §5/§10: hand-written, not zod ──
 * The spec calls for zod schemas. Implemented without it, deliberately. `zod` imported
 * from `packages/…` cannot resolve: Node module resolution walks up from the importing
 * FILE, so it never reaches `server/node_modules`. Fixing that needs either npm
 * workspaces at a new repo root or a per-package install — and both change how the
 * Dockerfile installs dependencies, which cannot be verified on this dev box (no local
 * Docker; see the release notes in docs/PI_NODE_SPEC.md §6). Hand-rolled validators
 * deliver the same guarantee — shared, typed, validated on both ends — with zero new
 * runtime dependencies, no container change, and the same idiom the server already uses
 * in `server/src/validate.ts`. If workspaces land later, swapping this file for zod is
 * a self-contained change: the exported surface below is the contract.
 *
 * ── The forward-compatibility rule (read before adding a field) ──
 * COMMANDS are validated strictly: a malformed `identify` is a bug we want surfaced as
 * `ack{ok:false}`. TELEMETRY is validated leniently — a weird `health.tempC` drops that
 * one field rather than the whole heartbeat, because discarding heartbeats would trip
 * the offline alarm and page a volunteer over a bad sensor reading. The timetable
 * DOCUMENT keeps unknown keys: if a newer controller adds a Timetable field, a strict
 * older node would reject the document and blank a masjid's screen over a field it does
 * not even render. Never make `timetableDoc` strict.
 */
import type { Timetable } from '../../render-core/src/types';

/**
 * Wire protocol version. Bump ONLY for a breaking frame change; additive optional
 * fields do not need it. Each side rejects a version it does not implement, so a
 * mismatched node is disabled loudly rather than misinterpreted silently.
 */
export const PROTOCOL_VERSION = 1;

/** WebSocket path the node dials on the controller. */
export const NODE_WS_PATH = '/ws/node';
/** Bearer scheme for the WSS upgrade and for the node's own local API. */
export const NODE_AUTH_SCHEME = 'Bearer';

/** How often a healthy node sends `status`. */
export const HEARTBEAT_MS = 15_000;
/**
 * How long without a frame before a node counts as offline. Matches the decoder
 * screens' existing ~90 s debounce so both screen kinds alert on the same footing, and
 * so a couple of heartbeats lost to flaky masjid Wi-Fi are not an incident.
 */
export const OFFLINE_AFTER_MS = 90_000;

/** The adoption token is 256 bits, lowercase hex. */
export const TOKEN_HEX_LEN = 64;

/**
 * Cap on a single frame, applied before JSON.parse. A timetable document with a long
 * ticker and 64 asset refs is a few KB; 256 KB is generous and still bounds what a
 * misbehaving peer can make the other side allocate.
 */
export const MAX_FRAME_BYTES = 256 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Types (hand-written so the wire shape is readable in one place)
// ─────────────────────────────────────────────────────────────────────────────

/** What a screen is showing — mirrors the controller's ContentRef. */
export interface ContentRefMsg {
  kind: 'timetable' | 'source' | 'off';
  id?: string;
}

/** Hardware decode capabilities, reported in `hello`; decides direct vs relay. */
export interface NodeCapsMsg {
  /** lowercased codec names the node decodes in HARDWARE, e.g. ['h264'] */
  codecs: string[];
  maxHeight: number;
  maxFps: number;
}

/** Periodic health, purely informational (shown in the panel's node drawer). */
export interface NodeHealthMsg {
  tempC?: number;
  memFreeMb?: number;
  uptimeS?: number;
  wifiRssi?: number;
  ip?: string;
}

/** What the node is currently doing. */
export type NodeMode = 'timetable' | 'stream' | 'off' | 'status_screen' | 'starting';

/** An asset the node fetches and caches by hash (background photo, masjid logo). */
export interface AssetRef {
  /** stable key the document refers to: 'bg' | 'logo' | an announcement filename */
  id: string;
  /** sha256 of the bytes, lowercase hex — the cache key, so a re-fetch is skippable */
  sha256: string;
  /** URL on the controller; fetched with the node's bearer token */
  url: string;
}

/**
 * The input switch. Four variants:
 *  • timetable     — render locally, indefinitely, offline-tolerant. No video on the wire.
 *  • stream        — play an RTSP URL. `relay` marks a controller-transcoded URL so the
 *                    panel can badge it; the node treats both identically.
 *  • off           — blank the output (DPMS off).
 *  • status_screen — the diagnostic page (IP, serial, firmware, adoption state).
 */
export type SetContent =
  | { type: 'timetable'; doc: Timetable; assets: AssetRef[] }
  | { type: 'stream'; url: string; transport: 'tcp' | 'udp'; relay: boolean }
  | { type: 'off' }
  | { type: 'status_screen' };

/** Controller → node. Every command carries `cmdId` so an `ack` can be matched to it. */
export type ControllerFrame =
  | { type: 'set_content'; cmdId: string; content: SetContent }
  /** Flash the node's identity big on screen so an admin can tell which TV it is. */
  | { type: 'identify'; cmdId: string; seconds: number }
  | { type: 'reboot'; cmdId: string }
  /**
   * Agent self-update (M3). `sig` is an ed25519 signature over `sha256`; the node
   * verifies BOTH before swapping the binary, so a compromised controller still cannot
   * push arbitrary code onto a masjid's hardware.
   */
  | { type: 'update'; cmdId: string; version: string; url: string; sha256: string; sig: string }
  /** Un-adopt: wipe /data and return to the unadopted state (the panel's "Remove"). */
  | { type: 'factory_reset'; cmdId: string }
  | { type: 'ping'; cmdId: string };

/** Things worth telling the controller about, none of them fatal. */
export type NodeEventType =
  /** the RTSP pipeline failed or dropped */
  | 'stream_error'
  /** the node cannot hardware-decode this stream — triggers the relay fallback */
  | 'unsupported_codec'
  /** an asset could not be fetched; rendering continues without it */
  | 'asset_fetch_failed'
  /** the kiosk or player process crashed and was restarted */
  | 'process_restarted'
  /** the clock is not NTP-synced yet, so prayer times are being withheld */
  | 'clock_unsynced'
  /** the node re-opened its Wi-Fi setup AP after losing every known network */
  | 'network_fallback_ap';

/** Node → controller. */
export type NodeFrame =
  /** First frame after every connect. The controller keys off `serial`. */
  | { type: 'hello'; serial: string; fw: string; model: string; caps: NodeCapsMsg }
  | { type: 'status'; mode: NodeMode; contentRef?: ContentRefMsg; health?: NodeHealthMsg }
  | {
      type: 'event';
      event: NodeEventType;
      /** free-text context for the log/alert; never contains stream credentials */
      detail: string;
      /** the source id the event concerns, when it is about a stream */
      sourceId?: string;
      /** the offending codec for `unsupported_codec`, lowercased (e.g. 'h265') */
      codec?: string;
    }
  | { type: 'ack'; cmdId: string; ok: boolean; error?: string };

/** `GET /api/status` on the node — the only endpoint open before adoption. */
export interface NodeStatusResponse {
  serial: string;
  model: string;
  fw: string;
  caps: NodeCapsMsg;
  adopted: boolean;
  /** name of the controller that adopted it, for the on-screen status page */
  controllerName?: string;
  ip?: string;
}

/**
 * `POST /api/adopt` on the node — one-time pairing, from the controller.
 *
 * `wsUrl` is where the node dials home forever after, so the controller sends its own
 * externally-reachable origin (which is how a cloud-hosted controller works at all).
 * The node persists it verbatim.
 */
export interface AdoptRequest {
  controllerName: string;
  wsUrl: string;
  nodeToken: string;
}

/** The node's reply to a successful adoption — its identity, for the controller's record. */
export interface AdoptResponse {
  serial: string;
  model: string;
  fw: string;
  caps: NodeCapsMsg;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Validation primitives
//
// Same shape as server/src/validate.ts, with one difference: that module CLAMPS
// untrusted admin input into a valid object, while this one REJECTS malformed frames.
// A clamped command would silently do something the sender did not ask for; on a wire
// between independently-updated peers we want a precise `ack{ok:false}` instead.
// ─────────────────────────────────────────────────────────────────────────────

class Invalid extends Error {
  constructor(readonly at: string, msg: string) {
    super(`${at}: ${msg}`);
  }
}
const bad = (at: string, msg: string): never => {
  throw new Invalid(at, msg);
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function obj(v: unknown, at: string): Record<string, unknown> {
  return isObj(v) ? v : bad(at, 'expected an object');
}

function str(v: unknown, at: string, max: number, min = 0): string {
  if (typeof v !== 'string') return bad(at, 'expected a string');
  if (v.length < min) return bad(at, `must be at least ${min} character(s)`);
  if (v.length > max) return bad(at, `must be at most ${max} characters`);
  return v;
}

function int(v: unknown, at: string, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    return bad(at, 'expected an integer');
  }
  if (v < lo || v > hi) return bad(at, `must be between ${lo} and ${hi}`);
  return v;
}

function bool(v: unknown, at: string, def: boolean): boolean {
  if (v === undefined) return def;
  return typeof v === 'boolean' ? v : bad(at, 'expected a boolean');
}

function oneOf<const T extends readonly string[]>(v: unknown, at: string, allowed: T): T[number] {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v)
    ? (v as T[number])
    : bad(at, `expected one of ${allowed.join(' | ')}`);
}

function arr(v: unknown, at: string, max: number): unknown[] {
  if (!Array.isArray(v)) return bad(at, 'expected an array');
  if (v.length > max) return bad(at, `must have at most ${max} items`);
  return v;
}

const HEX64 = /^[0-9a-f]{64}$/;
function hex64(v: unknown, at: string): string {
  const s = str(v, at, 64, 64);
  return HEX64.test(s) ? s : bad(at, 'expected 64 lowercase hex characters');
}

/** Lenient: return the value if it is a number in range, else undefined. Used for
 *  telemetry, where one bad field must not cost us the whole heartbeat. */
function softNum(v: unknown, lo: number, hi: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined;
}
/** Lenient counterpart of `str` for telemetry. */
function softStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length <= max ? v : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Field parsers
// ─────────────────────────────────────────────────────────────────────────────

export function parseNodeCaps(v: unknown, at = 'caps'): NodeCapsMsg {
  const o = obj(v, at);
  return {
    codecs: arr(o.codecs, `${at}.codecs`, 8).map((c, i) => str(c, `${at}.codecs[${i}]`, 16, 1).toLowerCase()),
    maxHeight: int(o.maxHeight, `${at}.maxHeight`, 1, 4320),
    maxFps: int(o.maxFps, `${at}.maxFps`, 1, 240),
  };
}

function parseContentRef(v: unknown, at: string): ContentRefMsg {
  const o = obj(v, at);
  const kind = oneOf(o.kind, `${at}.kind`, ['timetable', 'source', 'off'] as const);
  const id = o.id === undefined ? undefined : str(o.id, `${at}.id`, 64);
  return id === undefined ? { kind } : { kind, id };
}

/** Lenient by design — see the forward-compatibility rule in the header. */
function parseHealth(v: unknown): NodeHealthMsg | undefined {
  if (!isObj(v)) return undefined;
  const h: NodeHealthMsg = {};
  const tempC = softNum(v.tempC, -50, 150);
  if (tempC !== undefined) h.tempC = tempC;
  const memFreeMb = softNum(v.memFreeMb, 0, 1_048_576);
  if (memFreeMb !== undefined) h.memFreeMb = Math.floor(memFreeMb);
  const uptimeS = softNum(v.uptimeS, 0, Number.MAX_SAFE_INTEGER);
  if (uptimeS !== undefined) h.uptimeS = Math.floor(uptimeS);
  const wifiRssi = softNum(v.wifiRssi, -120, 0);
  if (wifiRssi !== undefined) h.wifiRssi = Math.round(wifiRssi);
  const ip = softStr(v.ip, 64);
  if (ip !== undefined) h.ip = ip;
  return h;
}

function parseAssetRef(v: unknown, at: string): AssetRef {
  const o = obj(v, at);
  return {
    id: str(o.id, `${at}.id`, 128, 1),
    sha256: hex64(o.sha256, `${at}.sha256`),
    url: str(o.url, `${at}.url`, 2048, 1),
  };
}

/**
 * The timetable document. Keeps unknown keys (see the header): only the handful of
 * fields without which the kiosk cannot lay out a screen at all are required, and the
 * rest rides along untouched for render-core — the single source of truth for what a
 * Timetable means. Safe in the direction that matters: the controller only ever sends a
 * store-normalized Timetable, and both ends render it with the same render-core.
 */
function parseTimetableDoc(v: unknown, at: string): Timetable {
  const o = obj(v, at);
  str(o.id, `${at}.id`, 64, 1);
  oneOf(o.orientation, `${at}.orientation`, ['landscape', 'portrait'] as const);
  oneOf(o.quality, `${at}.quality`, ['720p', '1080p'] as const);
  str(o.timezone, `${at}.timezone`, 64);
  return o as unknown as Timetable;
}

function parseSetContent(v: unknown, at: string): SetContent {
  const o = obj(v, at);
  const type = oneOf(o.type, `${at}.type`, ['timetable', 'stream', 'off', 'status_screen'] as const);
  switch (type) {
    case 'timetable':
      return {
        type,
        doc: parseTimetableDoc(o.doc, `${at}.doc`),
        assets: (o.assets === undefined ? [] : arr(o.assets, `${at}.assets`, 64)).map((a, i) =>
          parseAssetRef(a, `${at}.assets[${i}]`),
        ),
      };
    case 'stream':
      return {
        type,
        url: str(o.url, `${at}.url`, 2048, 1),
        transport: o.transport === undefined ? 'tcp' : oneOf(o.transport, `${at}.transport`, ['tcp', 'udp'] as const),
        relay: bool(o.relay, `${at}.relay`, false),
      };
    case 'off':
    case 'status_screen':
      return { type };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame parsing
// ─────────────────────────────────────────────────────────────────────────────

const NODE_EVENTS = [
  'stream_error',
  'unsupported_codec',
  'asset_fetch_failed',
  'process_restarted',
  'clock_unsynced',
  'network_fallback_ap',
] as const;

const NODE_MODES = ['timetable', 'stream', 'off', 'status_screen', 'starting'] as const;

function readNodeFrame(v: unknown): NodeFrame {
  const o = obj(v, 'frame');
  const type = oneOf(o.type, 'frame.type', ['hello', 'status', 'event', 'ack'] as const);
  switch (type) {
    case 'hello':
      return {
        type,
        serial: str(o.serial, 'serial', 64, 1),
        fw: str(o.fw, 'fw', 32, 1),
        model: o.model === undefined ? '' : str(o.model, 'model', 64),
        caps: parseNodeCaps(o.caps),
      };
    case 'status':
      return {
        type,
        mode: oneOf(o.mode, 'mode', NODE_MODES),
        ...(o.contentRef === undefined ? {} : { contentRef: parseContentRef(o.contentRef, 'contentRef') }),
        ...(o.health === undefined ? {} : { health: parseHealth(o.health) }),
      };
    case 'event': {
      const frame: NodeFrame = {
        type,
        event: oneOf(o.event, 'event', NODE_EVENTS),
        detail: o.detail === undefined ? '' : str(o.detail, 'detail', 512),
      };
      if (o.sourceId !== undefined) frame.sourceId = str(o.sourceId, 'sourceId', 64);
      if (o.codec !== undefined) frame.codec = str(o.codec, 'codec', 16).toLowerCase();
      return frame;
    }
    case 'ack': {
      const frame: NodeFrame = {
        type,
        cmdId: str(o.cmdId, 'cmdId', 64, 1),
        ok: bool(o.ok, 'ok', false),
      };
      if (o.error !== undefined) frame.error = str(o.error, 'error', 512);
      return frame;
    }
  }
}

function readControllerFrame(v: unknown): ControllerFrame {
  const o = obj(v, 'frame');
  const type = oneOf(o.type, 'frame.type', [
    'set_content',
    'identify',
    'reboot',
    'update',
    'factory_reset',
    'ping',
  ] as const);
  const cmdId = str(o.cmdId, 'cmdId', 64, 1);
  switch (type) {
    case 'set_content':
      return { type, cmdId, content: parseSetContent(o.content, 'content') };
    case 'identify':
      return { type, cmdId, seconds: int(o.seconds, 'seconds', 1, 300) };
    case 'reboot':
    case 'factory_reset':
    case 'ping':
      return { type, cmdId };
    case 'update':
      return {
        type,
        cmdId,
        version: str(o.version, 'version', 32, 1),
        url: str(o.url, 'url', 2048, 1),
        sha256: hex64(o.sha256, 'sha256'),
        sig: str(o.sig, 'sig', 512, 1),
      };
  }
}

/**
 * Decode a raw frame of one direction.
 *
 * Never throws — every failure is a returned string, because the caller's only sane
 * response to a malformed frame is to log it and carry on, not to crash the process
 * that is driving every screen in the building.
 */
function decode<T>(raw: string, read: (v: unknown) => T): ParseResult<T> {
  if (typeof raw !== 'string') return { ok: false, error: 'expected a string frame' };
  if (raw.length > MAX_FRAME_BYTES) return { ok: false, error: `frame too large (${raw.length} bytes)` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  if (!isObj(parsed)) return { ok: false, error: 'frame must be a JSON object' };
  if (typeof parsed.v !== 'number' || !Number.isInteger(parsed.v)) {
    return { ok: false, error: 'missing protocol version `v`' };
  }
  if (parsed.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `unsupported protocol version ${parsed.v} (this build speaks ${PROTOCOL_VERSION})`,
    };
  }
  try {
    return { ok: true, value: read(parsed) };
  } catch (err) {
    return { ok: false, error: err instanceof Invalid ? err.message : 'invalid frame' };
  }
}

/** Controller side: decode something a node sent us. */
export const parseNodeFrame = (raw: string): ParseResult<NodeFrame> => decode(raw, readNodeFrame);

/** Node side: decode something the controller sent us. */
export const parseControllerFrame = (raw: string): ParseResult<ControllerFrame> => decode(raw, readControllerFrame);

/** Serialize a frame with its envelope. Use this instead of JSON.stringify by hand so
 *  `v` can never be forgotten — a frame without it is rejected by the other end. */
export function encodeFrame(frame: NodeFrame | ControllerFrame): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...frame });
}

// ─────────────────────────────────────────────────────────────────────────────
// The node's local HTTP API
// ─────────────────────────────────────────────────────────────────────────────

/** Validate an inbound `POST /api/adopt` body (node side). */
export function parseAdoptRequest(v: unknown): ParseResult<AdoptRequest> {
  try {
    const o = obj(v, 'body');
    const wsUrl = str(o.wsUrl, 'wsUrl', 2048, 1);
    if (!/^wss?:\/\//i.test(wsUrl)) return { ok: false, error: 'wsUrl: must start with ws:// or wss://' };
    const nodeToken = str(o.nodeToken, 'nodeToken', TOKEN_HEX_LEN, TOKEN_HEX_LEN);
    if (!/^[0-9a-f]+$/.test(nodeToken)) return { ok: false, error: 'nodeToken: must be lowercase hex' };
    return {
      ok: true,
      value: { controllerName: str(o.controllerName, 'controllerName', 64, 1), wsUrl, nodeToken },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Invalid ? err.message : 'invalid body' };
  }
}

/** Validate a node's reply to adoption (controller side). */
export function parseAdoptResponse(v: unknown): ParseResult<AdoptResponse> {
  try {
    const o = obj(v, 'body');
    return {
      ok: true,
      value: {
        serial: str(o.serial, 'serial', 64, 1),
        model: o.model === undefined ? '' : str(o.model, 'model', 64),
        fw: str(o.fw, 'fw', 32, 1),
        caps: parseNodeCaps(o.caps),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Invalid ? err.message : 'invalid body' };
  }
}

/** Validate a node's `GET /api/status` reply (controller side, during discovery). */
export function parseNodeStatusResponse(v: unknown): ParseResult<NodeStatusResponse> {
  try {
    const o = obj(v, 'body');
    const value: NodeStatusResponse = {
      serial: str(o.serial, 'serial', 64, 1),
      model: o.model === undefined ? '' : str(o.model, 'model', 64),
      fw: str(o.fw, 'fw', 32, 1),
      caps: parseNodeCaps(o.caps),
      adopted: bool(o.adopted, 'adopted', false),
    };
    if (o.controllerName !== undefined) value.controllerName = str(o.controllerName, 'controllerName', 64);
    if (o.ip !== undefined) value.ip = str(o.ip, 'ip', 64);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Invalid ? err.message : 'invalid body' };
  }
}
