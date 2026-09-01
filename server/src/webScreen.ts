// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * webScreen.ts — a screen that is a BROWSER instead of an RTSP decoder (beta).
 *
 * ## Why this exists
 *
 * An RTSP screen costs a continuous H.264 stream: resvg rasterises a full frame every second
 * and ffmpeg encodes it forever, roughly 1.5 Mbit/s per screen whether anything changed or
 * not. That is the price of driving a decoder box that can only speak video.
 *
 * A browser can render for itself. `render/svg.ts` is a pure string builder — no fs, no
 * Buffer, no clock of its own — so the SAME function that feeds the video pipeline bundles
 * into the page and runs client-side. The wire then carries the timetable (about 0.5 KB
 * gzipped) instead of video, and the browser redraws locally once a second. There is no
 * second renderer to drift: an RTSP screen and a web screen are the same SVG.
 *
 * ## Why the page is unauthenticated
 *
 * A TV cannot sign in. The website widget already set this precedent, and this follows it:
 * the URL carries a 128-bit token (`store.screenToken`) that IS the capability, the page is
 * rate-limited, and an unknown token is a 404 rather than a 403 so tokens are not probeable.
 * What it exposes is a wall display — the prayer times a masjid publishes on purpose.
 *
 * ## Served over HTTPS and through the tunnel, for free
 *
 * The page lives on the control-panel port, which is the port the platform already fronts
 * with TLS (`https: true`) and already routes through the admin's Cloudflare tunnel
 * (`domain: true`). So a remote TV, or a cloud-hosted install, needs nothing new — the route
 * simply has to accept the tunnel's `/<basePath>/…` form as well as the LAN one, and the page
 * has to fetch relative to itself.
 */
import type { Timetable, Tv, DB } from './types';
import { resolveTv } from './scheduler';
import { config } from './config';

/** How long a browser screen may go unheard-from before it is reported offline.
 *
 *  The RTSP equivalent is "MediaMTX says nobody is reading the path". A browser has no such
 *  signal, so every state poll doubles as a check-in and this is the grace: six missed polls,
 *  which survives a Wi-Fi blip without pretending a dark screen is fine. */
export const WEB_SEEN_TIMEOUT_MS = 30_000;

/**
 * How often the page re-fetches its state.
 *
 * This is what a switch in the panel costs before the wall follows it. At 30 s it read as a
 * frozen screen — someone changes a screen to the camera, watches the old picture sit there,
 * and reloads the page. Five seconds is the difference between "it works" and "it is broken",
 * and it costs about 1.8 kbit/s against RTSP's 1500 — still three orders of magnitude less.
 * The clock, the countdown and every per-second behaviour are local and never wait for this.
 */
export const WEB_POLL_MS = 5_000;

/** In-memory record of which browser screens have checked in, and when.
 *
 *  Not persisted on purpose: "is a screen alive right now" is worthless across a restart, and
 *  writing to the store on every heartbeat would spin the debounced save and the reconcile
 *  listener for a fact that expires in 95 seconds. */
const seen = new Map<string, number>();

export function markWebScreenSeen(tvId: string, nowMs: number): void {
  seen.set(tvId, nowMs);
  // Bounded by the number of screens, but a stale id (a deleted screen) would otherwise
  // linger for the life of the process.
  if (seen.size > 200) for (const [k, t] of seen) if (nowMs - t > WEB_SEEN_TIMEOUT_MS) seen.delete(k);
}

/** Has this browser screen checked in recently? The `streamReady` equivalent for a web screen,
 *  so the panel badge and the offline alert need no special case. */
export function webScreenOnline(tvId: string, nowMs: number): boolean {
  const at = seen.get(tvId);
  return at != null && nowMs - at <= WEB_SEEN_TIMEOUT_MS;
}

/** Test seam. */
export function __resetWebScreensForTests(): void {
  seen.clear();
}

export function findByToken(db: DB, token: string): Tv | null {
  if (!token) return null;
  return db.tvs.find((t) => t.kind === 'web' && t.webToken === token) ?? null;
}

/**
 * What a browser screen needs to draw itself.
 *
 * Deliberately small and deliberately NOT a rendered frame: the timetable, the assets it
 * refers to, and the server's clock. Everything time-dependent is derived in the browser from
 * the same code the server would have used.
 */
