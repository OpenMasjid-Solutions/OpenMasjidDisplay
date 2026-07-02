// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** HTTP/JSON API + static SPA host. Mutations go through the store, whose change
 *  listener triggers a reconcile and a WebSocket status push. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { makeLog } from './logger';
import type { Store } from './store';
import type { Orchestrator } from './orchestrator';
import {
  hashPassword,
  verifyPassword,
  hasValidSession,
  makeToken,
  setCookieHeader,
  clearCookieHeader,
} from './auth';
import { probePlatform, ssoConfigured, notify, siteInfo } from './fabric';
import { widgetPayload } from './render/svg';
import { renderWidgetHtml } from './widget';
import { LoginLimiter } from './rateLimit';
import { THEMES } from './render/theme';
import { DEFAULT_SALAH_HADITH } from './render/defaultHadith';
import {
  saveBackground,
  removeBackground,
  saveLogo,
  removeLogo,
  saveAnnouncement,
  removeAnnouncement,
  removeAllAnnouncements,
  uploadFilePath,
  isAllowedImageMime,
  copyAsset,
  logoDataUri,
} from './render/background';
import { renderPreviewPng, renderPreviewMeta } from './render/renderPool';
import { probeSource } from './render/renderer';
import { parseIqamahCsv, toCsv, templateCsv, normalizeIqamahYear } from './iqamahCsv';
import { renderMonthPrintHtml } from './print';
import { localParts } from './prayer/engine';
import {
  normTimetable,
  normSource,
  normTv,
  normSchedule,
  normSettings,
  normContent,
} from './validate';
import type { DB } from './types';

const log = makeLog('api');

// Marker embedded in the widget JSON so we can confirm a candidate PUBLIC (tunnel)
// URL actually reaches THIS app before we hand it to the admin as the embed link.
const WIDGET_APP_MARKER = 'openmasjid-display';

/**
 * Does `jsonUrl` actually serve OUR widget feed? Used to verify that the platform's
 * Cloudflare tunnel really routes the app's public path here before we advertise it
 * as the embed URL — otherwise that URL can land on a DIFFERENT app (path-based
 * ingress isn't guaranteed; see docs/PLATFORM_WIDGET_PATH_INGRESS.md). Fails closed.
 */
async function widgetPublicWorks(jsonUrl: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4500);
    const res = await fetch(jsonUrl, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    clearTimeout(t);
    if (!res.ok) return false;
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return false;
    const j = (await res.json().catch(() => null)) as { app?: unknown } | null;
    return !!j && j.app === WIDGET_APP_MARKER;
  } catch {
    return false;
  }
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

