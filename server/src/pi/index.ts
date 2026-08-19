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
 *     connection is not a design we could have chosen even if we wanted it.
 *   - **Every failure draws something.** A black television is indistinguishable from a dead Pi,
 *     a dead television, and an unplugged HDMI cable. A television that says the server is
 *     unreachable has already told whoever is looking at it what to go and check.
 *   - **The clock is the server's.** Prayer times computed against a Pi's own clock would be
 *     wrong on every boot without a network, because a Pi has no battery-backed clock at all.
 *
 * Slice 2 gets a device from "curl one line" to a pairing code on the television and a screen in
 * the panel. Drawing the timetable itself, and opening the camera, come next.
 */
import { Resvg } from '@resvg/resvg-js';
import {
  Framebuffer,
  quietConsole,
  type FbGeometry,
} from './framebuffer';
import { pairingSvg, messageSvg } from './pairing';
import { fitMode, blitCentered } from './raster';
import { deviceFacts, type DeviceFacts } from './device';
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

/** Redraw the waiting screen at least this often, so the status line and the connection dot do
 *  not go stale while nothing else is happening. */
const REDRAW_MS = 5_000;

const log = (...args: unknown[]): void => {
  // journalctl timestamps every line already, so this stays bare. No call site anywhere in
  // this file passes the token or the device secret to it, and none should: the journal on a
  // masjid Pi is readable by anyone who can reach the box.
  console.log('[openmasjid-screen]', ...args);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

  /** Rasterise and draw. Returns false on a dropped frame — never throws, because the caller's
   *  next move is always "try again in a second" regardless. */
  show(svg: string, srcW = 1920, srcH = 1080): boolean {
    try {
      const fit = fitMode(srcW, srcH, this.geo.width, this.geo.height);
      const img = new Resvg(svg, {
        fitTo: fit,
        // The Pi has fontconfig and the DejaVu faces the installer pulls in; the timetable's
        // bundled fonts arrive with slice 3.
        font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' },
      }).render();
      const frame = blitCentered(img.pixels, img.width, img.height, this.geo.width, this.geo.height);
      return this.fb.draw(frame);
    } catch (e) {
      log('could not draw a frame:', (e as Error).message);
      return false;
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
  const res = await fetch(url, {
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!res.ok) return { httpStatus: res.status };
  return (await res.json()) as T;
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

// ── the two states a device can be in ─────────────────────────────────────────

/**
 * Not yet adopted: show a code, and keep asking whether somebody has typed it.
 *
 * Enrolment is re-sent on every pass rather than once, for two reasons. It is how the device
 * finds out it has been adopted — the token comes back in the reply — and it is how the panel's
 * list stays current, since the facts sent along with it are what that list shows.
 *
 * Returns the token once there is one.
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

/**
 * Adopted: hold the state up to date, and draw whatever it says to draw.
 *
 * Returns when the token stops working, which means an admin pressed Forget. The correct
 * response to that is to go back to showing a pairing code, not to error out — the device is
 * being handed to somebody, or moved to another hall.
 */
async function runAdopted(screen: Screen | null, cfg: AgentConfig): Promise<'forgotten'> {
  let pollMs = POLL_MS;
  let lastDrawn = 0;

  for (;;) {
    const state = await getJson<{ screenName?: string; content?: { kind?: string }; pollMs?: number }>(
      `${cfg.server}/pi/${cfg.token}/state`,
    ).catch((e: Error) => {
      log('state fetch failed:', e.message);
      return { httpStatus: 0 };
    });

    if (failed(state)) {
      if (state.httpStatus === 404) {
        // The server does not know this token. It was forgotten, or the masjid's data was
        // restored from a backup that predates this device. Either way: start over.
        log('this device has been forgotten by the server; returning to pairing');
        return 'forgotten';
      }
      screen?.show(
        messageSvg('Waiting for the display server', `Cannot reach ${cfg.server}. This screen will recover on its own.`),
      );
      await sleep(Math.min(pollMs * 3, 15_000));
      continue;
    }

    pollMs = typeof state.pollMs === 'number' && state.pollMs >= 1000 ? state.pollMs : POLL_MS;

    // Slice 3 renders the timetable here, and slice 4 hands a camera's address to ffmpeg. Until
    // then the device is provably working end to end, and says so — which is the point of
    // stopping the slice here rather than half-building the renderer.
    if (Date.now() - lastDrawn >= REDRAW_MS) {
      const kind = state.content?.kind ?? 'off';
      screen?.show(
        messageSvg(
          state.screenName || 'Screen',
          kind === 'off' ? 'Set up and connected. Nothing is scheduled on this screen.' : `Set up and connected. Showing: ${kind}.`,
        ),
      );
      lastDrawn = Date.now();
    }
    await sleep(pollMs);
  }
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

  for (;;) {
    if (!live.token) {
      const token = await waitForAdoption(screen, live, facts);
      live = { ...live, token };
      saveConfig(live);
    }
    const why = await runAdopted(screen, live);
    if (why === 'forgotten') {
      live = { server: live.server, deviceId: live.deviceId, deviceSecret: live.deviceSecret };
      saveConfig(live);
    }
  }
}

main().catch((e: Error) => {
  // Last resort. systemd restarts us; the journal gets the reason.
  log('fatal:', e.message);
  process.exit(1);
});
