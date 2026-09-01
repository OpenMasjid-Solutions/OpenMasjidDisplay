// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** WebSocket hub that pushes live status to connected control panels. */
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { makeLog } from './logger';

const log = makeLog('ws');

export class WsHub {
  private readonly wss: WebSocketServer;
  /**
   * A SECOND server for the routed paths, and the separation is load-bearing.
   *
   * `broadcast` walks `wss.clients`, so upgrading a terminal through the same instance put it in
   * the broadcast set: every status push was written into the terminal — and into the far end of it,
   * which is a shell's standard input. The panel saw screen JSON appear in its terminal and the Pi
   * was being fed it as keystrokes. Two servers, two client sets, one of which is broadcast to.
   */
  private readonly routed: WebSocketServer;

  /**
   * @param extra Other WebSocket paths this app serves — currently the two halves of a Pi terminal
   *   (see piShell.ts). It lives here rather than in its own `server.on('upgrade')` listener
   *   because this handler DESTROYS any socket whose path it does not recognise: a second listener
   *   would race it, and whichever ran first would kill the other's connections. One owner of the
   *   event, one place that decides what the paths are.
   */
  constructor(
    server: Server,
    authed: (req: IncomingMessage) => boolean,
    extra?: (path: string, req: IncomingMessage, upgrade: (onOpen: (ws: WebSocket) => void) => void) => boolean,
  ) {
    this.wss = new WebSocketServer({ noServer: true });
    this.routed = new WebSocketServer({ noServer: true });
    // Defence in depth: an exception thrown in an 'upgrade' listener is an UNCAUGHT
    // exception (there is no surrounding try/catch as there is on the HTTP path), so it
    // kills the process. That made a single malformed cookie an unauthenticated remote
    // kill switch for every screen. The root cause is fixed in auth.ts, but this handler
    // must never be the reason the app dies — drop the socket and stay up instead.
    server.on('upgrade', (req, socket, head) => {
      try {
        const path = (req.url ?? '').split('?')[0];
        if (path !== '/ws') {
          // Anything else is either one of the extra routes or nothing at all. The route decides
          // its own authentication — the panel cookie is right for one of them and wrong for the
          // other, which is a device presenting its own credential.
          const handled = extra?.(path, req, (onOpen) => {
            this.routed.handleUpgrade(req, socket, head, (ws) => onOpen(ws));
          });
          if (!handled) socket.destroy();
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
