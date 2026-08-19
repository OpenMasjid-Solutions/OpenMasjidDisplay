// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * pi/index.ts — the agent that runs on the Raspberry Pi.
 *
 * This is a single long-lived process on a Pi 3 B+ running Raspberry Pi OS Lite, and it is the
 * whole client: there is no browser, no desktop and no window manager on that machine. It draws
 * straight to `/dev/fb0`, which is why it fits in a fraction of the memory a Chromium kiosk
 * needs on a board with 1 GB of RAM.
 *
 * The shape of the thing is deliberately dull, because the failure that matters is not a crash —
 * systemd restarts a crash in five seconds — but a screen in a hall showing the wrong thing, or
 * nothing, with nobody watching. So:
 *
 *   - **The Pi always polls outward.** Nothing ever connects *to* it. It is behind the masjid's
 *     NAT on a DHCP address, and the display server may be in the cloud, so an inbound
 *     connection is not a design we could have chosen even if we wanted to.
 *   - **Every failure draws something.** A black television is indistinguishable from a dead Pi,
 *     a dead television, and an unplugged HDMI cable. A television that says the server is
 *     unreachable has already told whoever is looking at it what to go and check.
 *   - **The clock is the server's.** A Pi has no battery-backed clock at all, so its own idea of
 *     the time after a power cut is whenever the card was last written. Prayer times computed
 *     against that would be confidently, silently wrong.
 *
 * Two loops run independently: one asks the server what to show, the other draws. They are
 * separate because they have nothing to do with each other — the state changes when somebody
 * touches the dashboard, and the picture changes every second because a clock is on it.
 */
import { Resvg } from '@resvg/resvg-js';
import { Framebuffer, quietConsole, describeFramebuffer, FB_DEVICE, type FbGeometry } from './framebuffer';
import { VideoPlayer } from './video';
import { pairingSvg, messageSvg } from './pairing';
import { fitMode, blitCentered } from './raster';
import { deviceFacts, type DeviceFacts } from './device';
import { AssetCache } from './assetCache';
import { RenderCadence, cadenceAdvice } from './cadence';
import { renderDisplaySvg, activeAnnouncementImage } from '../render/svg';
import type { Timetable } from '../types';
import {
  loadConfig,
  saveConfig,
  makeDeviceId,
  makeDeviceSecret,
  CONFIG_PATH,
  type AgentConfig,
} from './agentConfig';

/** Stamped in by the build so a panel listing a dozen screens can say which are behind. */
declare const __AGENT_VERSION__: string;
const AGENT_VERSION = typeof __AGENT_VERSION__ === 'string' ? __AGENT_VERSION__ : 'dev';

/** How long to give the server before deciding it is not going to answer. Generous: a masjid's
 *  uplink is not always good, and a slow answer is still an answer. */
const HTTP_TIMEOUT_MS = 15_000;

/** Fallback poll interval. The server sends its own `pollMs` and we prefer that. */
const POLL_MS = 5_000;

/** Long enough without a successful poll that what is on the screen should not be trusted. The
 *  times themselves stay right — they are computed here — but a change nobody has heard about
 *  might be sitting unapplied. */
const STALE_AFTER_MS = 90_000;

/** How often to tell the server what this device is running. Not often — nothing here changes
 *  minute to minute, and the point is only that the panel stops showing what was true on the
 *  day the screen was set up. */
const CHECKIN_MS = 5 * 60_000;

