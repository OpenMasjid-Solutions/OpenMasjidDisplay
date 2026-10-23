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
import { saveSoundClip, setSoundClip, soundWav, SOUND_MAX_UPLOAD_BYTES } from '../render/sound';
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
import { normaliseServerOrigin, type AgentConfig } from './agentConfig';

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
  /**
   * How enrolment with a display server is going, once one has been set here.
   *
   * The panel only ever READS this. Nothing in this file starts, stops or restarts enrolment —
   * it writes the server address into the config and the agent's own loop notices on its next
   * pass. That is deliberate: a handler that could end the process would end it mid-response.
   *
   * Absent in a test, and on a screen that has never been pointed at a server.
   */
  linkState?: () => { code: string; connected: boolean; status: string };
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
  const { store, readConfig, writeConfig, webDir, screens, device, linkState } = deps;
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

        // Adhan and Iqamah each have a sound, so what follows /sound is the slot, not a file. All
        // of it is handled here: falling through, DELETE /sound/adhan would reach the
        // announcement branch below and try to delete a picture called "adhan".
        if (kind === 'sound') {
          const slot = annFile === 'adhan' || annFile === 'iqamah' ? annFile : null;
          if (!slot) return sendJson(res, 404, { error: 'Not found.' });
          if (method === 'GET') {
            // The panel's preview: what this slot plays, the built-in beep included.
            res.writeHead(200, { ...UPLOAD_HEADERS, 'content-type': 'audio/wav', 'cache-control': 'no-store' });
            return void res.end(soundWav(tt, slot));
          }
          if (method === 'DELETE') {
            store.update((db) => {
              const t = db.timetables.find((x) => x.id === ttId);
              if (t) setSoundClip(t.sound, slot, '');
            });
            return back();
          }
          if (method === 'POST') {
            const m = /^data:[^;,]*;base64,(.+)$/s.exec(String(body.data ?? ''));
            if (!m) return sendJson(res, 400, { error: 'That file could not be read.' });
            const buf = Buffer.from(m[1], 'base64');
            if (buf.length > SOUND_MAX_UPLOAD_BYTES) return sendJson(res, 400, { error: 'That file is too large — please keep it under about 5 MB.' });
            const made = await saveSoundClip(ttId, slot, buf);
            if ('error' in made) return sendJson(res, 400, { error: made.error });
            store.update((db) => {
              const t = db.timetables.find((x) => x.id === ttId);
              if (t) setSoundClip(t.sound, slot, made.file);
            });
            return back();
          }
          return sendJson(res, 405, { error: 'Not allowed.' });
        }

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

      /**
       * Which display server manages this screen — read, and set.
       *
       * ## One route, two callers, and that is the design rather than a coincidence
       *
       * It is reached by an admin signed in to THIS screen's panel, who types a server address;
       * and by a display SERVER, which signs in here with this screen's own password and then
       * hands over credentials for a screen it has already created. Both are the same act —
       * "this screen now belongs to that server" — and both have proved the same thing, because
       * the credential for both is this screen's admin password. A second route for the server
       * would be a second place to get the write wrong.
       *
       * What differs is only how much arrives. An admin sends an address, and the screen then
       * enrols and shows a pairing code for somebody to approve in that server's dashboard — the
       * server's admin gets to decide whether a screen joins their masjid, which is not something
       * whoever holds this Pi's password should be able to settle alone. A server sends the
       * address AND the credentials, because it has already made that decision by creating the
       * screen; there is nothing left to approve and no code to read.
       *
       * ## What this route does NOT do
       *
       * It does not restart anything, and it does not touch `trust.env`. The agent's own loop
       * re-reads the config every pass and acts on what it finds, so the only thing that happens
       * here is a file being written. `trust.env` is root-owned and names the address root will
       * fetch a script from and dial a root terminal out to; an address arriving over HTTP must
       * never reach it, which is exactly why the installer is still the only thing that writes
       * it. See docs/PI_ADOPTION.md for what that costs and how an admin gets it back.
       */
      if (pathname === '/api/pi/link' && method === 'GET') {
        const cfg = readConfig();
        /**
         * The enrolment status is reported only while there IS a server to enrol with.
         *
         * The agent's loop clears it on the pass after the address is withdrawn, and that pass can
         * be fifteen seconds away — it sleeps longer between attempts when it cannot reach
         * anything, which is exactly the case somebody cancels out of. Reading it here regardless
         * answers a request for "this screen has no server" with a sentence about failing to reach
         * one, which is a payload contradicting itself even if no page happens to render it.
         */
        const st = cfg?.server ? linkState?.() : undefined;
        return sendJson(res, 200, {
          server: cfg?.server ?? '',
          adopted: !!cfg?.token,
          code: st?.code ?? '',
          connected: st?.connected ?? false,
          status: st?.status ?? '',
        });
      }

      if (pathname === '/api/pi/link' && method === 'POST') {
        const cfg = readConfig();
        if (!cfg) return sendJson(res, 503, { error: 'This screen cannot read its own settings right now.' });

        /**
         * Normalised, not just checked. An address copied out of a browser's address bar carries a
         * query or a fragment, both of which pass the pattern and then swallow the path of every
         * URL the agent builds — see normaliseServerOrigin. The failure is silent and permanent,
         * so the shapes that cannot be part of an address are dropped here rather than stored.
         */
        const parsed = normaliseServerOrigin(String(body.server ?? ''));
        if ('error' in parsed) return sendJson(res, 400, { error: parsed.error });
        const server = parsed.origin;

        /**
         * Credentials, when a display server sent them — all three together or none at all.
         *
         * A token without the identity that earned it is a config this screen cannot enrol with
         * and cannot prove, and `parseConfig` would later refuse the whole file. Checking the trio
         * here turns that into a 400 somebody can read instead of a screen that comes back from
         * its next restart asking to be set up.
         */
        /**
         * A token already held means a handover is IN PROGRESS, and nothing else.
         *
         * This panel is served only while a screen is its own: once it has been adopted the agent
         * restarts and `managedPanel.ts` answers here instead. So the one window in which this
         * route can see a token is the five or six seconds between the credentials landing and
         * that restart — and both things reachable in that window are wrong.
         *
         * Adopting again creates a SECOND device and screen on the server while the first keeps
         * its token, leaving a row for a device that will never call: offline for ever on one
         * side, absent on the other. Clearing the address instead drops the token the screen has
         * just been given, so the screen stays standalone while the server keeps an adopted row
         * for it — the same orphan from the other direction.
         *
         * The panel no longer offers either, but a button is a courtesy and this is the rule. A
         * screen that genuinely needs to leave is released from the server that owns it, which is
         * also the only place that can tidy up its own row.
         */
        if (cfg.token) {
          return sendJson(res, 409, {
            error: 'This screen has already joined a display server and is handing over. Manage it from that server.',
          });
        }

        const deviceId = String(body.deviceId ?? '').trim();
        const deviceSecret = String(body.deviceSecret ?? '').trim();
        const token = String(body.token ?? '').trim();
        const credentials = [deviceId, deviceSecret, token];
        if (credentials.some(Boolean) && !credentials.every(Boolean)) {
          return sendJson(res, 400, { error: 'An adoption needs the device id, its secret and a token together.' });
        }
        if (token && !server) {
          return sendJson(res, 400, { error: 'A screen cannot hold a token for no server.' });
        }
        if (credentials.some((v) => v.length > 200 || /[^A-Za-z0-9_-]/.test(v))) {
          return sendJson(res, 400, { error: 'Those credentials are not shaped like ours.' });
        }

        /**
         * The config is written from what ARRIVED, so a token not supplied is a token removed.
         *
         * With the handover guard above, a token can never be present here to remove — the write
         * is stated this way because it is the rule, not because the branch is reachable. Stated
         * the other way round, as a merge, it would quietly keep a credential the new server has
         * never issued the first time that guard was relaxed; that server answers such a token
         * with a 404, and a 404 is what this agent reads as "I have been forgotten". The screen
         * would flip between the two states for ever and say nothing about why.
         */
        /**
         * The id being given up is reported back, and that is not bookkeeping.
         *
         * A server adopting by address mints a FRESH identity — it has to, because it mints the
         * secret — so this screen's old id is left behind on that server as a pending row, with a
         * pairing code that still looks live in the dashboard. An admin seeing it would type that
         * code and get a second screen nothing will ever drive. Saying which id was replaced lets
         * the server drop it; the server is the one that decides whether to, and only for a row
         * that was never adopted.
         */
        const previousDeviceId = deviceId && cfg.deviceId && cfg.deviceId !== deviceId ? cfg.deviceId : '';

        writeConfig({
          ...cfg,
          server,
          ...(deviceId ? { deviceId, deviceSecret } : {}),
          token: token || undefined,
        });
        return sendJson(res, 200, { ok: true, server, adopted: !!token, ...(previousDeviceId ? { previousDeviceId } : {}) });
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
