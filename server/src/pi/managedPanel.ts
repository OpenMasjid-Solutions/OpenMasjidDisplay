// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The panel an ADOPTED Raspberry Pi serves: one status page, and nothing else.
 *
 * ## Why an adopted screen serves a panel at all
 *
 * It used not to. `createPiPanel` was built inside `runStandalone`, so the moment a server adopted
 * a screen its panel stopped existing — measured on real hardware: port 80 went from answering 200
 * to unreachable, and answered again when the screen was released. The cost of that lands on the
 * one day it matters: if the display server dies for good, every screen keeps drawing its last
 * state and nobody can reach any of them except over SSH. The thing an admin needs at that moment
 * is to stand in front of a screen, open its address, and be told what it thinks is happening.
 *
 * ## Why it is a SEPARATE handler rather than the standalone panel in a read-only mode
 *
 * The standalone panel has around twenty-five routes, most of which write. Registering all of them
 * and then refusing the writes puts the safety in a guard — one `if` that a later route can be
 * added in front of, or behind, without anyone noticing. Here the writes are not registered at
 * all, so there is nothing to get wrong: this file contains no `store.update`, no `fs.write`, and
 * no route that takes a body. A test asserts that by reading the file.
 *
 * ## What it shows, and why it needs no sign-in
 *
 * A Pi installed from a server never had a local password, so there is no credential to ask for;
 * demanding one would mean the screens most likely to need this page are the ones that cannot
 * open it. So the page is unauthenticated on the masjid's own LAN, and the payload is held to
 * what the TELEVISION already shows to anybody standing in the room: the screen's name, its
 * board, its version, which server owns it, whether that server is answering, and whether a
 * timetable or a camera is on screen.
 *
 * Deliberately NOT in it: the timetable's contents, the camera's address or name, the masjid's
 * settings, any asset, and anything resembling a credential. `content` is a KIND, not an id — a
 * camera's name can carry a room name, and a URL carries its password.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SECURITY_HEADERS } from '../httpio';
import { MANAGED_PI_CAPABILITIES } from '../capabilities';

/** What the agent knows about itself, gathered fresh for each request. All of it is cheap. */
export interface ManagedStatus {
  /** The name the server gave this screen, or '' before the first poll has landed. */
  screenName: string;
  hostname: string;
  /** This device's own address on the LAN, so the page can say where it is. */
  ip: string;
  model: string;
  agentVersion: string;
  /** The display server that owns this screen. Shown so an admin knows where to go. */
  server: string;
  /** Has the server answered recently? False means this screen may be showing a stale decision. */
  serverReachable: boolean;
  /** When it last answered, as an ISO string, or null if it never has since this process started. */
  lastContactAt: string | null;
  /** What is on the television right now — the kind only, never which timetable or which camera. */
  content: 'timetable' | 'camera' | 'off' | 'nothing';
  /** The screen refuses to draw prayer times while its clock cannot be right. */
  clockSuspect: boolean;
  /** Whether the output has been switched off (a schedule, or an admin). */
  displayOff: boolean;
}

export interface ManagedPanelDeps {
  /** Where the built web app lives on the device. */
  webDir: string;
  /** Gathered per request — see ManagedStatus. Must not block: no network, no subprocess. */
  status: () => ManagedStatus;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const sendJson = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

export function createManagedPanel(deps: ManagedPanelDeps) {
  const { webDir, status } = deps;

  /** Serve a file out of the web bundle, refusing anything that climbs out of it. */
  const serveFile = (res: ServerResponse, rel: string): boolean => {
    const full = path.resolve(webDir, '.' + path.posix.normalize('/' + rel));
    if (!full.startsWith(path.resolve(webDir))) return false;
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
      'cache-control': rel.includes('/assets/') ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(fs.readFileSync(full));
    return true;
  };

  return function handle(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? 'GET';
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      /* keep '/' */
    }

    /**
     * Nothing here writes, so nothing but GET and HEAD is answered.
     *
     * A flat refusal rather than a per-route check: a managed screen has no endpoint that takes a
     * body, and saying so once at the top is a property of the file rather than of each route.
     */
    if (method !== 'GET' && method !== 'HEAD') {
      return sendJson(res, 405, { error: 'This screen is managed by a Display server. Change it there.' });
    }

    // What the panel asks first. `authed: true` with `needsSetup: false` is the honest answer: there
    // is nothing to sign in to and nothing to set up, and saying otherwise would send the app to a
    // login screen with no password behind it.
    if (pathname === '/api/session') {
      return sendJson(res, 200, {
        authed: true,
        needsSetup: false,
        hasPassword: false,
        ssoEnabled: false,
        ssoReachable: false,
        setupCodeRequired: false,
        capabilities: MANAGED_PI_CAPABILITIES,
      });
    }

    if (pathname === '/api/pi/self') return sendJson(res, 200, status());

    // Every other /api path: say what this screen is, rather than 404-ing as though the panel were
    // broken. A managed screen genuinely does not serve these, and an admin reading a console
    // should be told which machine does.
    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, {
        error: 'This screen is managed by a Display server, and is read-only here.',
      });
    }

    // The app itself, then its routes: anything unrecognised falls back to index.html so a refresh
    // on a client-side route still works.
    const rel = pathname === '/' ? '/index.html' : pathname;
    if (serveFile(res, rel)) return;
    if (serveFile(res, '/index.html')) return;
    res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found.');
  };
}
