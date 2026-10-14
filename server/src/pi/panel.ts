// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * pi/panel.ts — the control panel a standalone screen serves for itself.
 *
 * A Pi with no display server still has to be configurable, and the thing doing the configuring
 * is a laptop on the masjid's network. So the Pi serves **the same web app the server serves**,
 * from the same bundle, and answers the handful of endpoints that app calls. What it is allowed
 * to leave out is decided by `PI_CAPABILITIES`, not by a second version of the UI —
 * docs/PI_STANDALONE_DESIGN.md §2.
 *
 * **Why this is not `createApi`.** The server's API is dependency-injected and would take the
 * deps, but it imports MediaMTX, the Fabric client and the WhatsApp gateway at module level, so
 * bundling it would drag all three onto a device that can do none of them. This serves the
 * subset a standalone screen has, over the same `Store`, the same `validate` and the same
 * `auth` the server uses — so the parts that could drift are the parts there is only one of.
 *
 * **What holds it shut.** Everything except the four unauthenticated endpoints needs the
 * session cookie. The one route that can create an account is `/api/setup`, and it is spent
 * once: it works only while there is no admin, and only for somebody who can read the code off
 * the television. There is no inbound path to this device other than this listener.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from '../store';
import {
  hashPassword,
  verifyPassword,
  makeToken,
  hasValidSession,
  setCookieHeader,
  clearCookieHeader,
  isSecureRequest,
} from '../auth';
import { LoginLimiter } from '../rateLimit';
import { PI_CAPABILITIES } from '../capabilities';
import { statePayload, type ScreenStatuses } from '../statePayload';
import { setupCodeMatches } from './claim';
import type { AgentConfig } from './agentConfig';

/** Mirrors the server's own headers. A panel on a masjid's LAN gets the same treatment as one
 *  behind the platform: there is no reason for the weaker set. */
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

export interface PanelDeps {
  store: Store;
  /** the agent's config, for the setup code — read fresh, because it is cleared on claiming */
  readConfig: () => AgentConfig | null;
  /** persist the config back, with `setupCode` absent once it has been spent */
  writeConfig: (cfg: AgentConfig) => void;
  /** where the built web app lives on the device */
  webDir: string;
  /** what this screen is doing — the Pi reports on the one screen it is */
  screens: ScreenStatuses;
}

const sendJson = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** Read a JSON body, with a hard cap. Nothing this panel accepts is large, and an unbounded
 *  read on a device with a gigabyte of RAM is a way to stop the screen drawing. */
