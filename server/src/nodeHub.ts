// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * nodeHub.ts — the controller's side of the Raspberry Pi node protocol.
 *
 * Nodes dial IN to `/ws/node` (always outbound from their side, so the controller can
 * live in the cloud and the node needs no inbound port or port-forward). This hub
 * authenticates each connection, tracks who is online, pushes `set_content` when a
 * screen's content changes, and surfaces heartbeats to the orchestrator.
 *
 * ── Authentication ──
 * `GET /ws/node?serial=<serial>` with `Authorization: Bearer <256-bit hex token>`.
 *
 * The serial is a LOOKUP KEY, not a credential — it identifies which node record to
 * check so we run scrypt exactly ONCE per connection attempt. Verifying the token
 * against every stored node instead would cost one scrypt per node (~100 ms each), so
 * a 20-node masjid would spend two seconds of CPU on every reconnect and a flapping
 * node could stall the event loop that drives every screen in the building.
 *
 * The token itself is verified with the same scrypt + constant-time compare as the
 * admin password (auth.ts), and only its hash is ever stored — a stolen db.json
 * cannot be used to impersonate a node.
 *
 * ── Failure posture ──
 * Everything here fails soft. A node that is offline, unauthenticated, or speaking a
 * protocol version we do not know simply does not receive content; nothing throws into
 * the reconcile loop, and no legacy decoder screen is affected in any way.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { makeLog } from './logger';
import { verifyPassword } from './auth';
import { LoginLimiter } from './rateLimit';
import type { Store } from './store';
import type { UpgradeTarget } from './ws';
import {
  NODE_WS_PATH,
  OFFLINE_AFTER_MS,
  encodeFrame,
  parseNodeFrame,
  type ControllerFrame,
  type NodeFrame,
  type SetContent,
} from '../../packages/protocol/src/index';

const log = makeLog('node-hub');

/** A live node connection. */
interface Conn {
  ws: WebSocket;
  nodeId: string;
  serial: string;
  /** epoch ms of the last frame we received (any frame counts as liveness) */
  lastSeen: number;
  /** JSON of the last content we sent, so we only push on an actual change */
  sentContent: string | null;
  /** monotonic counter for cmdIds on this connection */
  seq: number;
}

/** What the hub reports about a node, for the orchestrator and the panel. */
export interface NodeLiveState {
  nodeId: string;
  connected: boolean;
  /** true when connected AND the last frame is recent enough to trust */
  fresh: boolean;
  lastSeen: number;
}

export interface NodeEventSink {
  /** A node reported it cannot decode a stream — the caller arranges a relay. */
  onUnsupportedCodec(nodeId: string, sourceId: string | undefined, codec: string | undefined): void;
  /** Anything worth telling the masjid about. */
  onNotify(p: { title?: string; text: string; level?: 'info' | 'success' | 'warning' | 'error' }): void;
  /** A node's state changed in a way the panel should see (connect/disconnect/health). */
  onChanged(): void;
}

export class NodeHub implements UpgradeTarget {
  private readonly wss = new WebSocketServer({ noServer: true });

  /**
   * `/ws/node`, optionally behind a single-segment tunnel prefix (e.g.
   * `/display/ws/node`). The OpenMasjidOS remote-access tunnel serves the app under its
   * app id, and that prefixed origin is exactly what a cloud-hosted controller hands a
   * node to dial — so without this a node adopted through the tunnel could never connect.
   * Same shape as the widget and volunteer prefix handling in api.ts.
   */
  matches(path: string): boolean {
    return new RegExp(`^(?:/[a-z0-9-]+)?${NODE_WS_PATH}$`).test(path);
  }
  /** nodeId → connection. One connection per node; a reconnect replaces the old one. */
  private readonly conns = new Map<string, Conn>();
  /** Blunts scrypt-grinding on the upgrade path (a 256-bit token is not guessable, but
   *  we still refuse to burn CPU for an attacker). Shares the admin login's algorithm. */
  private readonly limiter = new LoginLimiter();

  constructor(
    private readonly store: Store,
    private readonly sink: NodeEventSink,
  ) {}

