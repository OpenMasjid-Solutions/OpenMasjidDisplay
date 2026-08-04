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
    server.on('upgrade', (req, socket, head) => {
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