interface Deps {
  store: Store;
  orchestrator: Orchestrator;
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
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

function serveStatic(res: ServerResponse, pathname: string): boolean {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.resolve(config.publicDir, rel);
  // Prevent path traversal outside the public dir (anchor with a trailing separator
  // so a sibling dir sharing the prefix can't slip through).
  const root = path.resolve(config.publicDir);
  if (full !== root && !full.startsWith(root + path.sep)) return false;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(full).pipe(res);
  return true;
}

function serveIndex(res: ServerResponse): void {
  const idx = path.join(config.publicDir, 'index.html');
  if (fs.existsSync(idx)) {
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
    fs.createReadStream(idx).pipe(res);
  } else {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('OpenMasjid Display is running. The control panel build was not found.');
  }
}

function statePayload(store: Store, orchestrator: Orchestrator) {
  const db = store.db;
  const s = db.settings;
  return {
    authRequired: true,
    settings: s,
    timetables: db.timetables,
    sources: db.sources,
    tvs: db.tvs,
    schedules: db.schedules,
    themes: THEMES,
    // The built-in library of ahadith on Salāh (id + English + citation) so the panel can
    // render the enable/disable checklist. Arabic isn't sent — the panel only toggles them.
    hadithDefaults: DEFAULT_SALAH_HADITH.map((h) => ({ id: h.id, en: h.en, cite: h.cite })),
    statuses: orchestrator.getStatuses(),
    // The screens connect to rtsp://<this server>:<port>/<screen>. The host is
    // whatever address the panel was opened with (filled in by the browser), so
    // there is no server IP to configure here.
    rtsp: {
      port: config.rtspPort,
      transport: 'tcp',
    },
    omosBase: config.omosBaseUrl,
    // Volunteer mode (the simple mobile page on its own port). We never send the
    // PIN itself — only whether one is set, and the host port to show in the URL.
    volunteer: {
      pinSet: !!store.db.volunteerAuth,
      port: config.volunteerPublicPort,
    },
    serverNow: Date.now(),
  };
}

// SSO-minted admin sessions are short-lived (re-validated against the platform on
// expiry) so a platform logout/deprovision isn't shadowed by a 30-day local cookie.
const SSO_SESSION_MS = 60 * 60 * 1000;
// Each timetable/source = a worker thread + an ffmpeg process; cap the collections
// so a runaway (or a malicious SSO-minted admin) can't fan out unbounded pipelines.
const MAX_PER_COLLECTION = 40;
const atCap = (res: ServerResponse, arr: unknown[]): boolean => {
  if (arr.length >= MAX_PER_COLLECTION) {
    sendJson(res, 400, { error: `You can have at most ${MAX_PER_COLLECTION} of these.` });
    return true;
  }
  return false;
};

export function createApi(deps: Deps) {
  const { store, orchestrator } = deps;
  const loginLimiter = new LoginLimiter();
  // A request is authenticated if it carries a valid local session cookie. That
  // cookie is minted by first-run setup, by password login, or by confirmed
  // OpenMasjidOS SSO (see /api/session) — so every other endpoint stays a simple,
  // synchronous check.
  const authed = (req: IncomingMessage) => hasValidSession(req, store.secret);

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    try {
      // ---- Unauthenticated endpoints --------------------------------------
      if (pathname === '/healthz') return sendJson(res, 200, { ok: true });

      // ---- Public embeddable widget (no auth; only for opted-in timetables) ------
      // Matches /w/<id> and /w/<id>.json, optionally behind the Cloudflare-tunnel base
      // path (e.g. /display/w/<id>) — the widget polls a path relative to itself, so
      // it works both on the LAN and behind the tunnel.
      const widgetMatch = /^(?:\/[a-z0-9-]+)?\/w\/([\w-]+)(\.json)?$/.exec(pathname);
      if (widgetMatch && method === 'GET') {
        const tt = store.db.timetables.find((t) => t.id === widgetMatch[1]);
        // 404 (not 403) when the widget is off, so an off timetable's id isn't probeable.
        if (!tt || !tt.widget?.enabled) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('Not found.');
          return;
        }
        const data = widgetPayload(tt, new Date(), {
          date: url.searchParams.get('date') ?? undefined,
          weekStart: url.searchParams.get('week') ?? undefined,
        });
        if (widgetMatch[2]) {
          // JSON feed — CORS-open so a masjid can also build their own UI from it.
          // The `app` marker lets the editor verify a public (tunnel) URL actually
          // reaches THIS app before advertising it (see /widget-info).
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
          });
          res.end(JSON.stringify({ app: WIDGET_APP_MARKER, ...data }));
          return;
        }
        // Use the masjid's uploaded logo (embedded as a data URI so the public widget
        // needs no separate, auth-gated asset request); falls back to the built-in mark.
        const widgetLogo = tt.logoImage ? logoDataUri(tt.logoImage) : null;
        const html = renderWidgetHtml(data, `${pathname}.json`, widgetLogo);
        // Explicitly allow embedding in a masjid's own site (the widget is meant to be framed).
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': 'frame-ancestors *',
        });
        res.end(html);
        return;
      }

      if (pathname === '/api/session' && method === 'GET') {
        let isAuthed = authed(req);
        let username: string | undefined;
        // True unless we tried to reach the platform and couldn't — used by the UI to
        // tell "open from the dashboard" apart from "OpenMasjidOS is unreachable".
        let reachable = true;
        // OpenMasjidOS SSO: if not already signed in here but the visitor carries
        // a platform session the platform confirms, mint a local session so the
        // rest of the API (and the WebSocket) treats them as signed in. Falls back
        // silently to local login when SSO is absent or the platform is down.
        if (!isAuthed && ssoConfigured()) {
          const probe = await probePlatform(req);
          reachable = probe.reachable;
          if (probe.username) {
            res.setHeader('set-cookie', setCookieHeader(makeToken(store.secret, SSO_SESSION_MS), SSO_SESSION_MS));
            isAuthed = true;
            username = probe.username;
          }
        }
        return sendJson(res, 200, {
          // Standalone: first run creates a password. Under OpenMasjidOS, signing
          // in happens through the dashboard, so we never block on local setup.
          needsSetup: !store.db.admin && !ssoConfigured(),
          authed: isAuthed,
          hasPassword: !!store.db.admin,
          sso: { enabled: ssoConfigured(), reachable, username },
        });
      }
      if (pathname === '/api/setup' && method === 'POST') {
        const body = await readBody(req);
        if (store.db.admin) return sendJson(res, 409, { error: 'The control panel is already set up.' });
        // The local password is a recovery path — but under OpenMasjidOS SSO the
        // admin signs in through the dashboard and NEVER sets a local password, so
        // store.db.admin stays null for the life of the deployment. If we allowed
        // an anonymous setup while the platform is reachable, any LAN/ingress
        // visitor could claim a permanent local admin (unauthenticated takeover).
        // So: when SSO is configured and the platform is reachable, only a caller
        // the platform recognises as an admin may set a recovery password;
        // otherwise (platform down — restore/migration/outage) local setup stays
        // open so nobody is locked out. Standalone (no SSO) is unchanged.
        if (ssoConfigured()) {
          const probe = await probePlatform(req);
          if (probe.reachable && !probe.username) {
            return sendJson(res, 403, {
              error: 'Sign in through your OpenMasjidOS dashboard (press Open on the Display app). A recovery password can only be set here if the dashboard is unreachable.',
            });
          }
        }
        const pw = String(body.password ?? '');
        if (pw.length < 8) return sendJson(res, 400, { error: 'Please choose a password of at least 8 characters.' });
        const { hash, salt } = hashPassword(pw);
        const name = String(body.name ?? '').slice(0, 80).trim();
        store.update((db) => {
          db.admin = { hash, salt, name: name || undefined, createdAt: new Date().toISOString() };
        });
        res.setHeader('set-cookie', setCookieHeader(makeToken(store.secret)));
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === '/api/login' && method === 'POST') {
        const wait = loginLimiter.retryAfterMs(req);
        if (wait > 0) return sendJson(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.` });
        const body = await readBody(req);
        if (!store.db.admin) return sendJson(res, 400, { error: 'This panel has not been set up yet.' });
        if (verifyPassword(String(body.password ?? ''), store.db.admin)) {
          loginLimiter.succeed(req);
          res.setHeader('set-cookie', setCookieHeader(makeToken(store.secret)));
          return sendJson(res, 200, { ok: true });
        }
        loginLimiter.fail(req);
        return sendJson(res, 401, { error: 'Incorrect password.' });
      }
      if (pathname === '/api/logout' && method === 'POST') {
        res.setHeader('set-cookie', clearCookieHeader());
        return sendJson(res, 200, { ok: true });
      }

      // ---- Static + SPA (GET) ---------------------------------------------
      if (!pathname.startsWith('/api/') && method === 'GET') {
        if (serveStatic(res, pathname)) return;
        return serveIndex(res);
      }

      // ---- Everything else requires auth ----------------------------------
      if (!authed(req)) return sendJson(res, 401, { error: 'Please sign in.' });

      if (pathname === '/api/state' && method === 'GET') {
        return sendJson(res, 200, statePayload(store, orchestrator));
      }

      // Diagnose Fabric notifications: report what's configured + send a test alert,
      // so the admin can see exactly why screen-offline alerts aren't arriving.
      if (pathname === '/api/notify-test' && method === 'POST') {
        const base = config.omosBaseUrl;
        const hasSecret = !!config.omosAppSecret;
        const baseUrlLoopback = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[?::1)/i.test(base);
        let result: { delivered: boolean; reason?: string } = { delivered: false, reason: 'no-fabric' };
        if (base && hasSecret) {
          result = await notify({
            title: 'OpenMasjid Display — test',
            text: '✅ Test alert from OpenMasjid Display. If you see this, screen-offline alerts will reach you here.',
            level: 'info',
          });
        }
        // baseUrl + appId are the platform's own (non-secret) injected env — surfaced so
        // the admin can see EXACTLY which of the three the platform did/didn't inject.
        return sendJson(res, 200, { baseUrlSet: !!base, hasSecret, baseUrlLoopback, baseUrl: base, appId: config.omosAppId, ...result });
      }

      if (pathname === '/api/settings' && method === 'PUT') {
        const body = await readBody(req);
        store.update((db) => {
          db.settings = normSettings(body, db.settings);
        });
        return sendJson(res, 200, store.db.settings);
      }

      // ---- Volunteer mode config (enable + 4-digit PIN) -------------------
      if (pathname === '/api/volunteer-config' && method === 'PUT') {
        const body = await readBody(req);
        const enabled = body.enabled === true;
        const pinRaw = body.pin == null ? undefined : String(body.pin).trim();
        // A change to the PIN: '' clears it, 4-8 digits sets it, anything else is rejected.
        if (pinRaw !== undefined && pinRaw !== '' && !/^\d{4,8}$/.test(pinRaw)) {
          return sendJson(res, 400, { error: 'The PIN must be 4 to 8 digits.' });
        }
        const willHavePin = pinRaw === '' ? false : pinRaw ? true : !!store.db.volunteerAuth;
        if (enabled && !willHavePin) {
          return sendJson(res, 400, { error: 'Choose a 4-digit PIN before turning on the volunteer page.' });
        }
        store.update((db) => {
          if (pinRaw === '') db.volunteerAuth = null;
          else if (pinRaw) db.volunteerAuth = hashPassword(pinRaw);
          db.settings.volunteerEnabled = enabled;
        });
        return sendJson(res, 200, { ok: true, enabled, pinSet: !!store.db.volunteerAuth });
      }

      // ---- Timetables ------------------------------------------------------
      if (pathname === '/api/timetables' && method === 'POST') {
        if (atCap(res, store.db.timetables)) return;
        const body = await readBody(req);
        const tt = normTimetable(body);
        store.update((db) => void db.timetables.push(tt));
        return sendJson(res, 200, tt);
      }
      // Duplicate a timetable (so a near-identical screen needs only a small tweak).
      const dupMatch = /^\/api\/timetables\/([\w-]+)\/duplicate$/.exec(pathname);
      if (dupMatch && method === 'POST') {
        if (atCap(res, store.db.timetables)) return;
        const src = store.db.timetables.find((t) => t.id === dupMatch[1]);
        if (!src) return sendJson(res, 404, { error: 'Timetable not found.' });
        // normTimetable (no base) gives a fresh id + copies every form field; we then
        // graft back the endpoint-managed bits, copying uploaded files to the new id so
        // the duplicate owns its own assets (deleting the original can't affect it).
        const copy = normTimetable({ ...src, name: `${src.name} (copy)`.slice(0, 80) });
        if (src.iqamahYear) copy.iqamahYear = JSON.parse(JSON.stringify(src.iqamahYear));
        copy.backgroundImage = src.backgroundImage ? copyAsset(src.backgroundImage, copy.id, 'bg') : '';
        copy.logoImage = src.logoImage ? copyAsset(src.logoImage, copy.id, 'logo') : '';
        if (copy.announcements?.images?.length) {
          copy.announcements.images = (src.announcements?.images ?? [])
            .map((f) => copyAsset(f, copy.id, 'ann'))
            .filter(Boolean);
        }
        store.update((db) => void db.timetables.push(copy));
        return sendJson(res, 200, copy);
      }
      const ttMatch = /^\/api\/timetables\/([\w-]+)$/.exec(pathname);
      if (ttMatch) {
        const id = ttMatch[1];
        if (method === 'PUT') {
          const body = await readBody(req);
          const idx = store.db.timetables.findIndex((t) => t.id === id);
          if (idx < 0) return sendJson(res, 404, { error: 'Timetable not found.' });
          const updated = normTimetable(body, store.db.timetables[idx]);
          store.update((db) => void (db.timetables[idx] = updated));
          return sendJson(res, 200, updated);
        }
        if (method === 'DELETE') {
          removeBackground(id);
          removeLogo(id);
          removeAllAnnouncements(id);
          store.update((db) => void (db.timetables = db.timetables.filter((t) => t.id !== id)));
          return sendJson(res, 200, { ok: true });
        }
      }

      // ---- Timetable custom background ------------------------------------
      const bgMatch = /^\/api\/timetables\/([\w-]+)\/background$/.exec(pathname);
      if (bgMatch) {
        const id = bgMatch[1];
        const idx = store.db.timetables.findIndex((t) => t.id === id);
        if (idx < 0) return sendJson(res, 404, { error: 'Timetable not found.' });
        if (method === 'POST') {
          const body = await readBody(req, 8_000_000);
          const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(body.data ?? ''));
          if (!m || !isAllowedImageMime(m[1])) {
            return sendJson(res, 400, { error: 'Please choose a PNG, JPG, WebP or GIF image.' });
          }
          let buf: Buffer;
          try {
            buf = Buffer.from(m[2], 'base64');
          } catch {
            return sendJson(res, 400, { error: 'That image could not be read.' });
          }
          if (buf.length > 6_000_000) {
            return sendJson(res, 400, { error: 'That image is too large — please keep it under about 6 MB.' });
          }
          const file = saveBackground(id, m[1], buf);
          store.update((db) => void (db.timetables[idx].backgroundImage = file));
          return sendJson(res, 200, store.db.timetables[idx]);
        }
        if (method === 'DELETE') {
          removeBackground(id);
          store.update((db) => void (db.timetables[idx].backgroundImage = ''));
          return sendJson(res, 200, store.db.timetables[idx]);
        }
      }

      // ---- Timetable masjid logo ------------------------------------------
      const logoMatch = /^\/api\/timetables\/([\w-]+)\/logo$/.exec(pathname);
      if (logoMatch) {
        const id = logoMatch[1];
        const idx = store.db.timetables.findIndex((t) => t.id === id);
        if (idx < 0) return sendJson(res, 404, { error: 'Timetable not found.' });
        if (method === 'POST') {
          const body = await readBody(req, 4_000_000);
          const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(body.data ?? ''));
          if (!m || !isAllowedImageMime(m[1])) {
            return sendJson(res, 400, { error: 'Please choose a PNG, JPG, WebP, GIF or SVG image.' });
          }
          let buf: Buffer;
          try {
            buf = Buffer.from(m[2], 'base64');
          } catch {
            return sendJson(res, 400, { error: 'That image could not be read.' });
          }
          if (buf.length > 2_500_000) {
            return sendJson(res, 400, { error: 'That logo is too large — please keep it under about 2 MB.' });
          }
          const file = saveLogo(id, m[1], buf);
          store.update((db) => void (db.timetables[idx].logoImage = file));
          return sendJson(res, 200, store.db.timetables[idx]);
        }
        if (method === 'DELETE') {
          removeLogo(id);
          store.update((db) => void (db.timetables[idx].logoImage = ''));
          return sendJson(res, 200, store.db.timetables[idx]);
        }
      }

      // ---- Timetable yearly Iqamah CSV (import / export / template / clear) ----
      const csvMatch = /^\/api\/timetables\/([\w-]+)\/iqamah-csv$/.exec(pathname);
      if (csvMatch) {
        const id = csvMatch[1];
        const idx = store.db.timetables.findIndex((t) => t.id === id);
        if (idx < 0) return sendJson(res, 404, { error: 'Timetable not found.' });
        if (method === 'POST') {
          const body = await readBody(req, 2_000_000);
          const parsed = parseIqamahCsv(String(body.data ?? ''));
          if (parsed.rows === 0) {
            return sendJson(res, 400, {
              error: parsed.errors[0] ?? 'No usable rows found. Each row needs a date and at least one time.',
            });
          }
          store.update((db) => void (db.timetables[idx].iqamahYear = parsed.data));
          return sendJson(res, 200, { ok: true, rows: parsed.rows, errors: parsed.errors.slice(0, 5) });
        }
        if (method === 'GET') {
          const mode = url.searchParams.get('mode');
          const tt = store.db.timetables[idx];
          const csv = mode === 'template' ? templateCsv(tt) : toCsv(tt.iqamahYear);
          const fname = mode === 'template' ? 'iqamah-template.csv' : 'iqamah-times.csv';
          res.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="${fname}"`,
            'cache-control': 'no-store',
          });
          res.end(csv);
          return;
        }
        if (method === 'DELETE') {
          store.update((db) => void delete db.timetables[idx].iqamahYear);
          return sendJson(res, 200, store.db.timetables[idx]);
        }
      }

      // ---- Yearly Iqamah times set from the in-app monthly editor ----------
      const iyMatch = /^\/api\/timetables\/([\w-]+)\/iqamah-year$/.exec(pathname);
      if (iyMatch && method === 'PUT') {
        const id = iyMatch[1];
        const idx = store.db.timetables.findIndex((t) => t.id === id);
        if (idx < 0) return sendJson(res, 404, { error: 'Timetable not found.' });
        const body = await readBody(req, 2_000_000);
        const year = normalizeIqamahYear(body.year);
        store.update((db) => {
          if (Object.keys(year).length) db.timetables[idx].iqamahYear = year;
          else delete db.timetables[idx].iqamahYear;
        });
        return sendJson(res, 200, { ok: true, rows: Object.keys(year).length });
      }

      // ---- Announcement slideshow images ----------------------------------
      const annMatch = /^\/api\/timetables\/([\w-]+)\/announcements$/.exec(pathname);
      if (annMatch && method === 'POST') {
        const id = annMatch[1];
        const idx = store.db.timetables.findIndex((t) => t.id === id);
        if (idx < 0) return sendJson(res, 404, { error: 'Timetable not found.' });
        const body = await readBody(req, 8_000_000);
        const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(body.data ?? ''));
        if (!m || !isAllowedImageMime(m[1])) {
          return sendJson(res, 400, { error: 'Please choose a PNG, JPG, WebP or GIF image.' });
        }
        let buf: Buffer;
        try {
          buf = Buffer.from(m[2], 'base64');
        } catch {
          return sendJson(res, 400, { error: 'That image could not be read.' });
        }
        if (buf.length > 6_000_000) {
          return sendJson(res, 400, { error: 'That image is too large — please keep it under about 6 MB.' });
        }
        const file = saveAnnouncement(id, m[1], buf);
        store.update((db) => {
          const a = db.timetables[idx].announcements ?? {
            enabled: false, images: [], start: '', end: '', everySeconds: 60, forSeconds: 20, imageSeconds: 8,
          };
          a.images = [...a.images, file].slice(0, 30);
          db.timetables[idx].announcements = a;
        });
        return sendJson(res, 200, store.db.timetables[idx]);
      }
      const annFileMatch = /^\/api\/timetables\/([\w-]+)\/announcements\/(.+)$/.exec(pathname);
      if (annFileMatch && (method === 'DELETE' || method === 'GET')) {
        const id = annFileMatch[1];
        const file = decodeURIComponent(annFileMatch[2]);
        const idx = store.db.timetables.findIndex((t) => t.id === id);
        if (idx < 0) return sendJson(res, 404, { error: 'Timetable not found.' });
        if (method === 'GET') {
          // Serve the image so the editor can show a thumbnail (must belong to this id).
          const f = file.startsWith(`${id}.ann.`) ? uploadFilePath(file) : null;
          if (!f) return sendJson(res, 404, { error: 'Image not found.' });
          // Defense-in-depth: this serves user-uploaded files raw with their real type.
          // An uploaded SVG is active content, so stop the browser sniffing the type and
          // sandbox it (no scripts, same-origin only) so it can't run JS in our origin.
          res.writeHead(200, {
            'content-type': f.mime,
            'cache-control': 'private, max-age=300',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
          });
          fs.createReadStream(f.path).pipe(res);
          return;
        }
        // Only delete a file that actually belongs to THIS timetable (same guard as GET).
        if (file.startsWith(`${id}.ann.`)) removeAnnouncement(file);
        store.update((db) => {
          const a = db.timetables[idx].announcements;
          if (a) a.images = a.images.filter((f) => f !== file);
        });
        return sendJson(res, 200, store.db.timetables[idx]);
      }

      // ---- Sources ---------------------------------------------------------
      // Diagnostic: actually try to connect to a camera/stream URL and report why it
      // won't load. Sanitised through normSource so only stream schemes are probed.
      if (pathname === '/api/sources/test' && method === 'POST') {
        const body = await readBody(req);
        const url = normSource({ url: (body as { url?: unknown }).url }).url;
        if (!url) return sendJson(res, 400, { error: 'Enter a camera link starting with rtsp:// or rtsps://.' });
        const result = await probeSource(url);
        return sendJson(res, 200, result);
      }
      if (pathname === '/api/sources' && method === 'POST') {
        if (atCap(res, store.db.sources)) return;
        const body = await readBody(req);
        const src = normSource(body);
        store.update((db) => void db.sources.push(src));
        return sendJson(res, 200, src);
      }
      const srcMatch = /^\/api\/sources\/([\w-]+)$/.exec(pathname);
      if (srcMatch) {
        const id = srcMatch[1];
        if (method === 'PUT') {
          const body = await readBody(req);
          const idx = store.db.sources.findIndex((s) => s.id === id);
          if (idx < 0) return sendJson(res, 404, { error: 'Source not found.' });
          const updated = normSource(body, store.db.sources[idx]);
          store.update((db) => void (db.sources[idx] = updated));
          return sendJson(res, 200, updated);
        }
        if (method === 'DELETE') {
          store.update((db) => void (db.sources = db.sources.filter((s) => s.id !== id)));
          return sendJson(res, 200, { ok: true });
        }
      }

      // ---- Screens (TVs) ---------------------------------------------------
      if (pathname === '/api/tvs' && method === 'POST') {
        if (atCap(res, store.db.tvs)) return;
        const body = await readBody(req);
        const tv = normTv(body);
        store.update((db) => void db.tvs.push(tv));
        return sendJson(res, 200, tv);
      }
      const tvMatch = /^\/api\/tvs\/([\w-]+)$/.exec(pathname);
      if (tvMatch) {
        const id = tvMatch[1];
        if (method === 'PUT') {
          const body = await readBody(req);
          const idx = store.db.tvs.findIndex((t) => t.id === id);
          if (idx < 0) return sendJson(res, 404, { error: 'Screen not found.' });
          const updated = normTv(body, store.db.tvs[idx]);
          store.update((db) => void (db.tvs[idx] = updated));
          return sendJson(res, 200, updated);
        }
        if (method === 'DELETE') {
          store.update((db) => void (db.tvs = db.tvs.filter((t) => t.id !== id)));
          return sendJson(res, 200, { ok: true });
        }
      }
      const setMatch = /^\/api\/tvs\/([\w-]+)\/set$/.exec(pathname);
      if (setMatch && method === 'POST') {
        const id = setMatch[1];
        const body = await readBody(req);
        const idx = store.db.tvs.findIndex((t) => t.id === id);
        if (idx < 0) return sendJson(res, 404, { error: 'Screen not found.' });
        const content = normContent(body.content);
        const untilRaw = body.until == null ? null : Number(body.until);
        // Clamp to a sane future window (now .. +30 days); past/garbage → no expiry.
        const until = untilRaw != null && Number.isFinite(untilRaw) && untilRaw > Date.now() ? Math.min(untilRaw, Date.now() + 30 * 86400000) : null;
        store.update((db) => {
          db.tvs[idx].override = { content, until };
        });
        return sendJson(res, 200, store.db.tvs[idx]);
      }
      const resumeMatch = /^\/api\/tvs\/([\w-]+)\/resume$/.exec(pathname);
      if (resumeMatch && method === 'POST') {
        const id = resumeMatch[1];
        const idx = store.db.tvs.findIndex((t) => t.id === id);
        if (idx < 0) return sendJson(res, 404, { error: 'Screen not found.' });
        store.update((db) => void (db.tvs[idx].override = null));
        return sendJson(res, 200, store.db.tvs[idx]);
      }

      // ---- Schedules -------------------------------------------------------
      if (pathname === '/api/schedules' && method === 'POST') {
        if (atCap(res, store.db.schedules)) return;
        const body = await readBody(req);
        const rule = normSchedule(body);
        store.update((db) => void db.schedules.push(rule));
        return sendJson(res, 200, rule);
      }
      const ruleMatch = /^\/api\/schedules\/([\w-]+)$/.exec(pathname);
      if (ruleMatch) {
        const id = ruleMatch[1];
        if (method === 'PUT') {
          const body = await readBody(req);
          const idx = store.db.schedules.findIndex((r) => r.id === id);
          if (idx < 0) return sendJson(res, 404, { error: 'Schedule not found.' });
          const updated = normSchedule(body, store.db.schedules[idx]);
          store.update((db) => void (db.schedules[idx] = updated));
          return sendJson(res, 200, updated);
        }
        if (method === 'DELETE') {
          store.update((db) => void (db.schedules = db.schedules.filter((r) => r.id !== id)));
          return sendJson(res, 200, { ok: true });
        }
      }

      // ---- Timetable PNG preview ------------------------------------------
      // Live preview of unsaved edits (POST the form body) or the stored one (GET by id).
      if (pathname === '/api/preview' && method === 'POST') {
        const body = await readBody(req);
        // Base the preview on the STORED timetable so fields the validator strips
        // (managed by dedicated endpoints — notably the CSV-imported iqamahYear) still
        // appear in the live preview of unsaved edits.
        const pvBase = typeof body.id === 'string' && body.id ? store.db.timetables.find((t) => t.id === body.id) : undefined;
        const tt = normTimetable(body, pvBase);
        // Background + logo are stripped by the validator, so take them from the raw
        // body — an unsaved upload should still appear in the live preview.
        const bgFile = typeof body.backgroundImage === 'string' ? body.backgroundImage : '';
        const logoFile = typeof body.logoImage === 'string' ? body.logoImage : '';
        const width = tt.orientation === 'portrait' ? 540 : 960;
        const png = await renderPreviewPng(tt, Date.now(), width, bgFile, logoFile);
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        res.end(png);
        return;
      }
      // Click-to-edit regions for the live editor (fractional coordinates).
      if (pathname === '/api/preview-meta' && method === 'POST') {
        const body = await readBody(req);
        const pvBase = typeof body.id === 'string' && body.id ? store.db.timetables.find((t) => t.id === body.id) : undefined;
        const tt = normTimetable(body, pvBase);
        const hotspots = await renderPreviewMeta(tt, Date.now());
        return sendJson(res, 200, { hotspots });
      }
      // Printable month of prayer times (browser "Save as PDF").
      const printMatch = /^\/api\/timetables\/([\w-]+)\/print$/.exec(pathname);
      if (printMatch && method === 'GET') {
        const tt = store.db.timetables.find((t) => t.id === printMatch[1]);
        if (!tt) return sendJson(res, 404, { error: 'Timetable not found.' });
        if (tt.latitude == null || tt.longitude == null) {
          return sendJson(res, 400, { error: 'Add the masjid location before printing.' });
        }
        const now = localParts(new Date(), tt.timezone || undefined);
        const monthParam = url.searchParams.get('month');
        const ym = monthParam ? /^(\d{4})-(\d{2})$/.exec(monthParam) : null;
        const year = ym ? Number(ym[1]) : now.year;
        const mon = ym ? Number(ym[2]) : now.month;
        const html = renderMonthPrintHtml(tt, year, mon);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }
      // Embed info for the editor: the verified public (tunnel) URL if remote access
      // is on. The LAN URL + snippet are built CLIENT-side from window.location.origin
      // — the server can't know the scheme/port the admin is actually using (e.g. the
      // HTTPS proxy port), and guessing http:// produced a dead link against that TLS
      // port (NS_ERROR_NET_EMPTY_RESPONSE).
      const widgetInfoMatch = /^\/api\/timetables\/([\w-]+)\/widget-info$/.exec(pathname);
      if (widgetInfoMatch && method === 'GET') {
        const tt = store.db.timetables.find((t) => t.id === widgetInfoMatch[1]);
        if (!tt) return sendJson(res, 404, { error: 'Timetable not found.' });
        // Behind the admin's Cloudflare tunnel, the app's public base already includes
        // its path (e.g. https://masjid.org/display); the widget lives under /w/<id>.
        // But the tunnel may not actually route that path HERE (it can land on another
        // app), so only advertise the public URL once we've VERIFIED it reaches us.
        const site = await siteInfo();
        const publicConfigured = !!site?.enabled && !!site.publicUrl;
        let publicUrl = '';
        if (publicConfigured && tt.widget?.enabled) {
          const candidate = `${site!.publicUrl}/w/${tt.id}`;
          if (await widgetPublicWorks(`${candidate}.json`)) publicUrl = candidate;
        }
        return sendJson(res, 200, { enabled: !!tt.widget?.enabled, publicUrl, publicConfigured });
      }
      const prevMatch = /^\/api\/preview\/([\w-]+)$/.exec(pathname);
      if (prevMatch && method === 'GET') {
        const tt = store.db.timetables.find((t) => t.id === prevMatch[1]);
        if (!tt) return sendJson(res, 404, { error: 'Timetable not found.' });
        const width = tt.orientation === 'portrait' ? 540 : 960;
        const png = await renderPreviewPng(tt, Date.now(), width, tt.backgroundImage || '', tt.logoImage || '');
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        res.end(png);
        return;
      }

      return sendJson(res, 404, { error: 'Not found.' });
    } catch (err) {
      log.error(`${method} ${pathname}`, err);
      if (!res.headersSent) sendJson(res, 400, { error: 'Something went wrong with that request.' });
    }
  };
}

export type { DB };
