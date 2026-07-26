// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * volunteerApi.ts — the tiny, PIN-gated handler served on the *volunteer port*.
 *
 * It's intentionally separate from the admin API: it serves the same SPA bundle
 * (with a flag injected so the app boots into the mobile volunteer view) and
 * exposes ONLY a handful of read/switch endpoints. It never mounts the admin
 * endpoints, so a volunteer PIN can't reach anything destructive.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { makeLog } from './logger';
import type { Store } from './store';
import type { Orchestrator } from './orchestrator';
import {
  verifyPassword,
  makeVolunteerToken,
  hasValidVolunteerSession,
  setVolunteerCookieHeader,
  clearVolunteerCookieHeader,
} from './auth';
import { normContent } from './validate';
import { LoginLimiter } from './rateLimit';
import { rid } from './store';
import { saveReportImage, removeReportImage, reportImageFile } from './render/background';
import { regenerateReportFrames } from './render/reportFrames';
import type { ContentRef, ParkingReport } from './types';

const log = makeLog('volunteer');

const str = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);
function publicReport(r: ParkingReport) {
  return {
    id: r.id, plate: r.plate, description: r.description, location: r.location,
    reason: r.reason, hasImage: !!r.image, targets: r.targets, createdAt: r.createdAt,
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req: IncomingMessage, maxBytes = 100_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += c.toString();
    });
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Inline boot script: flips the shared SPA bundle into the volunteer view and tells it the
 *  base path it's served under (so its /api/volunteer/… calls resolve under the tunnel prefix).
 *  It's a classic (non-module) script, so it runs before the deferred module bundle. */
function volunteerBootScript(basePrefix: string): string {
  return `<script>window.__OMD_VOLUNTEER__=true;window.__OMD_BASE__=${JSON.stringify(basePrefix)};</script>`;
}

/** Serve the SPA. index.html gets the boot script injected (and, under a tunnel base path, its
 *  asset URLs repointed under that prefix) so the same build boots the volunteer UI. */