const log = (...args: unknown[]): void => {
  // journalctl timestamps every line already, so this stays bare. No call site anywhere in this
  // file passes the token or the device secret to it, and none should: the journal on a masjid
  // Pi is readable by anyone who can reach the box.
  console.log('[openmasjid-screen]', ...args);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── what the server tells us ─────────────────────────────────────────────────

interface PiStateWire {
  content: { kind: 'timetable' | 'source' | 'off'; id?: string };
  timetable: Timetable | null;
  assets: { background: string | null; logo: string | null; announcements: string[] };
  fonts: string[];
  bgLight: boolean;
  autoAccent: string | null;
  stream: { url: string; mode: 'direct' | 'normalize' } | null;
  serverNow: number;
  clockSuspect: boolean;
  pollMs: number;
  screenName: string;
}

// ── drawing ───────────────────────────────────────────────────────────────────

/**
 * The television, as far as the rest of this file is concerned: hand it an SVG, it appears.
 *
 * Holding the framebuffer open and the geometry alongside it keeps the fitting decision in one
 * place. The geometry is read once at startup rather than per frame — it only changes when
 * somebody swaps the television, and that comes with a reboot.
 */
class Screen {
  private constructor(
    private readonly fb: Framebuffer,
    readonly geo: FbGeometry,
  ) {}

  static open(): Screen | null {
    const fb = Framebuffer.open();
    return fb ? new Screen(fb, fb.geo) : null;
  }

  /**
   * Rasterise and draw, returning how long the rasterising took.
   *
   * That number is the input to the whole cadence decision, so it is measured around the resvg
   * call alone — not the framebuffer write, which is a memcpy, and not the SVG building, which
   * is string concatenation. Returns null on a dropped frame; never throws, because the caller's
   * next move is always "try again shortly" regardless.
   */
  show(svg: string, fontFiles: string[] = []): number | null {
    try {
      // The renderer stamps its own size, which follows the timetable's orientation and quality
      // — 1920×1080, 1080×1920 rotated, or 1280×720. Reading it rather than assuming is what
      // lets a portrait screen work at all.
      const m = /<svg[^>]*\swidth="(\d+)"[^>]*\sheight="(\d+)"/.exec(svg);
      const srcW = m ? Number(m[1]) : 1920;
      const srcH = m ? Number(m[2]) : 1080;

      const t0 = process.hrtime.bigint();
      const img = new Resvg(svg, {
        fitTo: fitMode(srcW, srcH, this.geo.width, this.geo.height),
        font: fontFiles.length
          ? {
              // The server's own curated faces, fetched from it. NOT the system fonts: resvg
              // picks one font per run rather than falling back glyph by glyph, so a Pi drawing
              // with whatever the distro ships renders Arabic as tofu boxes.
              fontFiles,
              loadSystemFonts: false,
              defaultFontFamily: 'Noto Sans',
            }
          : { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' },
      }).render();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;

      const frame = blitCentered(img.pixels, img.width, img.height, this.geo.width, this.geo.height);
      return this.fb.draw(frame) ? ms : null;
    } catch (e) {
      log('could not draw a frame:', (e as Error).message);
      return null;
    }
  }
}

// ── talking to the display server ─────────────────────────────────────────────

async function postJson<T>(url: string, body: unknown): Promise<T | { httpStatus: number }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    // The server never redirects these, so a redirect means something is in the way — a captive
    // portal, or a proxy that has decided to be helpful. Following it would post this device's
    // secret somewhere it does not belong.
    redirect: 'error',
  });
  if (!res.ok) return { httpStatus: res.status };
  return (await res.json()) as T;
}

async function getJson<T>(url: string): Promise<T | { httpStatus: number }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: 'error' });
  if (!res.ok) return { httpStatus: res.status };
  return (await res.json()) as T;
}

/**
 * Turn a path the server handed us into a URL this agent can fetch.
 *
 * The state's asset and font entries are ROOT-RELATIVE ('/pi/<token>/asset/bg.jpg'), because
 * that is what a browser screen wants — a browser resolves them against the page it is on. The
 * agent has no page, so it resolves them against the server it is configured to talk to, which
 * is the same thing that address means everywhere else here.
 *
 * Only a root-relative path is accepted. Anything absolute is refused rather than followed:
 * this device holds a credential, and a state that could name an arbitrary host would be a way
 * to make it go and talk to one.
 */
function absolute(pathOrUrl: string, server: string): string | null {
  if (!pathOrUrl.startsWith('/') || pathOrUrl.startsWith('//')) return null;
  return `${server}${pathOrUrl}`;
}

const failed = (v: unknown): v is { httpStatus: number } =>
  !!v && typeof v === 'object' && 'httpStatus' in (v as object);

interface EnrolReply {
  code: string;
  deviceId: string;
  adopted: boolean;
  token?: string;
  pollMs?: number;
}

// ── waiting to be adopted ─────────────────────────────────────────────────────

/**
 * Not yet adopted: show a code, and keep asking whether somebody has typed it.
 *
 * Enrolment is re-sent on every pass rather than once, for two reasons. It is how the device
 * finds out it has been adopted — the token comes back in the reply — and it is how the panel's
 * list stays current, since the facts sent along with it are what that list shows.
 */