function readBody(req: IncomingMessage, maxBytes = 64_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > maxBytes) {
        req.destroy();
        reject(new Error('too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

export function createPiPanel(deps: PanelDeps) {
  const { store, readConfig, writeConfig, webDir, screens } = deps;
  const loginLimiter = new LoginLimiter();
  const authed = (req: IncomingMessage): boolean => hasValidSession(req, store.secret);

  /**
   * Serve a file out of the web bundle.
   *
   * The path is resolved and then checked to be INSIDE the bundle directory, rather than
   * filtered for `..` — the filter is the version of this that gets walked past, and resolution
   * is what actually decides which file is opened.
   */
  function serveStatic(res: ServerResponse, pathname: string): boolean {
    const full = path.resolve(webDir, `.${pathname}`);
    const root = path.resolve(webDir);
    if (full !== root && !full.startsWith(root + path.sep)) return false;
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      return false;
    }
    if (!st.isFile()) return false;
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(fs.readFileSync(full));
    return true;
  }

  function serveIndex(res: ServerResponse): void {
    const file = path.join(webDir, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
      res.end('This screen is running, but its control panel was not installed.');
      return;
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
    res.end(fs.readFileSync(file));
  }

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const method = req.method ?? 'GET';

    try {
      if (pathname === '/api/session' && method === 'GET') {
        return sendJson(res, 200, {
          // No platform to sign in through, so first run always means creating the account here.
          needsSetup: !store.db.admin,
          authed: authed(req),
          hasPassword: !!store.db.admin,
          sso: { enabled: false, reachable: false },
          capabilities: PI_CAPABILITIES,
          // Only ever `true`/`false` — never the code itself. The panel needs to know whether to
          // ask for one; knowing WHAT it is, is the whole point of walking to the television.
          setupCodeRequired: !store.db.admin && !!readConfig()?.setupCode,
        });
      }

      if (pathname === '/api/setup' && method === 'POST') {
        // Rate-limited like a sign-in, because that is what it is: a guess at a secret. Eight
        // digits is only out of reach while guessing is slow.
        const wait = loginLimiter.retryAfterMs(req);
        if (wait > 0) return sendJson(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.` });
        if (store.db.admin) return sendJson(res, 409, { error: 'This screen has already been set up.' });

        const cfg = readConfig();
        const code = cfg?.setupCode ?? '';
        const body = await readBody(req).catch(() => null);
        if (!body) return sendJson(res, 400, { error: 'That request was too large.' });

        // No code on disk means the screen cannot be claimed this way at all. Refusing is the
        // only safe reading: the alternative is an unclaimed panel anyone on the LAN can take.
        if (!code) {
          loginLimiter.fail(req);
          return sendJson(res, 403, { error: 'This screen has no setup code. Restart it to get a new one on the television.' });
        }
        if (!setupCodeMatches(String(body.code ?? ''), code)) {
          loginLimiter.fail(req);
          return sendJson(res, 401, { error: 'That code does not match the one on the television.' });
        }

        const pw = String(body.password ?? '');
        if (pw.length < 8) return sendJson(res, 400, { error: 'Please choose a password of at least 8 characters.' });
        const name = String(body.name ?? '').slice(0, 80).trim();
        const { hash, salt } = hashPassword(pw);
        /**
         * The claim is decided INSIDE the update, not by the check at the top of this route.
         *
         * That check runs before `await readBody`, and an await yields — so two requests
         * arriving together both passed it and both went on to write an account, the second
         * silently replacing the first, who was left holding a session cookie for a password
         * that no longer worked. Both callers need the right code, so it was never a takeover
         * by a stranger; it was a screen that could not be explained afterwards.
         *
         * The callback runs synchronously, so between reading `db.admin` and setting it there
         * is nowhere to yield and nothing can get in between.
         */
        let claimed = false;
        store.update((db) => {
          if (db.admin) return;
          db.admin = { hash, salt, name: name || undefined, createdAt: new Date().toISOString() };
          claimed = true;
        });
        if (!claimed) return sendJson(res, 409, { error: 'This screen has already been set up.' });
        // Spend the code: written back WITHOUT it, so it leaves both the disk and the
        // television. A used code that still works is a second way in nobody is watching.
        if (cfg) writeConfig({ ...cfg, setupCode: undefined });
        loginLimiter.succeed(req);
        res.setHeader('set-cookie', setCookieHeader(makeToken(store.secret), undefined, isSecureRequest(req)));
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/login' && method === 'POST') {
        const wait = loginLimiter.retryAfterMs(req);
        if (wait > 0) return sendJson(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.` });
        const body = await readBody(req).catch(() => null);
        if (!body) return sendJson(res, 400, { error: 'That request was too large.' });
        if (!store.db.admin) return sendJson(res, 400, { error: 'This screen has not been set up yet.' });
        if (verifyPassword(String(body.password ?? ''), store.db.admin)) {
          loginLimiter.succeed(req);
          res.setHeader('set-cookie', setCookieHeader(makeToken(store.secret), undefined, isSecureRequest(req)));
          return sendJson(res, 200, { ok: true });
        }
        loginLimiter.fail(req);
        return sendJson(res, 401, { error: 'Incorrect password.' });
      }

      if (pathname === '/api/logout' && method === 'POST') {
        res.setHeader('set-cookie', clearCookieHeader(isSecureRequest(req)));
        return sendJson(res, 200, { ok: true });
      }

      // The web app and its assets. Served to anyone on the LAN, exactly as the server does:
      // the bundle is not a secret and the panel inside it shows nothing until it has a session.
      if (!pathname.startsWith('/api/') && method === 'GET') {
        if (serveStatic(res, pathname)) return;
        return serveIndex(res);
      }

      // Everything else needs a session. This is the line that makes the list above the whole
      // of the unauthenticated surface.
      if (!authed(req)) return sendJson(res, 401, { error: 'Please sign in.' });

      if (pathname === '/api/state' && method === 'GET') {
        /**
         * The same payload the server builds, with the three fields that describe a server
         * replaced by what is true here.
         *
         * Shared rather than rewritten so the panel is written against one shape; overridden
         * rather than parameterised because three fields do not justify three parameters, and
         * because what the Pi puts in them is a statement about this device rather than a
         * configuration anybody chooses.
         */
        return sendJson(res, 200, {
          ...statePayload(store, screens),
          // This device never serves RTSP — it only consumes streams and draws its own screen.
          rtsp: { port: 0, transport: 'tcp' },
          // No OpenMasjidOS behind it; that is what standalone means.
          omosBase: '',
          // The volunteer page is served by this same listener rather than on a port of its own.
          volunteer: { pinSet: !!store.db.volunteerAuth, port: 0 },
        });
      }

      return sendJson(res, 404, { error: 'Not found.' });
    } catch {
      return sendJson(res, 500, { error: 'Something went wrong on this screen.' });
    }
  };
}
