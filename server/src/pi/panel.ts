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
import { config } from '../config';
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
import { createVolunteerApi } from '../volunteerApi';
import { normTimetable, normTv, normSettings, normSource, normSchedule } from '../validate';
import {
  saveLogo,
  removeLogo,
  saveBackground,
  removeBackground,
  saveAnnouncement,
  removeAnnouncement,
  uploadFilePath,
  sniffImageMime,
  isRenderableImageMime,
} from '../render/background';
import { saveSoundClip, removeSoundClipsFor, SOUND_MAX_UPLOAD_BYTES } from '../render/sound';
import { copyAsset } from '../render/background';
import { parseIqamahCsv, toCsv, templateCsv } from '../iqamahCsv';
import { normalizeIqamahSchedule } from '../iqamahSchedule';
import { renderMonthPrintHtml } from '../print';
import { localParts } from '../prayer/engine';
import { setupCodeMatches } from './claim';
import { isWifiAction, type WifiAction } from './control';
// Shared with the server deliberately: a file somebody uploaded is sandboxed the same way
// whoever is serving it. httpio imports nothing but node's own types, so the agent bundle pays
// nothing for this.
import { UPLOAD_HEADERS } from '../httpio';
import type { AgentConfig } from './agentConfig';

/**
 * The panel's own header set. A panel on a masjid's LAN gets the same treatment as one behind
 * the platform: there is no reason for the weaker set.
 *
 * It is NOT a copy of the server's, and the comment here used to say it mirrored them. The
 * server sends `content-security-policy: frame-ancestors 'self'`; this sends
 * `x-frame-options: DENY`, which is stricter — nothing frames a screen's own panel, not even
 * itself. Kept as it is; only the claim that it matched was wrong.
 */
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

/**
 * Port 80, so the address on the television is one somebody can type.
 *
 * The agent does NOT run as root to get it: the systemd unit grants
 * `CAP_NET_BIND_SERVICE` as an ambient capability, which is the whole of the privilege needed
 * to bind a low port. Overridable so a test, or a developer, can run this without it.
 */
export const PANEL_PORT = Number(process.env.OMD_PANEL_PORT || 80);

/**
 * The built web app on the device.
 *
 * Defaults to `config.publicDir` so there is ONE notion of where the bundle is: the volunteer
 * page is the server's own handler and reads `config.publicDir`, and two environment variables
 * pointing at the same directory is two chances to point at different ones.
 */
export const WEB_DIR = process.env.OMD_PANEL_WEB || config.publicDir;

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
  /**
   * The device itself, for the pages that are about the box rather than about the masjid.
   *
   * Optional only so the panel can be built in a test with no Raspberry Pi underneath it. On a
   * real screen it is always supplied, and the Wi-Fi section is hidden without it rather than
   * shown broken.
   */
  device?: PanelDevice;
}