async function waitForAdoption(screen: Screen | null, cfg: AgentConfig, facts: DeviceFacts): Promise<string> {
  let code = '';
  let connected = false;
  let status = 'Contacting the display server…';

  for (;;) {
    const reply = await postJson<EnrolReply>(`${cfg.server}/pi/enrol`, {
      deviceId: cfg.deviceId,
      deviceSecret: cfg.deviceSecret,
      hostname: facts.hostname,
      ip: facts.ip,
      model: facts.model,
      agentVersion: AGENT_VERSION,
    }).catch((e: Error) => {
      // A name that will not resolve, a refused connection, a timeout: all the same to the
      // person looking at the screen, and all fixed by looking at the network.
      log('enrol failed:', e.message);
      return { httpStatus: 0 };
    });

    if (failed(reply)) {
      connected = false;
      status =
        reply.httpStatus === 429
          ? 'The display server is busy. Retrying…'
          : `Cannot reach the display server at ${cfg.server}`;
    } else {
      connected = true;
      code = reply.code || code;
      status = 'Waiting for this code to be entered in the dashboard';
      if (reply.token) {
        log('adopted; saving credentials');
        return reply.token;
      }
    }

    screen?.show(
      pairingSvg({
        code,
        ip: facts.ip,
        hostname: facts.hostname,
        server: cfg.server,
        status,
        connected,
        agentVersion: AGENT_VERSION,
      }),
    );
    await sleep(connected ? POLL_MS : Math.min(POLL_MS * 3, 15_000));
  }
}

// ── adopted: the two loops ───────────────────────────────────────────────────

/**
 * Everything the drawing loop needs, kept up to date by the polling loop.
 *
 * A plain mutable object rather than anything cleverer, because the two loops are the only
 * readers and writers and neither ever yields in the middle of touching it.
 */
class Live {
  constructor(readonly server: string) {}

  state: PiStateWire | null = null;
  /** serverNow − our clock, at the last successful poll. */
  clockOffsetMs = 0;
  lastPollOk = 0;
  /** resolved `data:` URIs, keyed by the URL the server gave us */
  images = new Map<string, string>();
  fontFiles: string[] = [];
  forgotten = false;

  serverTime(): Date {
    return new Date(Date.now() + this.clockOffsetMs);
  }

  /** True when we have not heard from the server for long enough that the screen may be showing
   *  a decision that has since been changed. */
  stale(): boolean {
    return this.lastPollOk > 0 && Date.now() - this.lastPollOk > STALE_AFTER_MS;
  }
}

/**
 * Fetch anything the current state refers to that we do not already have.
 *
 * Deliberately not blocking the drawing loop: a screen that shows the themed background for the
 * first few seconds while a four-megabyte photograph arrives is behaving correctly, and a screen
 * that shows nothing until it does is not.
 */
async function resolveAssets(live: Live, cache: AssetCache, server: string): Promise<void> {
  const st = live.state;
  if (!st) return;

  const urls = [st.assets.background, st.assets.logo, ...st.assets.announcements]
    .filter((u): u is string => !!u)
    .map((u) => absolute(u, server))
    .filter((u): u is string => !!u);
  for (const url of urls) {
    if (live.images.has(url)) continue;
    const uri = await cache.dataUri(url);
    if (uri) live.images.set(url, uri);
  }
  // Drop what this timetable no longer refers to, in memory and on the card.
  for (const url of [...live.images.keys()]) if (!urls.includes(url)) live.images.delete(url);
  cache.prune([...urls, ...st.fonts.map((u) => absolute(u, server) ?? u)]);

  const fontUrls = st.fonts.map((u) => absolute(u, server)).filter((u): u is string => !!u);
  if (fontUrls.length && live.fontFiles.length !== fontUrls.length) {
    const files: string[] = [];
    for (const url of fontUrls) {
      const f = await cache.localFile(url);
      if (f) files.push(f);
    }
    if (files.length) {
      live.fontFiles = files;
      log(`fonts ready: ${files.length} face(s) from the display server`);
    }
  }
}

/** A resolved `data:` URI for one of the state's asset paths, or null while it is still being
 *  fetched — in which case the renderer draws the themed scene instead, which is correct: a
 *  screen that shows the theme for a few seconds while a photograph arrives is behaving, and one
 *  that shows nothing until it does is not. */
function imageFor(live: Live, pathOrNull: string | null): string | null {
  if (!pathOrNull) return null;
  const url = absolute(pathOrNull, live.server);
  return (url && live.images.get(url)) || null;
}

/** One frame. Returns how long rasterising took, for the cadence.
 *  Null when nothing was drawn — a dropped frame is not a measurement. */