function serveSpa(res: ServerResponse, pathname: string, basePrefix: string): void {
  const rel = pathname === '/' || pathname === '' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.resolve(config.publicDir, rel);
  const root = path.resolve(config.publicDir);
  const isIndex = rel === 'index.html';
  if (!isIndex && full.startsWith(root + path.sep) && fs.existsSync(full) && fs.statSync(full).isFile()) {
    // A real static asset (reached on the volunteer PORT; behind the tunnel the MAIN server
    // serves /<appId>/assets/… itself).
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=3600',
    });
    fs.createReadStream(full).pipe(res);
    return;
  }
  // index.html (or any unknown path → SPA fallback): repoint assets under the base path, then
  // inject the boot script.
  const idx = path.join(config.publicDir, 'index.html');
  if (fs.existsSync(idx)) {
    let html = fs.readFileSync(idx, 'utf8');
    if (basePrefix) html = html.replace(/="\/assets\//g, `="${basePrefix}/assets/`);
    const boot = volunteerBootScript(basePrefix);
    html = html.includes('</head>') ? html.replace('</head>', `${boot}</head>`) : boot + html;
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
    res.end(html);
  } else {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('OpenMasjid Display — volunteer page (the control panel build was not found).');
  }
}

function labelFor(store: Store, c: ContentRef): string {
  if (c.kind === 'timetable') return store.db.timetables.find((t) => t.id === c.id)?.name ?? 'Timetable';
  if (c.kind === 'source') return store.db.sources.find((s) => s.id === c.id)?.name ?? 'Source';
  return 'Nothing';
}

export function createVolunteerApi(deps: { store: Store; orchestrator: Orchestrator }) {
  const { store, orchestrator } = deps;
  const loginLimiter = new LoginLimiter();
  const enabled = () => store.db.settings.volunteerEnabled && !!store.db.volunteerAuth;
  const authed = (req: IncomingMessage) => hasValidVolunteerSession(req, store.secret);

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // On its own port this handler is reached at the root; behind the OS tunnel (delegated by
    // the main server) it's reached at /<basePath>/volunteer(/…), where <basePath> is the
    // admin-chosen path — it DEFAULTS to the app id but can be renamed, so derive it from the
    // ACTUAL leading segment rather than hardcoding config.omosAppId. Keep it as the base the
    // served page prefixes its assets + API with. (The 'api' segment is the un-prefixed API,
    // not a base path.)
    const seg = /^\/([a-z0-9-]+)(\/.*)$/.exec(url.pathname);
    const basePrefix =
      seg && seg[1] !== 'api' && (seg[2] === '/volunteer' || seg[2].startsWith('/volunteer/') || seg[2].startsWith('/api/volunteer/'))
        ? `/${seg[1]}`
        : '';
    const pathname = basePrefix ? url.pathname.slice(basePrefix.length) : url.pathname;
    const method = req.method ?? 'GET';

    try {
      if (pathname === '/healthz') return sendJson(res, 200, { ok: true });

      if (pathname === '/api/volunteer/session' && method === 'GET') {
        return sendJson(res, 200, { enabled: enabled(), authed: authed(req) });
      }
      if (pathname === '/api/volunteer/login' && method === 'POST') {
        if (!enabled()) return sendJson(res, 403, { error: 'The volunteer page is turned off.' });
        // Rate limit keyed on the socket IP. Reached over the OS tunnel every request shares the
        // ingress IP, so this is ONE global bucket: still brute-force-resistant (the important
        // property — a 4–8-digit PIN can't be cracked through a global throttle), at the cost of
        // one bad actor briefly locking out other remote logins (self-healing, ≤5 min; the LAN
        // port sees real IPs). We deliberately do NOT key on X-Forwarded-For — trusting it is only
        // safe behind the sanitising ingress, and a direct hit could spoof it for fresh buckets.
        const wait = loginLimiter.retryAfterMs(req);
        if (wait > 0) return sendJson(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.` });
        const body = await readBody(req);
        const pin = String(body.pin ?? '');
        if (store.db.volunteerAuth && verifyPassword(pin, store.db.volunteerAuth)) {
          loginLimiter.succeed(req);
          res.setHeader('set-cookie', setVolunteerCookieHeader(makeVolunteerToken(store.secret)));
          return sendJson(res, 200, { ok: true });
        }
        loginLimiter.fail(req);
        return sendJson(res, 401, { error: 'Wrong PIN.' });
      }
      if (pathname === '/api/volunteer/logout' && method === 'POST') {
        res.setHeader('set-cookie', clearVolunteerCookieHeader());
        return sendJson(res, 200, { ok: true });
      }

      // ---- Static SPA (GET, non-API) --------------------------------------
      if (!pathname.startsWith('/api/') && method === 'GET') {
        return serveSpa(res, pathname, basePrefix);
      }

      // ---- Everything below needs the volunteer session + enabled ---------
      if (!enabled()) return sendJson(res, 403, { error: 'The volunteer page is turned off.' });
      if (!authed(req)) return sendJson(res, 401, { error: 'Please enter the PIN.' });

      if (pathname === '/api/volunteer/tvs' && method === 'GET') {
        const statuses = orchestrator.getStatuses();
        const byTv = new Map(statuses.map((s) => [s.tvId, s]));
        const tvs = store.db.tvs.map((tv) => {
          const st = byTv.get(tv.id);
          const effective = st?.effective ?? tv.defaultContent;
          return {
            id: tv.id,
            name: tv.name,
            room: tv.room ?? '',
            now: { kind: effective.kind, id: effective.id, label: labelFor(store, effective) },
            overridden: !!tv.override,
            ready: !!st?.streamReady,
          };
        });
        const options = {
          timetables: store.db.timetables.map((t) => ({ id: t.id, name: t.name })),
          sources: store.db.sources.filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.name, type: s.type })),
        };
        return sendJson(res, 200, { tvs, options });
      }

      const setMatch = /^\/api\/volunteer\/tvs\/([\w-]+)\/set$/.exec(pathname);
      if (setMatch && method === 'POST') {
        const id = setMatch[1];
        const body = await readBody(req);
        const idx = store.db.tvs.findIndex((t) => t.id === id);
        if (idx < 0) return sendJson(res, 404, { error: 'Screen not found.' });
        const content = normContent(body.content);
        store.update((db) => {
          db.tvs[idx].override = { content, until: null };
        });
        return sendJson(res, 200, { ok: true });
      }
      const resumeMatch = /^\/api\/volunteer\/tvs\/([\w-]+)\/resume$/.exec(pathname);
      if (resumeMatch && method === 'POST') {
        const id = resumeMatch[1];
        const idx = store.db.tvs.findIndex((t) => t.id === id);
        if (idx < 0) return sendJson(res, 404, { error: 'Screen not found.' });
        store.update((db) => void (db.tvs[idx].override = null));
        return sendJson(res, 200, { ok: true });
      }

      // ---- Incorrect-parking reports (volunteer-filed alert cards) --------
      if (pathname === '/api/volunteer/reports' && method === 'GET') {
        const reports = (store.db.reports ?? [])
          .slice()
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
          .map(publicReport);
        const timetables = store.db.timetables.map((t) => ({ id: t.id, name: t.name }));
        return sendJson(res, 200, { reports, timetables });
      }
      if (pathname === '/api/volunteer/reports' && method === 'POST') {
        const body = await readBody(req, 8_000_000); // room for a client-resized photo
        const plate = str(body.plate, 15);
        const description = str(body.description, 200);
        const location = str(body.location, 120);
        const reason = str(body.reason, 200);
        if (!plate && !description) return sendJson(res, 400, { error: 'Add at least a license plate or a description of the car.' });
        if (!location) return sendJson(res, 400, { error: 'Say where the car is (the location).' });
        if (!reason) return sendJson(res, 400, { error: 'Give a reason for the report.' });
        const known = new Set(store.db.timetables.map((t) => t.id));
        let targets = Array.isArray(body.targets) ? body.targets.map(String).filter((id) => known.has(id)) : [];
        if (targets.length === 0) targets = ['*']; // no/blank selection → show on every display
        const id = rid('rep');
        const image = typeof body.image === 'string' && body.image ? saveReportImage(id, body.image) : '';
        const report: ParkingReport = { id, plate, description, location, reason, image, targets, createdAt: new Date().toISOString() };
        store.update((db) => void (db.reports ??= []).push(report));
        regenerateReportFrames(store);
        return sendJson(res, 201, { report: publicReport(report) });
      }
      const repDel = /^\/api\/volunteer\/reports\/([\w-]+)$/.exec(pathname);
      if (repDel && method === 'DELETE') {
        const id = repDel[1];
        if (!(store.db.reports ?? []).some((r) => r.id === id)) return sendJson(res, 404, { error: 'Report not found.' });
        removeReportImage(id);
        store.update((db) => void (db.reports = (db.reports ?? []).filter((r) => r.id !== id)));
        regenerateReportFrames(store);
        return sendJson(res, 200, { ok: true });
      }
      const repImg = /^\/api\/volunteer\/reports\/([\w-]+)\/image$/.exec(pathname);
      if (repImg && method === 'GET') {
        const rep = (store.db.reports ?? []).find((r) => r.id === repImg[1]);
        const f = rep && rep.image ? reportImageFile(rep.image) : null;
        if (!f) return sendJson(res, 404, { error: 'No image.' });
        res.writeHead(200, { 'content-type': f.mime, 'cache-control': 'no-store' });
        return void fs.createReadStream(f.path).pipe(res);
      }

      return sendJson(res, 404, { error: 'Not found.' });
    } catch (err) {
      log.error(`${method} ${pathname}`, err);
      if (!res.headersSent) sendJson(res, 400, { error: 'Something went wrong.' });
    }
  };
}
