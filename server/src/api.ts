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
  isSecureRequest,
} from './auth';
import { probePlatform, ssoConfigured, notify, siteInfo, whatsappAvailability, whatsappGroups } from './fabric';
import { decideAnnounce, announceMessage, announceCaptionFor, type WhatsAppAnnouncer } from './whatsappAnnounce';
import type { FabricCommands } from './fabricCommands';
import {
  findByToken,
  webScreenState,
  markWebScreenSeen,
  hlsTargetFor,
  WEB_POLL_MS,
} from './webScreen';
import { clockSuspect } from './render/renderer';
import { SECURITY_HEADERS, sendJson, readJsonBody } from './httpio';
import { widgetPayload } from './render/svg';
import { renderWidgetHtml } from './widget';
import { LoginLimiter, RequestLimiter } from './rateLimit';
import { parseChangelog, readChangelog } from './changelog';
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
  sniffImageMime,
  isRenderableImageMime,
  copyAsset,
  logoDataUri,
} from './render/background';
import { renderPreviewPng, renderPreviewMeta, renderAnnouncePng } from './render/renderPool';
import { probeSource } from './render/renderer';
import { backgroundTone as renderBackgroundTone } from './render/renderPool';
import { parseIqamahCsv, toCsv, templateCsv, normalizeIqamahYear } from './iqamahCsv';
import { normalizeIqamahSchedule } from './iqamahSchedule';
import { renderMonthPrintHtml } from './print';
import { localParts, zonedNoon } from './prayer/engine';
import { resolveTv } from './scheduler';
import {
  normTimetable,
  normSource,
  normTv,
  normSchedule,
  normSettings,
  normContent,
} from './validate';
import type { DB, Timetable } from './types';

const log = makeLog('api');

// Marker embedded in the widget JSON so we can confirm a candidate PUBLIC (tunnel)
// URL actually reaches THIS app before we hand it to the admin as the embed link.
const WIDGET_APP_MARKER = 'openmasjid-display';

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
  /** The volunteer-page handler, also mounted here (under /volunteer) so the volunteer UI
   *  rides the OS tunnel on the main port without the platform routing its own port. */
  volunteer: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** Posts the Iqāmah-change notice to the masjid's WhatsApp group. Optional so tests and the
   *  volunteer-only paths can build an API without a background job attached. */
  whatsapp?: WhatsAppAnnouncer;
  /** Serves POST /fabric/commands/run — the platform running an admin's WhatsApp command.
   *  Optional: without it the endpoint answers 503 "not ready" rather than 404, which is the
   *  contract's word for "this app cannot do that yet". */
  commands?: FabricCommands;
}

/** The instant to render a preview at: local noon on `dateStr` (YYYY-MM-DD) in the
 *  timetable's timezone when a valid date is given, else "now". Lets the admin preview
 *  the screen as it will look on a specific day (e.g. to confirm a per-day Iqamah change). */
function previewInstant(dateStr: unknown, timezone?: string): number {
  const m = typeof dateStr === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr) : null;
  if (!m) return Date.now();
  const y = +m[1];
  const mo = +m[2];
  const da = +m[3];
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return Date.now();
  return zonedNoon(y, mo, da, timezone || undefined).getTime();
}