function drawFrame(screen: Screen | null, live: Live): number | null {
  const st = live.state;
  if (!screen || !st) return null;

  const tt = st.timetable;
  if (!tt) {
    // Deliberately not a black rectangle. A screen that has simply been switched off should look
    // switched off ON PURPOSE, and one that is misconfigured should say so — a masjid staring at
    // a black television has no way to tell those apart.
    return screen.show(
      messageSvg(
        st.content.kind === 'off' ? 'Screen is off' : 'Nothing to show yet',
        st.screenName || '',
      ),
    );
  }

  const now = live.serverTime();
  // The slideshow phase is epoch-locked inside the shared renderer, so a Pi, a browser screen and
  // a decoder screen showing the same timetable change picture together.
  const annFile = activeAnnouncementImage(tt, now);
  const annUrl = annFile
    ? (st.assets.announcements.find((u) => u.endsWith(encodeURIComponent(annFile))) ?? null)
    : null;

  const svg = renderDisplaySvg(tt, now, {
    bg: imageFor(live, st.assets.background),
    logo: imageFor(live, st.assets.logo),
    announcement: imageFor(live, annUrl),
    bgLight: st.bgLight,
    ...(st.autoAccent ? { autoAccent: st.autoAccent } : {}),
    // NOT tickerBandOnly. That mode exists for pipelines where something else composites the
    // moving text over the band — ffmpeg for the video path, CSS for a browser screen. Here
    // there is no compositor, so the renderer draws the ticker itself, exactly as the admin's
    // still preview does.
  });

  return screen.show(svg, live.fontFiles);
}

/**
 * Adopted: hold the state up to date, and draw whatever it says to draw.
 *
 * Returns when the token stops working, which means an admin pressed Forget. The correct
 * response to that is to go back to showing a pairing code, not to error out — the device is
 * being handed to somebody, or moved to another hall.
 */
async function runAdopted(
  screen: Screen | null,
  cfg: AgentConfig,
  cache: AssetCache,
  facts: DeviceFacts,
): Promise<'forgotten'> {
  const live = new Live(cfg.server);
  const cadence = new RenderCadence();
  const player = new VideoPlayer(FB_DEVICE, log);
  let advised = '';

  // ── the polling loop ──
  const poll = async (): Promise<void> => {
    let pollMs = POLL_MS;
    while (!live.forgotten) {
      const st = await getJson<PiStateWire>(`${cfg.server}/pi/${cfg.token}/state`).catch((e: Error) => {
        log('state fetch failed:', e.message);
        return { httpStatus: 0 };
      });

      if (failed(st)) {
        if (st.httpStatus === 404) {
          // The server does not know this token. It was forgotten, or the masjid's data was
          // restored from a backup that predates this device. Either way: start over.
          log('this device has been forgotten by the server; returning to pairing');
          live.forgotten = true;
          return;
        }
        await sleep(Math.min(pollMs * 3, 15_000));
        continue;
      }

      const first = !live.state;
      live.state = st;
      live.clockOffsetMs = st.serverNow - Date.now();
      live.lastPollOk = Date.now();
      pollMs = typeof st.pollMs === 'number' && st.pollMs >= 1000 ? st.pollMs : POLL_MS;
      if (first) {
        log(`showing "${st.screenName}" — ${st.content.kind}${st.timetable ? ` (${st.timetable.name})` : ''}`);
        if (Math.abs(live.clockOffsetMs) > 60_000) {
          log(`this Pi's clock is ${Math.round(live.clockOffsetMs / 1000)}s out; using the server's time`);
        }
      }

      await resolveAssets(live, cache, cfg.server).catch(() => {
        /* a missing image draws the themed scene instead; the next poll tries again */
      });
      await sleep(pollMs);
    }
  };

  // ── the check-in ──
  //
  // Separate from polling because it answers a different question. Polling asks what to show;
  // this says what we are, so an admin looking at a list of a dozen screens can see which have
  // picked up an update and which have not.
  const checkin = async (): Promise<void> => {
    while (!live.forgotten) {
      await postJson(`${cfg.server}/pi/${cfg.token}/seen`, {
        hostname: facts.hostname,
        ip: facts.ip,
        model: facts.model,
        agentVersion: AGENT_VERSION,
      }).catch(() => ({ httpStatus: 0 }));
      await sleep(CHECKIN_MS);
    }
  };

  // ── the drawing loop ──
  const draw = async (): Promise<void> => {
    while (!live.forgotten) {
      if (!live.state) {
        screen?.show(messageSvg('Connecting…', `Waiting for ${cfg.server}`));
        await sleep(2000);
        continue;
      }
      if (live.stale() && !player.status().playing) {
        // Times on screen stay correct — they are computed here — but a change made in the
        // dashboard may not have reached us, and saying so beats looking healthy.
        screen?.show(
          messageSvg('Lost contact with the display server', 'This screen will recover on its own when it comes back.'),
        );
        await sleep(5000);
        continue;
      }

      // A camera and the timetable are the same pixels, so exactly one of them may be running.
      // ffmpeg draws straight to the framebuffer; anything we painted would be a flicker over it.
      const stream = live.state.stream;
      if (stream && screen) {
        player.play(stream.url, screen.geo);
        const st = player.status();
        if (st.playing) {
          await sleep(2000);
          continue;
        }
        // Between attempts. Saying which camera and what went wrong turns "the screen is black"
        // into something whoever is standing there can act on.
        screen.show(
          messageSvg(
            'Camera unavailable',
            st.lastError ? st.lastError.slice(0, 120) : `Trying to reach the camera for "${live.state.screenName}"`,
          ),
        );
        await sleep(3000);
        continue;
      }
      player.stop();

      const ms = drawFrame(screen, live);
      if (ms !== null) cadence.record(ms);

      const interval = cadence.intervalMs();
      if (cadence.settled()) {
        const advice = cadenceAdvice(interval, live.state.timetable?.quality ?? '1080p');
        if (advice && advice !== advised) {
          log(advice);
          advised = advice;
        } else if (!advice && advised) {
          advised = '';
        }
      }
      // Subtract what drawing already cost, so the *interval* is honoured rather than the gap
      // between frames — otherwise a 400ms frame at a 1s interval ticks every 1.4s and the clock
      // visibly drifts behind the second it is showing.
      await sleep(Math.max(50, interval - (ms ?? 0)));
    }
  };

  void checkin();
  await Promise.race([poll(), draw()]);
  live.forgotten = true;
  player.stop();
  return 'forgotten';
}