export interface PanelDevice {
  /** this screen's own id, so the panel addresses it through the route it already knows */
  id: string;
  /**
   * How it is attached, and what it can see.
   *
   * Cheap by contract: the caller caches this and refreshes it in the background, because the
   * panel polls constantly and `nmcli` is a subprocess. A few seconds stale is the right answer
   * — somebody who just pulled a cable out sees it on the next poll, and the draw loop is not
   * made to wait for a network scan.
   */
  read: () => { net?: unknown; networks?: unknown; wifiResult?: unknown };
  /** Ask root for a Wi-Fi change. Returns null when the request was left, or why it was not. */
  wifi: (action: WifiAction, wifi?: { ssid: string; psk: string }) => string | null;
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
  const { store, readConfig, writeConfig, webDir, screens, device } = deps;
  const loginLimiter = new LoginLimiter();
  /**
   * The volunteer page, served by this same listener.
   *
   * The server runs it on a port of its own so a masjid can share just that address; a screen
   * has one port, so it lives at /volunteer here. It is the SAME handler — a volunteer switching
   * a screen with a PIN does the same thing on a Pi as on a server, including the rate limit on
   * the PIN, because there is only one of it.
   */
  const volunteer = createVolunteerApi({ store, orchestrator: screens });
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
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    try {
      // Before the session routes and before the bundle: the volunteer page has its own PIN
      // and its own cookie, and must not be behind the admin sign-in.
      if (/^\/(volunteer(?:\/.*)?|api\/volunteer\/.+)$/.test(pathname)) return void (await volunteer(req, res));

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
          // How this screen is attached. The server sends a list of devices; a standalone screen
          // IS the device, so it sends one object and the panel renders the same section against
          // it. Absent in a test with no Pi underneath, and the section hides itself.
          ...(device ? { pi: { id: device.id, ...device.read() } } : {}),
        });
      }

      /**
       * Wi-Fi, and ONLY Wi-Fi.
       *
       * The server's panel posts device commands to this path, so the same panel code reaches it
       * here unchanged. What it may ask for is a different question, and the answer is much
       * narrower than the server's: the five Wi-Fi verbs, nothing else.
       *
       * The narrowness is the point and it is not laziness. `reboot`, `update`, `reinstall` and a
       * root terminal are all verbs this device's spool WILL act on, and every one of them is
       * reachable here the moment this route forwards whatever it is given. A standalone panel has
       * no page that asks for them, so a request for one is not a feature nobody built — it is a
       * request nobody in this product can have meant. Adding one later means adding it here, on
       * purpose, with the page that needs it.
       */
      {
        const cmd = /^\/api\/pi\/([A-Za-z0-9_-]{1,64})\/command$/.exec(pathname);
        if (cmd && method === 'POST') {
          if (!device) return sendJson(res, 404, { error: 'This screen has no device controls.' });
          // Addressed to THIS screen or to nothing. There is exactly one device here.
          if (cmd[1] !== device.id) return sendJson(res, 404, { error: 'No such screen.' });
          const body = await readBody(req).catch(() => null);
          if (!body) return sendJson(res, 400, { error: 'Could not read that request.' });
          const action = body.action;
          if (!isWifiAction(action)) {
            return sendJson(res, 400, { error: 'This screen only accepts Wi-Fi changes here.' });
          }
          let wifi: { ssid: string; psk: string } | undefined;
          if (action === 'wifi-join') {
            const w = body.wifi as { ssid?: unknown; psk?: unknown } | undefined;
            const ssid = typeof w?.ssid === 'string' ? w.ssid : '';
            const psk = typeof w?.psk === 'string' ? w.psk : '';
            // Bounded here as well as by root. 32 is the limit of an SSID and 63 of a WPA
            // passphrase, so anything longer is not a network anybody can join.
            if (!ssid || ssid.length > 32 || psk.length > 63) {
              return sendJson(res, 400, { error: 'That network name or password is not usable.' });
            }
            wifi = { ssid, psk };
          }
          const why = device.wifi(action, wifi);
          if (why) return sendJson(res, 500, { error: why });
          return sendJson(res, 200, { queued: true });
        }
      }

      /**
       * The writes the panel makes.
       *
       * Through the same `normTimetable`/`normTv`/`normSettings` the server validates with, over
       * the same `Store` — so what a standalone screen accepts is what the server accepts, and a
       * timetable edited here and later imported there cannot mean two different things.
       *
       * shortcut: this is a focused set — timetables, sources, schedules, the one screen and the
       * settings — not every route the server serves. Uploads, the CSV importer and the Iqamah
       * wizard still answer 404 here. Upgrade by lifting the server's store-only routes into a
       * module both mount, which is the same move `statePayload` already made; it was not worth
       * doing before there was a second caller to prove the shape.
       */
      // A wallpaper is megabytes; a timetable is bytes. Read to whichever this path can be.
      const upload = /\/(background|logo|sound|announcements)$/.test(pathname);
      const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req, upload ? 8_000_000 : 2_000_000).catch(() => null);
      if (body === null) return sendJson(res, 400, { error: 'That request was too large.' });

      const idOf = (prefix: string): string => pathname.slice(prefix.length).split('/')[0];
      const saved = <T,>(v: T): void => sendJson(res, 200, v);

      // ── the one screen ─────────────────────────────────────────────────────
      if (pathname.startsWith('/api/tvs/')) {
        const id = idOf('/api/tvs/');
        const idx = store.db.tvs.findIndex((t) => t.id === id);
        if (idx < 0) return sendJson(res, 404, { error: 'Screen not found.' });
        if (pathname.endsWith('/set') && method === 'POST') {
          const until = typeof body.until === 'number' ? body.until : null;
          store.update((db) => {
            db.tvs[idx].override = { content: (body.content ?? { kind: 'off' }) as never, until };
          });
          return saved(store.db.tvs[idx]);
        }
        if (pathname.endsWith('/resume') && method === 'POST') {
          store.update((db) => void (db.tvs[idx].override = null));
          return saved(store.db.tvs[idx]);
        }
        if (method === 'PUT') {
          const updated = normTv(body, store.db.tvs[idx]);
          store.update((db) => void (db.tvs[idx] = updated));
          return saved(updated);
        }
      }

      /**
       * Pictures, and the sound.
       *
       * The same stores the server writes to — `render/background` and `render/sound` — so a
       * wallpaper uploaded here sits where the renderer already looks for it, and a timetable
       * carried to a server later still names a file that store understands.
       *
       * The image type comes from the BYTES, never the browser's label: a browser types a
       * data URI from the file extension, so a JPEG saved as "logo.png" arrives claiming to be
       * a PNG and resvg then picks its decoder from the lie and renders nothing.
       */
      const asset = /^\/api\/timetables\/([\w-]+)\/(background|logo|sound|announcements)(?:\/(.+))?$/.exec(pathname);
      if (asset) {
        const [, ttId, kind, annFile] = asset;
        const tt = store.db.timetables.find((t) => t.id === ttId);
        if (!tt) return sendJson(res, 404, { error: 'Timetable not found.' });
        const back = (): void => sendJson(res, 200, store.db.timetables.find((t) => t.id === ttId));

        // Serving one announcement picture back to the editor's preview.
        if (annFile && method === 'GET') {
          const found = uploadFilePath(decodeURIComponent(annFile));
          if (!found) return sendJson(res, 404, { error: 'Not found.' });
          // An uploaded file, so the sandboxing header set. This route was added with the
          // ordinary one, which is how it ended up being the fourth site to miss it.
          res.writeHead(200, { ...UPLOAD_HEADERS, 'content-type': found.mime, 'cache-control': 'private, max-age=300' });
          return void res.end(fs.readFileSync(found.path));
        }
        if (annFile && method === 'DELETE') {
          const name = decodeURIComponent(annFile);
          removeAnnouncement(name);
          store.update((db) => {
            const t = db.timetables.find((x) => x.id === ttId);
            if (t?.announcements) t.announcements.images = (t.announcements.images ?? []).filter((f) => f !== name);
          });
          return back();
        }

        if (method === 'POST') {
          const m = /^data:([^;,]*);base64,(.+)$/s.exec(String(body.data ?? ''));
          if (!m) return sendJson(res, 400, { error: 'That file could not be read.' });
          let buf: Buffer;
          try {
            buf = Buffer.from(m[2], 'base64');
          } catch {
            return sendJson(res, 400, { error: 'That file could not be read.' });
          }

          if (kind === 'sound') {
            if (buf.length > SOUND_MAX_UPLOAD_BYTES) return sendJson(res, 400, { error: 'That file is too large — please keep it under about 5 MB.' });
            const made = await saveSoundClip(ttId, buf);
            if ('error' in made) return sendJson(res, 400, { error: made.error });
            store.update((db) => {
              const t = db.timetables.find((x) => x.id === ttId);
              if (t) t.sound.clip = made.file;
            });
            return back();
          }

          const sniffed = sniffImageMime(buf);
          if (!sniffed || !isRenderableImageMime(sniffed)) {
            return sendJson(res, 400, { error: 'That file isn’t an image this screen can draw. Please use a PNG, JPG, GIF or SVG.' });
          }
          if (kind === 'logo') {
            const file = saveLogo(ttId, sniffed, buf);
            store.update((db) => {
              const t = db.timetables.find((x) => x.id === ttId);
              if (t) t.logoImage = file;
            });
            return back();
          }
          if (kind === 'background') {
            const file = saveBackground(ttId, sniffed, buf);
            store.update((db) => {
              const t = db.timetables.find((x) => x.id === ttId);
              if (t) t.backgroundImage = file;
            });
            return back();
          }
          const file = saveAnnouncement(ttId, sniffed, buf);
          store.update((db) => {
            const t = db.timetables.find((x) => x.id === ttId);
            if (!t) return;
            // A timetable nobody has opened the slideshow settings on has no announcements
            // object at all, and guarding on it meant the upload succeeded and stored nothing.
            // The defaults are normAnnouncements', so the first picture does not also invent
            // a different slideshow than the panel would have made.
            t.announcements ??= { enabled: false, images: [], start: '', end: '', everySeconds: 60, forSeconds: 20, imageSeconds: 8 };
            t.announcements.images = [...(t.announcements.images ?? []), file];
          });
          return back();
        }

        if (method === 'DELETE') {
          if (kind === 'logo') {
            removeLogo(ttId);
            store.update((db) => {
              const t = db.timetables.find((x) => x.id === ttId);
              if (t) t.logoImage = '';
            });
          } else if (kind === 'background') {
            removeBackground(ttId);
            store.update((db) => {
              const t = db.timetables.find((x) => x.id === ttId);
              if (t) t.backgroundImage = '';
            });
          } else if (kind === 'sound') {
            removeSoundClipsFor(ttId);
            store.update((db) => {
              const t = db.timetables.find((x) => x.id === ttId);
              if (t) t.sound.clip = '';
            });
          }
          return back();
        }
      }

      /**
       * The rest of what a timetable can do: a copy of it, the Iqāmah year as a spreadsheet, the
       * "from this date" changes, and a month to print.
       *
       * All of it store-only and all of it through the SAME helpers the server uses —
       * `parseIqamahCsv`, `normalizeIqamahSchedule`, `renderMonthPrintHtml` — so a masjid that
       * imports a spreadsheet here gets exactly what it would get there, down to which rows are
       * rejected and why.
       */
      const sub = /^\/api\/timetables\/([\w-]+)\/(duplicate|iqamah-schedule|iqamah-csv|print)$/.exec(pathname);
      if (sub) {
        const [, ttId, what] = sub;
        const tt = store.db.timetables.find((t) => t.id === ttId);
        if (!tt) return sendJson(res, 404, { error: 'Timetable not found.' });

        if (what === 'duplicate' && method === 'POST') {
          // The copy owns its own files, so deleting the original cannot blank it.
          const copy = normTimetable({ ...tt, name: `${tt.name} (copy)`.slice(0, 80) });
          if (tt.iqamahYear) copy.iqamahYear = JSON.parse(JSON.stringify(tt.iqamahYear));
          if (tt.iqamahSchedule) copy.iqamahSchedule = JSON.parse(JSON.stringify(tt.iqamahSchedule));
          copy.backgroundImage = tt.backgroundImage ? copyAsset(tt.backgroundImage, copy.id, 'bg') : '';
          copy.logoImage = tt.logoImage ? copyAsset(tt.logoImage, copy.id, 'logo') : '';
          if (copy.announcements) {
            copy.announcements.images = (tt.announcements?.images ?? [])
              .map((f) => copyAsset(f, copy.id, 'ann'))
              .filter(Boolean);
          }
          store.update((db) => void db.timetables.push(copy));
          return sendJson(res, 200, copy);
        }

        if (what === 'iqamah-schedule' && method === 'PUT') {
          const schedule = normalizeIqamahSchedule(body.schedule);
          store.update((db) => {
            const t = db.timetables.find((x) => x.id === ttId);
            if (!t) return;
            if (schedule.length) t.iqamahSchedule = schedule;
            else delete t.iqamahSchedule;
          });
          return sendJson(res, 200, { ok: true, entries: schedule.length, schedule });
        }

        if (what === 'iqamah-csv') {
          if (method === 'POST') {
            const parsed = parseIqamahCsv(String(body.data ?? ''));
            if (parsed.rows === 0) {
              return sendJson(res, 400, { error: parsed.errors[0] ?? 'No usable rows found. Each row needs a date and at least one time.' });
            }
            store.update((db) => {
              const t = db.timetables.find((x) => x.id === ttId);
              if (t) t.iqamahYear = parsed.data;
            });
            return sendJson(res, 200, { ok: true, rows: parsed.rows, errors: parsed.errors.slice(0, 5), data: parsed.data });
          }
          if (method === 'GET') {
            const template = url.searchParams.get('mode') === 'template';
            const csv = template ? templateCsv(tt) : toCsv(tt.iqamahYear);
            res.writeHead(200, {
              ...SECURITY_HEADERS,
              'content-type': 'text/csv; charset=utf-8',
              'content-disposition': `attachment; filename="${template ? 'iqamah-template.csv' : 'iqamah-times.csv'}"`,
              'cache-control': 'no-store',
            });
            return void res.end(csv);
          }
          if (method === 'DELETE') {
            store.update((db) => {
              const t = db.timetables.find((x) => x.id === ttId);
              if (t) delete t.iqamahYear;
            });
            return sendJson(res, 200, store.db.timetables.find((t) => t.id === ttId));
          }
        }

        if (what === 'print' && method === 'GET') {
          if (tt.latitude == null || tt.longitude == null) {
            return sendJson(res, 400, { error: 'Add the masjid location before printing.' });
          }
          const now = localParts(new Date(), tt.timezone || undefined);
          const ym = /^(\d{4})-(\d{2})$/.exec(url.searchParams.get('month') ?? '');
          const year = ym ? Number(ym[1]) : now.year;
          const mon = ym ? Number(ym[2]) : now.month;
          // Rejected rather than silently substituted: a printed calendar that is confidently
          // the wrong month is a bad thing to hand a congregation.
          if (mon < 1 || mon > 12 || year < 1970 || year > 2200) {
            return sendJson(res, 400, { error: 'That month isn’t valid. Choose a month from 1 to 12.' });
          }
          res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          return void res.end(renderMonthPrintHtml(tt, year, mon));
        }
      }

      // ── timetables, sources, schedules ─────────────────────────────────────
      const collections = [
        { path: '/api/timetables', key: 'timetables' as const, norm: normTimetable },
        { path: '/api/sources', key: 'sources' as const, norm: normSource },
        { path: '/api/schedules', key: 'schedules' as const, norm: normSchedule },
      ];
      for (const c of collections) {
        if (pathname === c.path && method === 'POST') {
          const made = c.norm(body) as never;
          store.update((db) => void (db[c.key] as unknown[]).push(made));
          return saved(made);
        }
        if (pathname.startsWith(`${c.path}/`)) {
          const id = idOf(`${c.path}/`);
          const list = store.db[c.key] as { id: string }[];
          const idx = list.findIndex((x) => x.id === id);
          if (idx < 0) return sendJson(res, 404, { error: 'Not found.' });
          if (method === 'PUT') {
            const updated = c.norm(body, list[idx] as never) as never;
            store.update((db) => void ((db[c.key] as unknown[])[idx] = updated));
            return saved(updated);
          }
          if (method === 'DELETE') {
            store.update((db) => void ((db[c.key] as { id: string }[]) = (db[c.key] as { id: string }[]).filter((x) => x.id !== id)));
            return saved({ ok: true });
          }
        }
      }

      /**
       * The volunteer page's PIN, set from the admin panel.
       *
       * Deliberately the same rules the server applies: '' clears the PIN, 4-8 digits sets it,
       * and the page cannot be turned on without one — a volunteer page with no PIN is an open
       * control for every screen in the building, reachable by anyone on the network.
       */
      if (pathname === '/api/volunteer-config' && method === 'PUT') {
        const enabled = body.enabled === true;
        const pinRaw = body.pin == null ? undefined : String(body.pin).trim();
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

      if (pathname === '/api/settings' && method === 'PUT') {
        store.update((db) => void (db.settings = normSettings(body, db.settings)));
        return saved(store.db.settings);
      }

      return sendJson(res, 404, { error: 'Not found.' });
    } catch {
      return sendJson(res, 500, { error: 'Something went wrong on this screen.' });
    }
  };
}