  // ── Connection lifecycle ───────────────────────────────────────────────────

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // The feature is behind a setting; when off, the endpoint does not exist at all.
    if (!this.store.db.settings.piNodes) {
      socket.destroy();
      return;
    }
    const wait = this.limiter.retryAfterMs(req);
    if (wait > 0) {
      socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${Math.ceil(wait / 1000)}\r\n\r\n`);
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const serial = (url.searchParams.get('serial') ?? '').slice(0, 64);
    const token = bearer(req.headers.authorization);
    const node = serial ? this.store.db.nodes?.find((n) => n.serial === serial) : undefined;

    // One scrypt verify, only when we have both a known serial and a well-formed token.
    const ok = !!node && !!token && verifyPassword(token, { hash: node.tokenHash, salt: node.tokenSalt });
    if (!ok) {
      this.limiter.fail(req);
      log.warn(`rejected node upgrade for serial "${serial || '(none)'}" from ${req.socket.remoteAddress}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this.limiter.succeed(req);
    const adopted = node;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, adopted.id, adopted.serial, req));
  }

  private accept(ws: WebSocket, nodeId: string, serial: string, req: IncomingMessage): void {
    // A reconnect supersedes any stale connection for the same node.
    const prev = this.conns.get(nodeId);
    if (prev && prev.ws !== ws) {
      try {
        prev.ws.close(1000, 'superseded');
      } catch {
        /* already gone */
      }
    }
    const conn: Conn = { ws, nodeId, serial, lastSeen: Date.now(), sentContent: null, seq: 0 };
    this.conns.set(nodeId, conn);

    const ip = req.socket.remoteAddress ?? '';
    this.store.update((db) => {
      const n = db.nodes?.find((x) => x.id === nodeId);
      if (n) {
        n.lastSeen = conn.lastSeen;
        if (ip) n.ip = ip.replace(/^::ffff:/, '');
      }
    });
    log.info(`node "${serial}" connected`);

    ws.on('message', (data: RawData) => this.onMessage(conn, data));
    ws.on('close', () => {
      // Only forget the connection if it is still the current one (a fast reconnect may
      // already have replaced it; clearing then would drop a live node).
      if (this.conns.get(nodeId) === conn) {
        this.conns.delete(nodeId);
        log.info(`node "${serial}" disconnected`);
        this.sink.onChanged();
      }
    });
    ws.on('error', (err) => log.debug(`node "${serial}" socket error: ${err.message}`));
    this.sink.onChanged();
  }

  /**
   * Coerce a `ws` frame to a string here, in the transport layer, so the protocol
   * package stays platform-free. `ws` hands us Buffer | ArrayBuffer | Buffer[] —
   * `String(fragments)` on the array form would comma-join it into garbage.
   */
  private static text(data: RawData): string {
    if (typeof data === 'string') return data;
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    return Buffer.from(data as ArrayBuffer).toString('utf8');
  }

  private onMessage(conn: Conn, data: RawData): void {
    conn.lastSeen = Date.now();
    const parsed = parseNodeFrame(NodeHub.text(data));
    if (!parsed.ok) {
      log.warn(`node "${conn.serial}" sent an invalid frame: ${parsed.error}`);
      return;
    }
    const frame = parsed.value;
    switch (frame.type) {
      case 'hello':
        this.onHello(conn, frame);
        break;
      case 'status':
        this.onStatus(conn, frame);
        break;
      case 'event':
        this.onEvent(conn, frame);
        break;
      case 'ack':
        if (!frame.ok) log.warn(`node "${conn.serial}" rejected ${frame.cmdId}: ${frame.error ?? 'no reason given'}`);
        break;
    }
  }

  private onHello(conn: Conn, frame: Extract<NodeFrame, { type: 'hello' }>): void {
    if (frame.serial !== conn.serial) {
      // The serial is bound at authentication; a mismatch means a misconfigured or
      // hostile agent. Refuse rather than letting it write over another node's record.
      log.warn(`node "${conn.serial}" said hello as "${frame.serial}" — closing`);
      try {
        conn.ws.close(1008, 'serial mismatch');
      } catch {
        /* ignore */
      }
      return;
    }
    this.store.update((db) => {
      const n = db.nodes?.find((x) => x.id === conn.nodeId);
      if (!n) return;
      n.fw = frame.fw;
      n.model = frame.model || n.model;
      n.caps = frame.caps;
      n.lastSeen = conn.lastSeen;
    });
    // A reconnecting node has forgotten what it was showing, so make the next reconcile
    // re-push its content instead of assuming the old value still holds.
    conn.sentContent = null;
    this.sink.onChanged();
  }

  private onStatus(conn: Conn, frame: Extract<NodeFrame, { type: 'status' }>): void {
    this.store.update((db) => {
      const n = db.nodes?.find((x) => x.id === conn.nodeId);
      if (!n) return;
      n.lastSeen = conn.lastSeen;
      if (frame.health) n.health = frame.health;
      if (frame.health?.ip) n.ip = frame.health.ip;
    });
    this.sink.onChanged();
  }

  private onEvent(conn: Conn, frame: Extract<NodeFrame, { type: 'event' }>): void {
    const name = this.nodeName(conn.nodeId);
    // `detail` is capped and credential-free by contract (the agent never logs stream
    // URLs), but it is still remote text — keep it short in anything user-visible.
    const detail = frame.detail.slice(0, 200);
    log.info(`node "${conn.serial}" event ${frame.event}${detail ? `: ${detail}` : ''}`);
    switch (frame.event) {
      case 'unsupported_codec':
        this.sink.onUnsupportedCodec(conn.nodeId, frame.sourceId, frame.codec);
        break;
      case 'stream_error':
        this.sink.onNotify({
          title: 'Screen stream problem',
          text: `📺 "${name}" could not play its video source${detail ? ` — ${detail}` : ''}.`,
          level: 'warning',
        });
        break;
      case 'network_fallback_ap':
        this.sink.onNotify({
          title: 'Screen lost Wi-Fi',
          text: `📶 "${name}" could not reach the network and re-opened its setup Wi-Fi.`,
          level: 'warning',
        });
        break;
      // The rest are informational: logged above, no alert (they self-heal).
      case 'asset_fetch_failed':
      case 'process_restarted':
      case 'clock_unsynced':
        break;
    }
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  /** A command id unique per connection, so an `ack` maps to exactly one command. */
  private nextCmdId(conn: Conn): string {
    conn.seq += 1;
    return `${conn.nodeId}-${conn.seq}`;
  }

  // Takes a COMPLETE frame rather than `Omit<ControllerFrame,'cmdId'>`: Omit over a union
  // collapses it to the keys common to every member, which would silently drop `content`
  // and `seconds`. Call sites build the frame with nextCmdId().
  private send(conn: Conn, frame: ControllerFrame): boolean {
    if (conn.ws.readyState !== WebSocket.OPEN) return false;
    try {
      conn.ws.send(encodeFrame(frame));
      return true;
    } catch (err) {
      log.warn(`could not send ${frame.type} to "${conn.serial}": ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /**
   * Push content to a node, but only when it differs from what we last sent it.
   *
   * The orchestrator calls this every reconcile (every 15 s), so without the diff a
   * masjid's screens would be told to re-render four times a minute forever — which on
   * a timetable means tearing down and relaunching the kiosk browser. Returns true if
   * something was actually sent.
   */
  setContent(nodeId: string, content: SetContent): boolean {
    const conn = this.conns.get(nodeId);
    if (!conn) return false;
    const key = JSON.stringify(content);
    if (conn.sentContent === key) return false;
    if (!this.send(conn, { type: 'set_content', cmdId: this.nextCmdId(conn), content })) return false;
    conn.sentContent = key;
    log.debug(`pushed ${content.type} to "${conn.serial}"`);
    return true;
  }

  /** Flash the node's identity on its screen so an admin can find that TV. */
  identify(nodeId: string, seconds: number): boolean {
    const conn = this.conns.get(nodeId);
    return conn ? this.send(conn, { type: 'identify', cmdId: this.nextCmdId(conn), seconds }) : false;
  }

  reboot(nodeId: string): boolean {
    const conn = this.conns.get(nodeId);
    return conn ? this.send(conn, { type: 'reboot', cmdId: this.nextCmdId(conn) }) : false;
  }

  /**
   * Tell a node to wipe its state and go back to unadopted. Best-effort by design: an
   * offline node cannot be reset, which is why the physical factory-reset paths exist
   * (a `factory-reset` file on the boot partition, or GPIO21 held low at boot).
   */
  factoryReset(nodeId: string): boolean {
    const conn = this.conns.get(nodeId);
    if (!conn) return false;
    const sent = this.send(conn, { type: 'factory_reset', cmdId: this.nextCmdId(conn) });
    // Drop it either way — the record is about to disappear from the store.
    try {
      conn.ws.close(1000, 'un-adopted');
    } catch {
      /* ignore */
    }
    this.conns.delete(nodeId);
    return sent;
  }

  // ── Observation ────────────────────────────────────────────────────────────

  /** Is this node connected AND heartbeating recently enough to trust? */
  isFresh(nodeId: string, now = Date.now()): boolean {
    const conn = this.conns.get(nodeId);
    return !!conn && conn.ws.readyState === WebSocket.OPEN && now - conn.lastSeen < OFFLINE_AFTER_MS;
  }

  liveStates(now = Date.now()): NodeLiveState[] {
    return (this.store.db.nodes ?? []).map((n) => {
      const conn = this.conns.get(n.id);
      return {
        nodeId: n.id,
        connected: !!conn && conn.ws.readyState === WebSocket.OPEN,
        fresh: this.isFresh(n.id, now),
        lastSeen: conn?.lastSeen ?? n.lastSeen,
      };
    });
  }

  /** Close every connection (shutdown). */
  stopAll(): void {
    for (const conn of this.conns.values()) {
      try {
        conn.ws.close(1001, 'controller shutting down');
      } catch {
        /* ignore */
      }
    }
    this.conns.clear();
  }

  private nodeName(nodeId: string): string {
    const n = this.store.db.nodes?.find((x) => x.id === nodeId);
    const screen = n?.screenId ? this.store.db.tvs.find((t) => t.id === n.screenId) : undefined;
    return (screen?.name || n?.name || 'Screen').slice(0, 60);
  }
}

/** Extract a bearer token, or '' if the header is missing/!bearer/malformed. */
function bearer(header: string | undefined): string {
  if (!header) return '';
  const m = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(header.trim());
  return m ? m[1] : '';
}

/** A fresh 256-bit adoption token, hex. Only the hash of this is ever stored. */
export function newNodeToken(): string {
  return crypto.randomBytes(32).toString('hex');
}