// ── startup ───────────────────────────────────────────────────────────────────

/**
 * Wait for a usable config rather than exiting without one.
 *
 * systemd would restart us either way, but a restart loop logs an error every five seconds and
 * leaves the television black. Sitting here with a message on the screen tells whoever installed
 * this exactly which file to look at.
 */
async function waitForConfig(screen: Screen | null): Promise<AgentConfig> {
  for (let attempt = 0; ; attempt++) {
    const cfg = loadConfig();
    if (cfg?.server) return cfg;
    if (attempt === 0) log(`no usable config at ${CONFIG_PATH}; waiting`);
    screen?.show(
      messageSvg('Not set up yet', 'This screen has no display server configured. Re-run the installer on this device.'),
    );
    await sleep(10_000);
  }
}

async function main(): Promise<void> {
  log(`starting, agent ${AGENT_VERSION}`);
  quietConsole();

  const screen = Screen.open();
  if (!screen) {
    // Worth running anyway: the device still enrols and still appears in the panel, and the
    // journal now says why nothing is on the television.
    log('no framebuffer at /dev/fb0 — nothing will be drawn. Is a display attached, and is this user in the `video` group?');
  } else {
    log(`framebuffer ${screen.geo.width}x${screen.geo.height} @ ${screen.geo.bpp}bpp, stride ${screen.geo.stride}`);
    // The raw values too: a picture in the wrong place is decided by these, and they cannot be
    // reproduced anywhere but on the television it is plugged into.
    log(`kernel says: ${describeFramebuffer()}`);
    // Draw something IMMEDIATELY — before the config is read and long before the network is
    // touched. The text console is taken off this screen shortly after we start, and until we
    // have painted, whatever the boot happened to be printing at that instant stays on the
    // television. Frozen boot messages read as a machine stuck in a loop, which is exactly how
    // this got reported the first time. One frame here closes that window for good.
    screen.show(messageSvg('OpenMasjidDisplay', 'Starting…'));
  }

  const cfg = await waitForConfig(screen);
  const facts = deviceFacts();
  log(`device ${facts.hostname} at ${facts.ip || 'no address'}${facts.model ? ` (${facts.model})` : ''}`);

  // Mint an identity on first run if the installer did not. Doing it here as well means a config
  // hand-written by somebody who only knew the server address still works.
  let live: AgentConfig = { ...cfg };
  if (!live.deviceId || !live.deviceSecret) {
    live = { ...live, deviceId: live.deviceId || makeDeviceId(), deviceSecret: live.deviceSecret || makeDeviceSecret() };
    saveConfig(live);
    log(`minted a device identity: ${live.deviceId}`);
  }

  const cache = new AssetCache();

  for (;;) {
    if (!live.token) {
      const token = await waitForAdoption(screen, live, facts);
      live = { ...live, token };
      saveConfig(live);
    }
    await runAdopted(screen, live, cache, facts);
    // Forgotten. Drop the token and go back to showing a code; keep the identity, so the panel
    // recognises the same device rather than growing a second row for it.
    live = { server: live.server, deviceId: live.deviceId, deviceSecret: live.deviceSecret };
    saveConfig(live);
  }
}

main().catch((e: Error) => {
  // Last resort. systemd restarts us; the journal gets the reason.
  log('fatal:', e.message);
  process.exit(1);
});