const readBody = (req: IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown>> =>
  readJsonBody(req, maxBytes);

/** Validate an uploaded image by its BYTES (not the browser's extension-derived label) and
 *  return the true mime to store — or a friendly error. Browsers label an upload's data-URI
 *  by file extension, so a JPEG named "logo.png" arrives as image/png and the display's SVG
 *  renderer then can't decode it (blank). Trusting the bytes fixes that; WebP has no renderer. */
function checkUploadedImage(buf: Buffer): { mime: string } | { error: string } {
  const sniffed = sniffImageMime(buf);
  if (!sniffed) return { error: 'That file isn’t a supported image. Please upload a PNG, JPG, GIF or SVG.' };
  if (!isRenderableImageMime(sniffed)) return { error: 'WebP images aren’t supported on the display yet — please upload a PNG, JPG, GIF or SVG.' };
  return { mime: sniffed };
}

function serveStatic(res: ServerResponse, pathname: string): boolean {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // Behind the OS tunnel the app is served under /<appId>/…, so its bundle assets arrive as
  // /<appId>/assets/… (the volunteer page's index.html repoints them there). Strip that one
  // leading segment so they resolve to the real file; plain /assets/… (LAN) is untouched.
  const pfx = /^[^/]+\/(assets\/.+)$/.exec(rel);
  if (pfx) rel = pfx[1];
  const full = path.resolve(config.publicDir, rel);
  // Prevent path traversal outside the public dir (anchor with a trailing separator
  // so a sibling dir sharing the prefix can't slip through).
  const root = path.resolve(config.publicDir);
  if (full !== root && !full.startsWith(root + path.sep)) return false;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(full).pipe(res);
  return true;
}

/**
 * The `/<appId>` prefix this request arrived under, or '' on the LAN.
 *
 * Behind the tunnel the platform serves us at /<appId>/… and does NOT strip the prefix, so a
 * page must build its own URLs with it or every fetch lands on the platform root. Derived from
 * the request rather than configured, so it is right whichever way the screen was opened.
 */
function basePathPrefix(pathname: string): string {
  const m = /^(\/[a-z0-9-]+)\/s\//.exec(pathname);
  return m ? m[1] : '';
}

/**
 * Serve the browser-screen page.
 *
 * A second Vite entry (`screen.html`), not the control panel: it must boot straight into the
 * display with no auth, no React router and none of the panel's bundle. Its asset URLs are
 * rewritten under the tunnel prefix exactly as the volunteer page does — an absolute
 * /assets/… from a page at /display/s/<token> would be fetched from the platform root.
 */
function serveScreenPage(res: ServerResponse, basePrefix: string): void {
  const file = path.join(config.publicDir, 'screen.html');
  if (!fs.existsSync(file)) {
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
    res.end('OpenMasjid Display is running, but the screen page was not built.');
    return;
  }
  let html = fs.readFileSync(file, 'utf8');
  if (basePrefix) html = html.replace(/="\/assets\//g, `="${basePrefix}/assets/`);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': MIME['.html'],
    // Never cache the shell: it carries the asset hashes, so a stale one pins a screen to an
    // old bundle until someone physically reboots the television.
    'cache-control': 'no-store',
  });
  res.end(html);
}

/**
 * Auto text contrast and auto accent for a wallpaper photo.
 *
 * Both need the DECODED image, which is why they live on the server for a browser screen too:
 * the render worker already samples the photo for the video pipeline, and having the browser
 * do its own sampling would be a second implementation of a value that must match exactly.
 */
async function backgroundTone(tt: Timetable): Promise<{ bgLight: boolean; autoAccent: string | null }> {
  try {
    return await renderBackgroundTone(tt);
  } catch {
    // A tone we cannot compute is not worth failing a screen over; the theme's own colours
    // are a perfectly good answer.
    return { bgLight: false, autoAccent: null };
  }
}

function serveIndex(res: ServerResponse): void {
  const idx = path.join(config.publicDir, 'index.html');
  if (fs.existsSync(idx)) {
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
    fs.createReadStream(idx).pipe(res);
  } else {
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
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
    // The built-in library of ahadith on Salāh (id + English + citation + shipped salah
    // targeting) so the panel can render the enable/disable checklist and prayer pickers.
    // Arabic isn't sent — the panel only toggles/targets them.
    hadithDefaults: DEFAULT_SALAH_HADITH.map((h) => ({ id: h.id, en: h.en, cite: h.cite, prayers: h.prayers })),
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
  const { store, orchestrator, volunteer, whatsapp, commands } = deps;
  const loginLimiter = new LoginLimiter();
  // Public widget: 120 requests per minute per CLIENT. The embedded page polls every 30s,
  // so a real viewer uses ~2 (a few more with several tabs); this only bites on abuse.
  // Keyed via clientKey(), which prefers X-Forwarded-For's first hop — keying on the socket
  // meant every visitor arriving through the remote-access tunnel shared ONE bucket, so a
  // masjid's own website visitors throttled each other. (DISPLAY-017)
  const widgetLimiter = new RequestLimiter(120, 60_000);
  // Admin commands: the platform already rate-limits each sender (5 per 15s), so this only
  // catches something reaching the port directly. Generous enough never to bite a real admin
  // working through the wizard one question at a time. Keyed on the SOCKET (the `true`), not
  // X-Forwarded-For: this one sits in front of a secret check, and a forged header would both
  // dodge the cap entirely and add a Map entry per request.
  const commandLimiter = new RequestLimiter(60, 60_000, true);
  // Browser screens: a screen polls its state twice a minute and heartbeats once a minute, so
  // a real one uses ~4/min. Generous enough for a masjid rebooting every television at once.
  const screenLimiter = new RequestLimiter(120, 60_000);
  setInterval(() => {
    widgetLimiter.prune();
    commandLimiter.prune();
    screenLimiter.prune();
  }, 5 * 60_000).unref?.();
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

      /**
       * The platform asking us to run a command an admin picked from a WhatsApp menu.
       *
       * Unauthenticated by SESSION on purpose — OpenMasjidOS has no cookie of ours. It
       * authenticates by presenting our OWN app secret plus a caller header, both checked
       * inside the handler, which is why this sits above the session gate rather than below
       * it. See fabricCommands.ts for why the exact path (never the tunnel's `/<basePath>/…`
       * form) is what keeps this LAN-only.
       */
      if (pathname === '/fabric/commands/run' && method === 'POST') {
        if (!commands) return sendJson(res, 503, { ok: false, code: 'not_ready' });
        if (!commandLimiter.allow(req)) return sendJson(res, 429, { ok: false, error: 'Too many requests.' });
        // The platform caps its own request at 4 KB; ours is the same order, and a body that
        // large from here would already be a bug rather than an admin typing a prayer time.
        const body = await readBody(req, 8_000).catch(() => null);
        if (!body) return sendJson(res, 400, { ok: false, error: 'Could not read that request.' });
        return commands.handle(req, res, body);
      }

      // ---- Volunteer page (also served here, not just on its own port) ----
      // So it works behind the OS Cloudflare tunnel at /<appId>/volunteer with NO platform
      // routing of the second port. Any volunteer path (optionally behind the /<appId> tunnel
      // prefix) is handed to the volunteer handler, which does its OWN PIN auth and never
      // exposes an admin endpoint (so this can't become an admin bypass). Its bundle assets
      // ride the main /<appId>/assets/… path, handled by serveStatic below. Gated by the
      // `volunteerRemote` setting (default on) — turn it off to keep the volunteer page on its
      // own LAN port only (then it's 404 here, and unreachable through the tunnel).
      if (/^(?:\/[a-z0-9-]+)?\/(volunteer(?:\/.*)?|api\/volunteer\/.+)$/.test(pathname)) {
        if (!store.db.settings.volunteerRemote) return sendJson(res, 404, { error: 'Not found.' });
        return volunteer(req, res);
      }

      // ---- Browser screens (beta): the page a TV/Raspberry Pi opens ---------------
      //
      // Unauthenticated, like the widget above and for the same reason: a television cannot
      // sign in. The 128-bit token in the URL IS the capability. An unknown token is a 404,
      // never a 403, so tokens cannot be probed.
      //
      // The optional `/<basePath>` prefix is what makes this work through the admin's
      // Cloudflare tunnel and therefore over HTTPS from anywhere — the platform serves this
      // app under /<appId>/ and does not strip the prefix. The page fetches relative to
      // itself, so the same markup works on the LAN and remotely with no configuration.
      const screenMatch = /^(?:\/[a-z0-9-]+)?\/s\/([A-Za-z0-9_-]{16,64})(\/state|\/seen|\/hls\/[\w.\-]{1,80}|\/asset\/([\w.\-]{1,120}))?$/.exec(pathname);
      if (screenMatch) {
        if (!screenLimiter.allow(req)) {
          res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '30', 'cache-control': 'no-store' });
          res.end('Too many requests.');
          return;
        }
        const tv = findByToken(store.db, screenMatch[1]);
        // 404 for an unknown token AND for a screen whose kind was changed back to rtsp —
        // an old URL must stop working, not start leaking.
        if (!tv || tv.kind !== 'web') {
          res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
          res.end('Not found.');
          return;
        }
        const sub = screenMatch[2] ?? '';

        // The heartbeat. A browser screen has no RTSP path, so this is what "online" means
        // for it — see webScreen.ts.
        if (sub === '/seen' && method === 'POST') {
          markWebScreenSeen(tv.id, Date.now());
          return sendJson(res, 200, { ok: true, pollMs: WEB_POLL_MS });
        }

        if (sub === '/state' && method === 'GET') {
          markWebScreenSeen(tv.id, Date.now());
          const basePrefix = basePathPrefix(pathname);
          const tt = store.db.timetables.find(
            (t) => t.id === resolveTv(tv, store.db.schedules, new Date(), store.db.settings.scheduleTimezone).content.id,
          );
          // Computed here rather than in the browser: both need the DECODED wallpaper, and a
          // second implementation would be a second answer.
          const tone = tt?.backgroundImage ? await backgroundTone(tt) : { bgLight: false, autoAccent: null };
          const state = webScreenState(store.db, tv, Date.now(), {
            basePrefix,
            clockSuspect: clockSuspect(),
            bgLight: tone.bgLight,
            autoAccent: tone.autoAccent,
          });
          res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(state));
          return;
        }

        // An uploaded background / logo / announcement image, scoped to this screen's token.
        const assetFile = screenMatch[3];
        if (assetFile && method === 'GET') {
          const found = uploadFilePath(assetFile);
          if (!found) {
            res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain' });
            res.end('Not found.');
            return;
          }
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'content-type': found.mime,
            // Uploads are content-addressed by filename and replaced under a new name, so a
            // long cache is safe and keeps a Pi off the network.
            'cache-control': 'public, max-age=86400',
          });
          fs.createReadStream(found.path).pipe(res);
          return;
        }

        // A camera / HDMI source, as HLS. The browser cannot play RTSP, so MediaMTX serves the
        // same stream in a container a browser can play and we pass it through — see
        // webScreen.hlsTargetFor for why this is scoped to the screen's CURRENT content.
        if (sub.startsWith('/hls/') && method === 'GET') {
          const target = hlsTargetFor(store.db, tv, Date.now(), sub.slice('/hls/'.length));
          if (!target) {
            res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain' });
            res.end('Not found.');
            return;
          }
          markWebScreenSeen(tv.id, Date.now());
          try {
            const upstream = await fetch(target, { redirect: 'error' });
            if (!upstream.ok || !upstream.body) {
              res.writeHead(upstream.status === 404 ? 404 : 502, { ...SECURITY_HEADERS, 'content-type': 'text/plain' });
              res.end('Stream not ready.');
              return;
            }
            res.writeHead(200, {
              ...SECURITY_HEADERS,
              'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
              // A playlist changes every segment; a segment never does. Getting this wrong
              // either stalls playback or re-downloads video that has not changed.
              'cache-control': /\.m3u8$/.test(sub) ? 'no-store' : 'public, max-age=60',
            });
            const reader = upstream.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!res.write(Buffer.from(value))) await new Promise((r) => res.once('drain', r));
            }
            res.end();
          } catch (err) {
            log.debug(`hls proxy failed: ${err instanceof Error ? err.message : err}`);
            if (!res.headersSent) {
              res.writeHead(502, { ...SECURITY_HEADERS, 'content-type': 'text/plain' });
              res.end('Stream unavailable.');
            } else res.end();
          }
          return;
        }

        // The page itself.
        if (!sub && method === 'GET') return serveScreenPage(res, basePathPrefix(pathname));
        res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain' });
        res.end('Not found.');
        return;
      }

      // ---- Public embeddable widget (no auth; only for opted-in timetables) ------
      // Matches /w/<id> and /w/<id>.json, optionally behind the Cloudflare-tunnel base
      // path (e.g. /display/w/<id>) — the widget polls a path relative to itself, so
      // it works both on the LAN and behind the tunnel.
      const widgetMatch = /^(?:\/[a-z0-9-]+)?\/w\/([\w-]+)(\.json)?$/.exec(pathname);
      if (widgetMatch && method === 'GET') {
        // Unauthenticated compute: every hit works out a focus day plus seven days of
        // prayer times and renders a page. It shares a CPU with the 1 fps render loop that
        // feeds the actual screens, so widget load can degrade the signage itself. The cap
        // is deliberately generous — a real viewer polls twice a minute, and throttling a
        // masjid's own website visitors would be worse than the load.
        if (!widgetLimiter.allow(req)) {
          // Keep the widget's OWN headers on the error path. Using SECURITY_HEADERS here
          // was wrong: it swapped `frame-ancestors *` for `'self'` and dropped the CORS
          // header, so a throttled widget didn't just fail — it failed in a way the
          // embedding page could neither render nor read.
          res.writeHead(429, {
            'content-type': 'text/plain; charset=utf-8',
            'retry-after': '60',
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
            'content-security-policy': 'frame-ancestors *',
            'x-content-type-options': 'nosniff',
          });
          res.end('Too many requests.');
          return;
        }
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
            // A few seconds of shared caching so a burst (or the Cloudflare tunnel in
            // front of a remote-access install) absorbs load instead of recomputing seven
            // days of prayer times per hit. Kept short on purpose: the page ticks its
            // countdown locally from `inSeconds`, so a few seconds of staleness is
            // invisible, but a long TTL would visibly skew it.
            'cache-control': 'public, max-age=5',
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
          // The shell only seeds the first paint and then re-fetches its own JSON, so it
          // can be cached longer than the data.
          'cache-control': 'public, max-age=30',
          // Deliberately permissive: this page EXISTS to be embedded in a masjid's own
          // website. Do not replace with the panel's frame-ancestors 'self'.
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
            res.setHeader('set-cookie', setCookieHeader(makeToken(store.secret, SSO_SESSION_MS), SSO_SESSION_MS, isSecureRequest(req)));
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
        res.setHeader('set-cookie', setCookieHeader(makeToken(store.secret), undefined, isSecureRequest(req)));
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === '/api/login' && method === 'POST') {
        const wait = loginLimiter.retryAfterMs(req);
        if (wait > 0) return sendJson(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.` });
        const body = await readBody(req);
        if (!store.db.admin) return sendJson(res, 400, { error: 'This panel has not been set up yet.' });
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

      // The release notes this build shipped with — the account menu's "What's new". Read
      // from disk per request (it changes only when the image does, and it is a few KB) and
      // parsed server-side so the parser is covered by the test suite; see changelog.ts.
      // Authenticated like everything else here: the notes aren't secret, but there is no
      // reason to answer an anonymous request, and it keeps this off the public surface.
      if (pathname === '/api/changelog' && method === 'GET') {
        return sendJson(res, 200, { releases: parseChangelog(readChangelog()) });
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
        if (src.iqamahSchedule) copy.iqamahSchedule = JSON.parse(JSON.stringify(src.iqamahSchedule));
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
          const chk = checkUploadedImage(buf);
          if ('error' in chk) return sendJson(res, 400, { error: chk.error });
          const file = saveBackground(id, chk.mime, buf);
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
          const chk = checkUploadedImage(buf);
          if ('error' in chk) return sendJson(res, 400, { error: chk.error });
          const file = saveLogo(id, chk.mime, buf);
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
          // Return the parsed map too, so the editor can update its shared copy in place
          // (the one-off editor + monthly table + CSV all edit the same iqamahYear).
          return sendJson(res, 200, { ok: true, rows: parsed.rows, errors: parsed.errors.slice(0, 5), data: parsed.data });
        }
        if (method === 'GET') {
          const mode = url.searchParams.get('mode');
          const tt = store.db.timetables[idx];
          const csv = mode === 'template' ? templateCsv(tt) : toCsv(tt.iqamahYear);
          const fname = mode === 'template' ? 'iqamah-template.csv' : 'iqamah-times.csv';
          res.writeHead(200, {
            ...SECURITY_HEADERS,
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

      // Scheduled "from this date onward" Iqamah changes (the recommended way to change
      // iqamah times a few times a year). Managed only here — a normal timetable save never
      // touches it (see validate.ts) — so the schedule survives every other edit.
      const isMatch = /^\/api\/timetables\/([\w-]+)\/iqamah-schedule$/.exec(pathname);
      if (isMatch && method === 'PUT') {
        const id = isMatch[1];
        const idx = store.db.timetables.findIndex((t) => t.id === id);
        if (idx < 0) return sendJson(res, 404, { error: 'Timetable not found.' });
        const body = await readBody(req, 2_000_000);
        const schedule = normalizeIqamahSchedule(body.schedule);
        store.update((db) => {
          if (schedule.length) db.timetables[idx].iqamahSchedule = schedule;
          else delete db.timetables[idx].iqamahSchedule;
        });
        return sendJson(res, 200, { ok: true, entries: schedule.length, schedule });
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
        const chk = checkUploadedImage(buf);
        if ('error' in chk) return sendJson(res, 400, { error: chk.error });
        const file = saveAnnouncement(id, chk.mime, buf);
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
        // Optional `previewDate` (YYYY-MM-DD) lets the admin see the screen AS IT WILL LOOK on
        // a chosen day — so a per-day Iqamah change set for a future date is verifiable now,
        // instead of only appearing on the masjid screen when that day arrives. Anchored at
        // local noon in the timetable's own timezone (a midday view of that calendar day).
        const nowMs = previewInstant(body.previewDate, tt.timezone);
        const png = await renderPreviewPng(tt, nowMs, width, bgFile, logoFile);
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/png', 'cache-control': 'no-store' });
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
      // The downloadable "Iqāmah times are changing" poster for the NEXT scheduled change —
      // the thing a masjid sends to its WhatsApp group and pins to the noticeboard. Served
      // as an attachment so the browser saves it rather than showing it.
      const annPosterMatch = /^\/api\/timetables\/([\w-]+)\/iqamah-change\.png$/.exec(pathname);
      if (annPosterMatch && method === 'GET') {
        const tt = store.db.timetables.find((t) => t.id === annPosterMatch[1]);
        if (!tt) return sendJson(res, 404, { error: 'Timetable not found.' });
        if (tt.latitude == null || tt.longitude == null) {
          return sendJson(res, 400, { error: 'Add the masjid location before making an announcement image.' });
        }
        let png: Buffer;
        try {
          png = await renderAnnouncePng(tt, Date.now());
        } catch (err) {
          // The only expected failure is "nothing scheduled ahead", which is a normal state
          // and not an error worth a 500 — the button is simply not applicable yet.
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('no upcoming Iqamah change')) {
            // Reached only when there is no change in EITHER direction within a year — the
            // renderer falls back to the most recent past one before giving up.
            return sendJson(res, 404, {
              error: 'There are no Iqamah changes to announce — nothing scheduled ahead, and none in the past year. Add one under “Scheduled Iqamah changes” (or import a CSV) first.',
            });
          }
          throw err;
        }
        const stamp = new Date().toISOString().slice(0, 10);
        const safeName = (tt.masjidName || 'masjid').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'masjid';
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'content-type': 'image/png',
          'content-disposition': `attachment; filename="${safeName}-iqamah-change-${stamp}.png"`,
          'cache-control': 'no-store',
        });
        res.end(png);
        return;
      }

      /**
       * Everything the WhatsApp settings section needs, in one call.
       *
       * `reason` decides which sentence the panel shows, and it is the platform's word, not
       * ours — "not set up", "no phone linked" and "the gateway is down" have completely
       * different fixes and none of them are this app's to guess at. `groups` holds only the
       * groups the ADMIN approved for us; an empty list means the feature stays hidden rather
       * than offering a switch that cannot work.
       *
       * `preview` is the exact message that would be posted. An admin is about to send
       * something to a few hundred people through a channel with no undo, so showing the real
       * text — not a description of it — is the least this can do.
       */
      if (pathname === '/api/whatsapp' && method === 'GET') {
        const status = await whatsappAvailability();
        // Only ask for groups when the platform says it can actually send; a 403/unreachable
        // answer here would just be a second failed round trip saying the same thing.
        const groups = status.available ? await whatsappGroups() : [];
        let preview: string | null = null;
        let previewNote: string | null = null;
        try {
          const d = decideAnnounce(store.db, Date.now(), true);
          // With media the poster carries the timetable and the message is a short caption;
          // without it the full notice IS the message. Preview whichever will actually go,
          // or the preview is of something that never gets sent.
          if (d.act === 'post') preview = status.media ? announceCaptionFor(d.target) : announceMessage(d.target);
          else previewNote = d.why;
        } catch (err) {
          log.debug(`whatsapp preview failed: ${err instanceof Error ? err.message : err}`);
          previewNote = 'Could not build a preview.';
        }
        return sendJson(res, 200, {
          ...status,
          groups,
          preview,
          previewNote,
          log: [...(store.db.whatsappLog ?? [])].reverse().slice(0, 40),
        });
      }

      /**
       * Post the notice now, at an admin's explicit request.
       *
       * This is the only way to send a correction: an automatic post happens exactly once per
       * change, so an admin who edits a time after the group was told needs a deliberate act
       * to tell them again. It bypasses the window and the dedupe for that reason, and is
       * logged with `manual: true` so the log distinguishes the two.
       */
      if (pathname === '/api/whatsapp/send-now' && method === 'POST') {
        if (!whatsapp) return sendJson(res, 503, { error: 'WhatsApp posting is not running.' });
        const r = await whatsapp.sendNow();
        // 202, matching the platform: accepted for later delivery is all anyone knows. The
        // pacing puts real delivery minutes away, and hours inside the masjid's quiet hours.
        if (!r.queued) return sendJson(res, 400, { error: r.reason ?? 'Could not queue the message.' });
        return sendJson(res, 202, { queued: true, asImage: !!r.asImage });
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
        // The regex constrains the SHAPE but not the range: `2026-00` rendered December
        // 2025 and `2026-99` a month in 2034, each headed with whatever month it landed on.
        // Reject rather than silently substitute — a printed calendar that is confidently
        // the wrong month is a bad thing to hand a congregation.
        if (ym && (mon < 1 || mon > 12 || year < 1970 || year > 2200)) {
          return sendJson(res, 400, { error: 'That month isn’t valid. Choose a month from 1 to 12.' });
        }
        const html = renderMonthPrintHtml(tt, year, mon);
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
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
        // The platform's /api/fabric/site is AUTHORITATIVE: it only returns a publicUrl
        // when the OS is actually routing this app's path to us (it checks its own
        // ingress table), so we can trust it directly. We no longer hairpin-probe the
        // URL from inside the container — that fetch is unreliable (container egress /
        // DNS / timing) even when real external visitors reach the path fine.
        const site = await siteInfo();
        const publicConfigured = !!site?.enabled && !!site.publicUrl;
        const publicUrl = publicConfigured && tt.widget?.enabled ? `${site!.publicUrl}/w/${tt.id}` : '';
        return sendJson(res, 200, { enabled: !!tt.widget?.enabled, publicUrl, publicConfigured });
      }

      // A browser screen's address, for the panel to hand to whoever is setting the TV up.
      // Same authoritative /api/fabric/site source as the widget and the volunteer page: the
      // platform only returns a publicUrl when it is actually routing this app's path, so a
      // remote television gets an HTTPS URL that works and a LAN-only install is told plainly
      // that there isn't one.
      const screenInfoMatch = /^\/api\/tvs\/([\w-]+)\/screen-info$/.exec(pathname);
      if (screenInfoMatch && method === 'GET') {
        const tv = store.db.tvs.find((t) => t.id === screenInfoMatch[1]);
        if (!tv) return sendJson(res, 404, { error: 'Screen not found.' });
        if (tv.kind !== 'web' || !tv.webToken) return sendJson(res, 200, { publicUrl: '', publicConfigured: false, path: '' });
        const site = await siteInfo();
        const publicConfigured = !!site?.enabled && !!site.publicUrl;
        return sendJson(res, 200, {
          path: `/s/${tv.webToken}`,
          publicUrl: publicConfigured ? `${site!.publicUrl}/s/${tv.webToken}` : '',
          publicConfigured,
        });
      }

      // The volunteer page's PUBLIC address behind the tunnel: the app's public base + /volunteer
      // (it now rides the main port). Same authoritative /api/fabric/site source as the widget.
      if (pathname === '/api/volunteer-info' && method === 'GET') {
        const remote = store.db.settings.volunteerRemote;
        const site = remote ? await siteInfo() : null;
        const publicConfigured = !!site?.enabled && !!site.publicUrl;
        const publicUrl = publicConfigured ? `${site!.publicUrl}/volunteer` : '';
        return sendJson(res, 200, { publicUrl, publicConfigured, remote });
      }
      const prevMatch = /^\/api\/preview\/([\w-]+)$/.exec(pathname);
      if (prevMatch && method === 'GET') {
        const tt = store.db.timetables.find((t) => t.id === prevMatch[1]);
        if (!tt) return sendJson(res, 404, { error: 'Timetable not found.' });
        const width = tt.orientation === 'portrait' ? 540 : 960;
        const nowMs = previewInstant(url.searchParams.get('date'), tt.timezone);
        const png = await renderPreviewPng(tt, nowMs, width, tt.backgroundImage || '', tt.logoImage || '');
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/png', 'cache-control': 'no-store' });
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
