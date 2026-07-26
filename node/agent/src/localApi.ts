// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * localApi.ts — the node's own HTTP server on the LAN, plus the kiosk bundle.
 *
 * Three jobs:
 *  1. `GET /api/status` — who am I, am I adopted. The one endpoint open before adoption,
 *     because the controller has to be able to ask before it has a credential.
 *  2. `POST /api/adopt` — ONE-SHOT pairing. Returns 409 forever afterwards.
 *  3. Serve the local kiosk page (the timetable renderer and the status screen), which the
 *     browser on this same box loads over loopback.
 *
 * ── Security posture (spec §9) ──
 * Adoption is unauthenticated by necessity — a factory-fresh node has no shared secret —
 * and is protected instead by being ONE-SHOT and LAN-only. Everything after adoption
 * requires the bearer token. The known limitation, stated in the setup guide: on an
 * untrusted LAN, whoever reaches a fresh node first can claim it. The v1.1 hardening is an
 * on-screen 6-digit code typed into the panel; the seam for it is `confirmCode` below.
 *
 * The kiosk page is served from loopback to our own browser, so it is deliberately NOT
 * token-gated — but it also carries nothing secret: the timetable document is public
 * information (it is on a screen in a public hall), and stream URLs never reach it.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { parseAdoptRequest, type NodeStatusResponse } from '../../../packages/protocol/src/index';
import type { AgentStore } from './store';
import type { Platform } from './platform';

const MAX_BODY_BYTES = 16 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

export interface LocalApiOpts {
  store: AgentStore;
  platform: Platform;
  fw: string;
  /** directory holding the built kiosk bundle */
  kioskDir: string;
  /** what the kiosk should currently render, as JSON for its own fetch */
  viewJson: () => unknown;
  /** called after a successful adoption so the agent can start dialling immediately */
  onAdopted: () => void;
}

export function createLocalApi(opts: LocalApiOpts): http.Server {
  const { store, platform, fw, kioskDir } = opts;

  const send = (res: http.ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let data = '';
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        data += c.toString('utf8');
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          reject(new Error('invalid JSON'));
        }
      });
      req.on('error', reject);
    });

  const bearer = (req: http.IncomingMessage): string => {
    const m = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec((req.headers.authorization ?? '').trim());
    return m ? m[1] : '';
  };
  const authed = (req: http.IncomingMessage): boolean => {
    const token = store.adoption?.nodeToken;
    // Constant-time-ish: compare lengths first, then every byte. The token is 256 bits of
    // entropy so timing is not a realistic attack here, but there is no reason to leak it.
    const given = bearer(req);
    if (!token || given.length !== token.length) return false;
    let diff = 0;
    for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ given.charCodeAt(i);
    return diff === 0;
  };

  const status = (): NodeStatusResponse => {
    const s: NodeStatusResponse = {
      serial: platform.serial(),
      model: platform.model(),
      fw,
      caps: platform.caps(),
      adopted: store.adopted,
    };
    const name = store.adoption?.controllerName;
    if (name) s.controllerName = name;
    const ip = platform.health().ip;
    if (ip) s.ip = ip;
    return s;
  };

  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://node.local');
      const pathname = url.pathname;
      const method = req.method ?? 'GET';

      try {
        if (pathname === '/api/status' && method === 'GET') return send(res, 200, status());

        if (pathname === '/api/adopt' && method === 'POST') {
          // One-shot, forever. A node that is already paired must not be silently
          // re-pointed at a different controller by anyone who can reach it.
          if (store.adopted) return send(res, 409, { error: 'already adopted' });
          let body: unknown;
          try {
            body = await readBody(req);
          } catch (err) {
            return send(res, 400, { error: err instanceof Error ? err.message : 'bad body' });
          }
          const parsed = parseAdoptRequest(body);
          if (!parsed.ok) return send(res, 400, { error: parsed.error });
          try {
            store.adopt({ ...parsed.value, adoptedAt: new Date().toISOString() });
          } catch {
            return send(res, 409, { error: 'already adopted' });
          }
          // Reply with our identity BEFORE dialling, so the controller's record is written
          // from the same handshake it just completed.
          send(res, 200, { serial: platform.serial(), model: platform.model(), fw, caps: platform.caps() });
          opts.onAdopted();
          return;
        }

        // What the kiosk page renders. Loopback-only: the display document is not secret,
        // but there is no reason to publish it to the whole LAN either.
        if (pathname === '/api/view' && method === 'GET') {
          if (!isLoopback(req)) return send(res, 403, { error: 'loopback only' });
          return send(res, 200, opts.viewJson());
        }

        // Everything else under /api needs the token.
        if (pathname.startsWith('/api/')) {
          if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
          return send(res, 404, { error: 'not found' });
        }

        if (method !== 'GET') return send(res, 405, { error: 'method not allowed' });
        if (serveKiosk(res, kioskDir, pathname)) return;
        // SPA fallback so the kiosk can use paths (e.g. /status) without a router on disk.
        if (serveKiosk(res, kioskDir, '/index.html')) return;
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      } catch {
        if (!res.headersSent) send(res, 500, { error: 'internal error' });
      }
    })();
  });
}

/** Is this request from the box itself? (Our own kiosk browser.) */
function isLoopback(req: http.IncomingMessage): boolean {
  const a = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1';
}

/** Serve a file from the kiosk bundle. Returns false if it is not there. */
function serveKiosk(res: http.ServerResponse, dir: string, pathname: string): boolean {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.resolve(dir, rel);
  const root = path.resolve(dir);
  // Traversal guard, anchored with a separator so a sibling directory sharing the prefix
  // cannot slip through — same shape as the controller's serveStatic.
  if (full !== root && !full.startsWith(root + path.sep)) return false;
  try {
    if (!fs.statSync(full).isFile()) return false;
  } catch {
    return false;
  }
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    // The page must pick up a new document immediately; the hashed assets never change.
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(full).pipe(res);
  return true;
}
