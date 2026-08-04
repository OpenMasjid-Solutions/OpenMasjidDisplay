// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** WebSocket hub that pushes live status to connected control panels. */
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { makeLog } from './logger';

const log = makeLog('ws');

export class WsHub {
  private readonly wss: WebSocketServer;

  constructor(server: Server, authed: (req: IncomingMessage) => boolean) {
    this.wss = new WebSocketServer({ noServer: true });
    // Defence in depth: an exception thrown in an 'upgrade' listener is an UNCAUGHT
    // exception (there is no surrounding try/catch as there is on the HTTP path), so it
    // kills the process. That made a single malformed cookie an unauthenticated remote
    // kill switch for every screen. The root cause is fixed in auth.ts, but this handler
    // must never be the reason the app dies — drop the socket and stay up instead.
    server.on('upgrade', (req, socket, head) => {
      try {
        const path = (req.url ?? '').split('?')[0];
        if (path !== '/ws') {
          socket.destroy();
          return;
        }
        if (!authed(req)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
      } catch (err) {
        log.error('upgrade failed', err);
        try {
          socket.destroy();
        } catch {
          /* already gone */
        }
      }
    });
    this.wss.on('connection', () => log.debug('control panel connected'));
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
