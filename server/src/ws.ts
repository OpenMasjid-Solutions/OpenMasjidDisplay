// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** WebSocket hub that pushes live status to connected control panels. */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { makeLog } from './logger';

const log = makeLog('ws');

/**
 * One WebSocket endpoint. Registered with `routeUpgrades` rather than attaching its
 * own `upgrade` listener — see the note there for why that matters.
 */
export interface UpgradeTarget {
  /** does this endpoint own that pathname? */
  matches(path: string): boolean;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

/**
 * Dispatch HTTP upgrades to whichever endpoint owns the path, and destroy the socket
 * when nothing does.
 *
 * There is exactly ONE `upgrade` listener for the server, deliberately. Node calls
 * every registered listener for every upgrade, so if each hub attached its own and
 * destroyed sockets for paths it did not recognise, adding a second endpoint would
 * make the first tear down the second's connections (whichever ran first won). That
 * bug is invisible until the day you add the second endpoint — which is exactly what
 * the Pi node hub does.
 */
export function routeUpgrades(server: Server, targets: readonly UpgradeTarget[]): void {
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    const target = targets.find((t) => t.matches(path));
    if (!target) {
      socket.destroy();
      return;
    }
    target.handleUpgrade(req, socket, head);
  });
}

/** Live status for the control panel(s). */
export class WsHub implements UpgradeTarget {
  private readonly wss: WebSocketServer;

  matches(path: string): boolean {
    return path === '/ws';
  }

  constructor(private readonly authed: (req: IncomingMessage) => boolean) {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', () => log.debug('control panel connected'));
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.authed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  broadcast(type: string, data: unknown): void {
    const msg = JSON.stringify({ type, data });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(msg);
        } catch {
          /* dropped */
        }
      }
    }
  }
}
