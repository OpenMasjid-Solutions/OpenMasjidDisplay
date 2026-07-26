// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * controller.ts — the node's side of the protocol: dial home, obey, report.
 *
 * The connection is always OUTBOUND, which is what lets a masjid put the controller in the
 * cloud and lets the node sit behind NAT with no port forward. It reconnects forever with
 * jittered backoff (see backoff.ts) — a controller that is down for a week must be
 * reconnected to unattended when it returns.
 *
 * ── The rule that keeps screens lit ──
 * A dropped controller MUST NOT change what is on the TV. When the socket closes we keep
 * rendering whatever we were told last, indefinitely, because a timetable is computed
 * locally from the clock and needs nobody. Only an explicit `set_content` changes the
 * display. Getting this wrong means every screen in the building goes blank when the
 * container restarts, which is strictly worse than the RTSP decoders we are replacing.
 */
import { WebSocket, type RawData } from 'ws';
import { makeBackoff } from './backoff';
import {
  HEARTBEAT_MS,
  NODE_AUTH_SCHEME,
  encodeFrame,
  parseControllerFrame,
  type ControllerFrame,
  type NodeCapsMsg,
  type NodeEventType,
  type NodeFrame,
  type NodeHealthMsg,
  type NodeMode,
} from '../../../packages/protocol/src/index';

export interface ControllerHandlers {
  /** Apply a command. Return an error string to NAK it, or nothing for success. */
  onCommand(frame: ControllerFrame): Promise<string | void> | string | void;
  /** Called whenever the link comes up or goes down (for logging / the status screen). */
  onLink(up: boolean, detail: string): void;
}

export interface ControllerClientOpts {
  wsUrl: string;
  token: string;
  serial: string;
  fw: string;
  model: string;
  caps: NodeCapsMsg;
  /** current mode + health, sampled at each heartbeat */
  sample(): { mode: NodeMode; health: NodeHealthMsg };
  handlers: ControllerHandlers;
  /** injectable for tests */
  now?: () => number;
  rand?: () => number;
}

export class ControllerClient {
  private ws: WebSocket | null = null;
  private readonly backoff;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: ControllerClientOpts) {
    this.backoff = makeBackoff(opts.rand ?? Math.random);
  }

  /** Begin dialling. Returns immediately; the loop runs until stop(). */
  start(): void {
    this.stopped = false;
    this.dial();
  }

  private dial(): void {
    if (this.stopped) return;
    // The serial rides in the query string as a LOOKUP KEY so the controller can verify
    // our token against one record instead of every node's (see nodeHub.ts). The token
    // itself only ever goes in the Authorization header, never the URL — URLs end up in
    // proxy logs.
    const url = `${this.opts.wsUrl}?serial=${encodeURIComponent(this.opts.serial)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { headers: { authorization: `${NODE_AUTH_SCHEME} ${this.opts.token}` } });
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : 'could not open socket');
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.backoff.reset();
      this.opts.handlers.onLink(true, 'connected');
      this.send({
        type: 'hello',
        serial: this.opts.serial,
        fw: this.opts.fw,
        model: this.opts.model,
        caps: this.opts.caps,
      });
      this.sendStatus();
      this.heartbeatTimer = setInterval(() => this.sendStatus(), HEARTBEAT_MS);
    });

    ws.on('message', (data: RawData) => void this.onMessage(data));

    ws.on('close', (code, reason) => {
      this.clearHeartbeat();
      this.scheduleReconnect(`closed (${code}${reason.length ? ` ${reason.toString('utf8').slice(0, 80)}` : ''})`);
    });

    // 'error' is always followed by 'close', so reconnect scheduling lives there only —
    // doing it in both would double the dial rate.
    ws.on('error', (err) => this.opts.handlers.onLink(false, err.message));
  }

  private async onMessage(data: RawData): Promise<void> {
    // Coerce to a string HERE, in the transport layer, so the protocol package stays
    // platform-free. `ws` can hand us a Buffer, an ArrayBuffer, or an array of fragments —
    // String() on the array form would comma-join it into garbage.
    const text = typeof data === 'string' ? data : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8');
    const parsed = parseControllerFrame(text);
    if (!parsed.ok) {
      // Do not disconnect: an unknown frame from a NEWER controller must be ignorable, or
      // upgrading the container would knock every older node offline.
      this.opts.handlers.onLink(true, `ignored an unreadable frame: ${parsed.error}`);
      return;
    }
    const frame = parsed.value;
    let error: string | void;
    try {
      error = await this.opts.handlers.onCommand(frame);
    } catch (err) {
      error = err instanceof Error ? err.message : 'command failed';
    }
    this.send(error ? { type: 'ack', cmdId: frame.cmdId, ok: false, error: String(error).slice(0, 512) } : { type: 'ack', cmdId: frame.cmdId, ok: true });
  }

  private sendStatus(): void {
    const { mode, health } = this.opts.sample();
    this.send({ type: 'status', mode, health });
  }

  /** Report something notable. Safe to call while disconnected (it is dropped). */
  event(event: NodeEventType, detail = '', extra: { sourceId?: string; codec?: string } = {}): void {
    this.send({ type: 'event', event, detail: detail.slice(0, 512), ...extra });
  }

  private send(frame: NodeFrame): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(encodeFrame(frame));
      return true;
    } catch {
      return false;
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(detail: string): void {
    this.ws = null;
    if (this.stopped) return;
    this.opts.handlers.onLink(false, detail);
    const delay = this.backoff.next();
    this.reconnectTimer = setTimeout(() => this.dial(), delay);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, 'agent stopping');
    } catch {
      /* already gone */
    }
  }
}