export interface WebScreenState {
  /** what this screen is currently showing, after overrides and schedules */
  content: { kind: 'timetable' | 'source' | 'off'; id?: string };
  /** why — so the page can be honest about a manual override that never got cleared */
  source: 'override' | 'schedule' | 'default';
  /** the whole timetable, when the screen is showing one. The page renders from this. */
  timetable: Timetable | null;
  /** absolute URLs for the images the SVG references; the browser fetches them itself
   *  rather than receiving multi-megabyte data URIs on every poll */
  assets: { background: string | null; logo: string | null; announcements: string[] };
  /** precomputed on the server because they need the decoded image (auto text contrast and
   *  the accent pulled off a wallpaper); recomputing them in the browser would be a second
   *  implementation of something that has to match exactly */
  bgLight: boolean;
  autoAccent: string | null;
  /** the SERVER's clock. The page compares it with its own and marks the picture if they
   *  disagree badly — a TV with a wrong clock would otherwise render confident, wrong times. */
  serverNow: number;
  /** the server believes its own clock is wrong (see renderer.clockSuspect) */
  clockSuspect: boolean;
  /** how long the page should wait before asking again */
  pollMs: number;
  name: string;
}

/** Where the browser fetches an uploaded image from. Public like the page itself, and scoped
 *  to the token so an asset URL is no more guessable than the screen it belongs to. */
const asset = (base: string, token: string, file: string) =>
  `${base}/s/${encodeURIComponent(token)}/asset/${encodeURIComponent(file)}`;

export function webScreenState(
  db: DB,
  tv: Tv,
  nowMs: number,
  opts: { basePrefix: string; clockSuspect: boolean; bgLight: boolean; autoAccent: string | null },
): WebScreenState {
  // The SAME resolution the video pipeline uses, so a schedule rule or a volunteer's override
  // moves a browser screen and a decoder screen identically.
  const res = resolveTv(tv, db.schedules, new Date(nowMs), db.settings.scheduleTimezone);
  const tt = res.content.kind === 'timetable' ? db.timetables.find((t) => t.id === res.content.id) ?? null : null;
  const token = tv.webToken ?? '';
  return {
    content: res.content,
    source: res.source,
    timetable: tt,
    assets: {
      background: tt?.backgroundImage ? asset(opts.basePrefix, token, tt.backgroundImage) : null,
      logo: tt?.logoImage ? asset(opts.basePrefix, token, tt.logoImage) : null,
      announcements: (tt?.announcements?.images ?? []).map((f) => asset(opts.basePrefix, token, f)),
    },
    bgLight: opts.bgLight,
    autoAccent: opts.autoAccent,
    serverNow: nowMs,
    clockSuspect: opts.clockSuspect,
    pollMs: WEB_POLL_MS,
    name: tv.name,
  };
}

/**
 * Proxy MediaMTX's HLS output for a camera or HDMI source onto a browser screen.
 *
 * A browser cannot play RTSP — that is why a web screen showing a camera used to be black.
 * MediaMTX can serve the same stream as HLS, so it is enabled on LOOPBACK ONLY and reverse-
 * proxied through here. Three consequences, all deliberate:
 *
 *  - **No new published port.** It rides the control-panel port, which the platform already
 *    fronts with TLS and already routes through the admin's tunnel — so a remote screen plays
 *    a camera over HTTPS with nothing extra configured.
 *  - **A camera is only reachable through a screen's own token.** MediaMTX's HLS listener is
 *    not exposed, so this route is the only way in, and it is behind the same capability the
 *    rest of the page is.
 *  - **Only paths this app owns.** The requested path is checked against the screen's CURRENT
 *    content, so a token cannot be used to enumerate or watch a stream that screen is not
 *    showing.
 */
export function hlsTargetFor(db: DB, tv: Tv, nowMs: number, rest: string, search = ''): string | null {
  const res = resolveTv(tv, db.schedules, new Date(nowMs), db.settings.scheduleTimezone);
  if (res.content.kind !== 'source' || !res.content.id) return null;
  const src = db.sources.find((x) => x.id === res.content.id);
  if (!src || !src.enabled) return null;
  // `rest` is whatever follows /hls/ — index.m3u8, a segment, an init file. It must belong to
  // THIS screen's stream and must not climb out of it.
  // An exact allowlist, and nothing is normalised first. Stripping a leading slash (or any
  // other tidying) means the string that is CHECKED is not the string that was SENT, which is
  // how traversal guards get walked past. HLS filenames are plain — index.m3u8, init.mp4,
  // segment7.mp4 — so anything else is simply not ours.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(rest) || rest.includes('..')) return null;
  // MediaMTX tracks a viewer with ?session=<uuid> on the sub-playlist and every segment, so
  // the query has to survive the hop. Validated separately and conservatively — it is appended
  // only after the FILENAME has passed, so it can never be used to reshape the path.
  const q = /^\?[A-Za-z0-9=&_.\-]{0,200}$/.test(search) ? search : '';
  return `${config.mediamtxHlsUrl}/${encodeURIComponent(src.id)}/${rest}${q}`;
}
