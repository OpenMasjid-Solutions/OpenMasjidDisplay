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
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { Resvg } from '@resvg/resvg-js';
import {
  Framebuffer,
  quietConsole,
  describeFramebuffer,
  framebufferPng,
  framebufferPngError,
  FB_DEVICE,
  type FbGeometry,
} from './framebuffer';
import { VideoPlayer } from './video';
import { describeFbset } from './fbset';
import { pairingSvg, messageSvg, withConnectionLost } from './pairing';
import { createPiPanel, PANEL_PORT, WEB_DIR } from './panel';
import { createManagedPanel, type ManagedStatus } from './managedPanel';
import { newSetupCode, formatSetupCode } from './claim';
import { Store, rid } from '../store';
import { backgroundDataUri, logoDataUri, announcementDataUri } from '../render/background';
import { clockSuspect } from '../clockFloor';
import { fontOptions } from '../render/fonts';
import { fitMode, blitCentered } from './raster';
import { deviceFacts, type DeviceFacts } from './device';
import { netFacts, scanNetworks, type NetFacts, type AccessPoint } from './network';
import { makeControl, readWifiResult, isWifiAction, rootHasTrustedServer } from './control';

// Bound once to this module's logger, so no call site has to pass one. The panel on a
// standalone screen builds its own with its own logger and writes the same files.
const { requestPrivileged, requestWifi } = makeControl((...a) => log(...(a as [string, ...unknown[]])));
import { piStats } from './stats';
import { AssetCache } from './assetCache';
import { RenderCadence, cadenceAdvice } from './cadence';
import { renderDisplaySvg, activeAnnouncementImage, frostedBackgroundSvg, dimsFor } from '../render/svg';
import type { Timetable } from '../types';
import {
  loadConfig,
  saveConfig,
  makeDeviceId,
  makeDeviceSecret,
  isUsableConfig,
  CONFIG_PATH,
  SERVER_ORIGIN_RE,
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

/**
 * How long a camera may be between frames before the screen says so.
 *
 * Long enough to cover a reconnect, short enough that a camera which has actually gone away does
 * not leave a stale picture up pretending to be live. Six seconds covers the measured case — a
 * clean end of stream, a sub-second retry, and a TLS handshake — with room to spare.
 */
const CAMERA_GRACE_MS = 6_000;

/**
 * The last lines this agent logged, kept in memory and reported to the server.
 *
 * Deliberately OUR OWN lines rather than journalctl. Reading the journal would need a privilege the
 * agent does not have and should not be given, and these are the lines that actually say what the
 * screen is doing — which camera it opened, why one failed, what the framebuffer turned out to be.
 * Small and bounded: a masjid screen runs for months and this must never grow.
 */
const RECENT_LOG_MAX = 80;
const recentLog: string[] = [];

const log = (...args: unknown[]): void => {
  // journalctl timestamps every line already, so this stays bare. No call site anywhere in this
  // file passes the token or the device secret to it, and none should: the journal on a masjid
  // Pi is readable by anyone who can reach the box.
  const line = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
  recentLog.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (recentLog.length > RECENT_LOG_MAX) recentLog.shift();
  console.log('[openmasjid-screen]', ...args);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── what the server tells us ─────────────────────────────────────────────────

interface PiStateWire {
  content: { kind: 'timetable' | 'source' | 'off'; id?: string };
  timetable: Timetable | null;
  assets: { background: string | null; logo: string | null; announcements: string[] };
  fonts: string[];
  fontFamilies?: { default: string; serif: string; sansSerif: string };
  bgLight: boolean;
  autoAccent: string | null;
  stream: { url: string; mode: 'direct' | 'normalize' } | null;
  serverNow: number;
  clockSuspect: boolean;
  pollMs: number;
  screenName: string;
  /** Turn the output off overnight, enforced by the agent from its own clock — see
   *  applyDisplaySchedule for why it is not the panel that sends the command at the moment. */
  displaySchedule?: { enabled: boolean; offAt: string; onAt: string };
  /** And reboot nightly, for the same reason and by the same mechanism. */
  rebootSchedule?: { enabled: boolean; at: string };
  /** While this is in the future, keep sending pictures — somebody has a preview window open. */
  previewUntil?: number;
  command?: {
    id: string;
    action:
      | 'restart'
      | 'update'
      | 'reboot'
      | 'reinstall'
      | 'logs'
      | 'wifi-on'
      | 'wifi-off'
      | 'wifi-join'
      | 'wifi-forget'
      | 'wifi-rescan'
      | 'shell'
      | 'shell-session'
      | 'display-off'
      | 'display-on'
      | 'set-timezone'
      | 'screenshot'
      | 'set-video-mode'
      | 'keep-video-mode';
    /** Only ever present for 'wifi-join'. The password is used once and never logged. */
    wifi?: { ssid: string; psk: string };
    /** Only ever present for 'shell'. One line, run as THIS user — see runShell. */
    shell?: string;
    /** Only ever present for 'shell-session'. Where to dial in, and the one-time secret. */
    shellSession?: { id: string; secret: string; rows: number; cols: number };
    /** Only ever present for 'set-timezone' / 'set-video-mode'. Root validates it again. */
    text?: string;
  } | null;
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
  show(
    svg: string,
    fontFiles: string[] = [],
    families?: { default: string; serif: string; sansSerif: string },
  ): number | null {
    try {
      // Before anything else: has the television changed the mode under us? A 4K set renegotiates
      // after boot, the driver reallocates the framebuffer, and frames addressed with the old size
      // land as a magnified corner — right for about ten seconds, then wrong for good.
      const moved = this.fb.refresh();
      if (moved) {
        log(`the screen changed mode: now ${moved.width}x${moved.height} @ ${moved.bpp}bpp, stride ${moved.stride}`);
      }

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
              // The families come from the server too. Hardcoding "Noto Sans" here named a face
              // that is not loaded when the server settled on DejaVu, so resvg substituted
              // something else and text laid out with one set of metrics was drawn with another —
              // which is what pushed it out of the boxes around it.
              defaultFontFamily: families?.default ?? 'DejaVu Sans',
              serifFamily: families?.serif ?? families?.default ?? 'DejaVu Sans',
              sansSerifFamily: families?.sansSerif ?? families?.default ?? 'DejaVu Sans',
            }
          : // No files named — the pairing screen, "Starting…", every message card. This used to
            // ask resvg to load SYSTEM fonts, and on Raspberry Pi OS LITE that finds nothing:
            // fontconfig is not installed on a Lite image, and resvg enumerates system fonts
            // through it. Measured on a Pi 4 with the fonts sitting on disk the whole time:
            //
            //   loadSystemFonts: true        612 bytes   no text at all
            //   explicit DejaVuSans.ttf     4682 bytes   text
            //   fontDirs /usr/share/fonts   4682 bytes   text
            //
            // So the first screen a masjid ever sees — the one carrying the setup code — drew
            // its boxes and its status dot and not one character. `fontOptions()` names the
            // files instead, which is what the adopted path already does once the server has
            // sent them; this makes the screens BEFORE that point work the same way.
            fontOptions(),
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

/**
 * Where the id of the last command we carried out is kept.
 *
 * In the state directory, which is the one place the agent may write. It has to survive a restart,
 * because `restart` and `update` both END THIS PROCESS: without a record, the agent would come
 * back, poll, be offered the same instruction, and act on it again — for ever, every five seconds,
 * with `Restart=always` guaranteeing nothing ever stops it. The server clearing the command on
 * acknowledgement is the first guard; this is the one that holds when the acknowledgement is the
 * thing that got lost.
 */
const LAST_COMMAND_FILE = `${process.env.OMD_SCREEN_CACHE ? `${process.env.OMD_SCREEN_CACHE}/..` : '/var/lib/openmasjid-screen'}/last-command`;

function lastCommandId(): string {
  try {
    return fs.readFileSync(LAST_COMMAND_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

function rememberCommand(id: string): void {
  try {
    fs.mkdirSync(path.dirname(LAST_COMMAND_FILE), { recursive: true });
    fs.writeFileSync(LAST_COMMAND_FILE, `${id}\n`);
  } catch {
    // If this cannot be written we must NOT act: an unrecorded restart is an endless one.
    throw new Error('could not record the command; refusing to act on it');
  }
}

/**
 * Carry out an instruction from the panel.
 *
 * The order is the whole safety property: acknowledge FIRST, record it, and only then act. Both
 * actions end this process, so anything done after acting is not done at all.
 *
 * `restart` needs no privileges whatsoever — exiting is enough, because systemd is configured to
 * bring the agent straight back. `update` does need root, so it is left as a request in a
 * directory a root-side unit is watching; see the installer.
 */
async function runCommand(
  cfg: AgentConfig,
  cmd: NonNullable<PiStateWire['command']>,
  live: Live,
): Promise<void> {
  if (cmd.id === lastCommandId()) return; // already done; the ack simply never landed

  // Tell the server before doing anything, so a command cannot be collected twice.
  const acked = await postJson(`${cfg.server}/pi/${cfg.token}/command-ack`, { id: cmd.id }).catch(() => ({
    httpStatus: 0,
  }));
  if (failed(acked)) {
    log(`could not acknowledge "${cmd.action}"; leaving it for the next poll`);
    return;
  }
  rememberCommand(cmd.id);

  if (cmd.action === 'restart') {
    log('restarting at the panel\'s request');
    // No privileges needed: systemd restarts us. Flush first — process.exit does not wait for
    // stdout, and the reason for a restart is exactly what somebody will look for afterwards.
    setTimeout(() => process.exit(0), 250);
    return;
  }

  if (cmd.action === 'update') {
    requestPrivileged(cmd.id, 'update', 'asked the updater to check for a new version');
    return;
  }

  if (cmd.action === 'reboot') {
    requestPrivileged(cmd.id, 'reboot', 'asked the system to reboot');
    return;
  }

  if (cmd.action === 'logs') {
    // Asks ROOT for the journal, which is a change from what this used to do.
    //
    // It used to just cut the check-in wait so the panel got the agent's own eighty in-memory lines
    // sooner. Those are what the AGENT chose to say, and they miss everything it is not the author
    // of: the root dispatcher's decisions, the installer's nine steps, the ffmpeg exit the agent
    // only summarises. That is the material somebody debugging a screen actually needs, and it lives
    // in the journal, which the agent cannot read — it is not in systemd-journal, and putting it
    // there would hand it every other unit on the machine.
    //
    // The early check-in is kept too: the recent lines are still worth having promptly, and the
    // journal upload happens on the poll as soon as root has written it.
    requestPrivileged(cmd.id, 'logs', 'collecting the full log for the dashboard');
    live.checkInNow = true;
    return;
  }

  // The same request a standalone screen's own panel makes, through the same writer — see
  // control.ts. All that differs is who asked.
  if (isWifiAction(cmd.action)) {
    requestWifi(cmd.id, cmd.action, cmd.wifi);
    return;
  }

  // The screen's own output. Root, because the framebuffer's blank control is root-owned.
  if (cmd.action === 'display-off' || cmd.action === 'display-on') {
    requestPrivileged(cmd.id, cmd.action, `asked the system to turn the screen ${cmd.action === 'display-off' ? 'off' : 'on'}`);
    // Report the result promptly: somebody just pressed a button and is watching the panel.
    live.checkInNow = true;
    return;
  }

  // Confirming a provisional display mode. No payload: the marker root left is the whole state.
  if (cmd.action === 'keep-video-mode') {
    requestPrivileged(cmd.id, 'keep-video-mode', 'confirmed the display mode, so it will not revert');
    live.checkInNow = true;
    return;
  }

  // Forcing one. Same payload shape as the timezone: the verb cannot carry it, because the
  // dispatcher reads a verb through a filter that keeps only lowercase letters and dashes.
  if (cmd.action === 'set-video-mode') {
    if (!cmd.text) {
      log('a set-video-mode arrived with no mode; ignoring it');
      return;
    }
    try {
      const dir = '/var/lib/openmasjid-screen';
      fs.writeFileSync(`${dir}/.video-mode-request`, `${cmd.text}\n`, { mode: 0o600 });
      fs.renameSync(`${dir}/.video-mode-request`, `${dir}/video-mode-request`);
    } catch (e) {
      log('could not leave the display mode for the system:', (e as Error).message);
      return;
    }
    // This one reboots the board, so there is no point waiting for a check-in that will not happen.
    requestPrivileged(cmd.id, 'set-video-mode', `asked the system to set the display mode to "${cmd.text}" and reboot`);
    return;
  }

  // The timezone carries a short string, which cannot travel in the spool file: the dispatcher
  // reads a verb as `head -c 32 | tr -dc 'a-z-'`, which would turn "America/New_York" into
  // "americanewyork". Same shape as a Wi-Fi join — the payload goes beside the verb, and root
  // validates it itself rather than trusting this side.
  if (cmd.action === 'set-timezone') {
    if (!cmd.text) {
      log('a set-timezone arrived with nothing to set; ignoring it');
      return;
    }
    try {
      const dir = '/var/lib/openmasjid-screen';
      // Written and renamed BEFORE the verb, so the dispatcher can never wake on a request whose
      // payload has not landed.
      fs.writeFileSync(`${dir}/.tz-request`, `${cmd.text}\n`, { mode: 0o600 });
      fs.renameSync(`${dir}/.tz-request`, `${dir}/tz-request`);
    } catch (e) {
      log('could not leave the timezone for the system:', (e as Error).message);
      return;
    }
    requestPrivileged(cmd.id, 'set-timezone', `asked the system to set the timezone to "${cmd.text}"`);
    live.checkInNow = true;
    return;
  }

  // No privilege at all: the agent is already in the video group, because drawing is its job.
  if (cmd.action === 'screenshot') {
    log('taking a screenshot for the dashboard');
    await sendScreenshot(cfg);
    return;
  }

  /**
   * A terminal. Handed to ROOT rather than run here.
   *
   * This process runs as omdscreen under NoNewPrivileges, so a shell it started could not become
   * root by any route — `sudo` is not merely absent, it is unusable, and `reboot` cannot work
   * however it is asked for. That is a debugging window, not a terminal, and a screen on a wall in
   * another city needs the real thing.
   *
   * So the session details go into the spool and root starts the terminal itself, in a transient
   * unit that outlives this poll. The verb carries no command — only a session id, a one-time
   * secret and a size — so the spool is still a closed set of verbs rather than a way to run
   * strings; see the `shell-session` arm in the installer for what still holds it shut.
   */
  if (cmd.action === 'shell-session') {
    const s = cmd.shellSession;
    if (!s?.id || !s.secret) {
      log('a terminal session arrived with nothing to dial into; ignoring it');
      return;
    }
    const rows = Math.max(8, Math.min(200, Math.round(s.rows) || 24));
    const cols = Math.max(20, Math.min(400, Math.round(s.cols) || 80));
    try {
      const dir = '/var/lib/openmasjid-screen';
      // Four lines rather than JSON: root reads this too, and parsing JSON in shell is how a
      // validation gets skipped. Written and renamed BEFORE the verb, so the dispatcher cannot wake
      // on a request whose payload has not landed. 0600 because line two is a credential.
      fs.writeFileSync(`${dir}/.shell-request`, `${s.id}\n${s.secret}\n${rows}\n${cols}\n`, { mode: 0o600 });
      fs.renameSync(`${dir}/.shell-request`, `${dir}/shell-request`);
    } catch (e) {
      log('could not leave the terminal session details for the system:', (e as Error).message);
      return;
    }
    // The secret is NOT in this message, and there is no branch here that could put it in one.
    requestPrivileged(cmd.id, 'shell-session', 'asked the system to open a terminal session');
    return;
  }

  if (cmd.action === 'shell') {
    if (!cmd.shell) {
      log('a console command arrived with nothing in it; ignoring it');
      return;
    }
    // NOT logged. The panel shows the command back next to its answer, to the person who typed it;
    // putting it in the agent's own log would copy it into the journal, which is uploaded, kept in
    // the store and shown in a page — and the first thing anybody types into a console on a screen
    // that cannot reach its Wi-Fi is an nmcli line with the masjid's passphrase in it.
    log(`running a console command (${cmd.shell.length} characters)`);
    const r = await runShell(cmd.shell);
    live.shellResult = { id: cmd.id, cmd: cmd.shell, out: r.out, code: r.code, ms: r.ms };
    // Answer now rather than at the next five-minute check-in: somebody is watching the window.
    live.checkInNow = true;
    // And expect another command shortly. Somebody with a console open is mid-conversation with the
    // screen, and a five-second wait to deliver each line makes it unusable for the one job it has.
    live.fastPollUntil = Date.now() + 60_000;
    return;
  }

  if (cmd.action === 'reinstall') {
    // Re-runs the whole installer, which is the only thing that can change the service unit, the
    // boot settings and the installed packages. Self-update replaces the agent file and nothing
    // else, so without this a fix in either of those needs somebody at a keyboard.
    requestPrivileged(cmd.id, 'reinstall', 'asked the installer to run again');
  }
}

/** This device's timezone as the system holds it, so the panel can show what IS rather than what
 *  was last asked for. /etc/timezone is one line and present on Debian; the symlink is the fallback
 *  for an image that has only that. */
function readTimezone(): string {
  try {
    const tz = fs.readFileSync('/etc/timezone', 'utf8').trim();
    if (tz) return tz;
  } catch {
    /* fall through */
  }
  try {
    const link = fs.readlinkSync('/etc/localtime');
    // Split rather than match: the path is /usr/share/zoneinfo/<Area>/<City>, and everything after
    // the marker IS the zone name — which is also true of the two-level ones like America/Argentina.
    const at = link.indexOf('zoneinfo/');
    if (at >= 0) return link.slice(at + 'zoneinfo/'.length);
  } catch {
    /* no idea, then */
  }
  return '';
}

/** Where this board's kernel command line lives. /boot/firmware since Bookworm; the older path is
 *  the fallback, and the agent has to cope with both because a masjid's card may be either. */
function cmdlinePath(): string {
  for (const p of ['/boot/firmware/cmdline.txt', '/boot/cmdline.txt']) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* try the other */
    }
  }
  return '';
}

/**
 * The forced HDMI mode on this device, or 'auto' when there is none.
 *
 * Read from the boot config rather than remembered from what the panel asked for, because a mode
 * nobody confirmed puts itself back — see the video-revert unit in the installer. After that has
 * happened the only truthful answer is the one written on the card.
 */
function readVideoMode(): string {
  const file = cmdlinePath();
  if (!file) return '';
  try {
    const line = fs.readFileSync(file, 'utf8');
    const at = line.indexOf('video=HDMI-A-1:');
    if (at < 0) return 'auto';
    const rest = line.slice(at + 'video=HDMI-A-1:'.length);
    // The command line is space-separated, so the mode ends at the first space or end of line.
    return rest.split(/\s/)[0].trim() || 'auto';
  } catch {
    return '';
  }
}

/** What root left about the last mode change, read once and deleted — the same read-and-delete as
 *  the Wi-Fi verdict, because it is a one-off answer to a one-off question. */
function readVideoModeResult(): string | undefined {
  const file = '/var/lib/openmasjid-screen/video-mode-result';
  try {
    const text = fs.readFileSync(file, 'utf8').trim().slice(0, 200);
    fs.unlinkSync(file);
    return text || undefined;
  } catch {
    return undefined;
  }
}

/** Where the display's own power state can be read: the DPMS of the HDMI connector the kernel owns.
 *
 *  Read from DRM rather than from `vcgencmd display_power`, which reports 1 whatever the state is on
 *  a Pi 4 under KMS — measured, along with the fact that the framebuffer's blank control is what
 *  actually reaches the connector. See the display verbs in the installer. */
function displayIsOff(): boolean {
  try {
    for (const card of fs.readdirSync('/sys/class/drm')) {
      if (!/-HDMI-A-\d+$/.test(card)) continue;
      const dir = `/sys/class/drm/${card}`;
      // Only the connector that is actually plugged in has an opinion worth reporting.
      if (fs.readFileSync(`${dir}/status`, 'utf8').trim() !== 'connected') continue;
      return fs.readFileSync(`${dir}/dpms`, 'utf8').trim().toLowerCase() !== 'on';
    }
  } catch {
    /* no DRM, or a board that reports none of this */
  }
  return false;
}

/** Send a screenshot to the dashboard. Its own route, for the same reason the journal has one: it is
 *  a few hundred kilobytes and wanted occasionally, and sharing the check-in would force that cap up
 *  for every screen on every poll. */
async function sendScreenshot(cfg: AgentConfig, shrink = PREVIEW_SHRINK): Promise<void> {
  const png = framebufferPng(shrink);
  if (!png) {
    log('could not read the framebuffer for a screenshot:', framebufferPngError() || 'no reason given');
    return;
  }
  const res = await postJson<{ ok?: boolean }>(`${cfg.server}/pi/${cfg.token}/screenshot`, {
    png: png.toString('base64'),
  }).catch(() => ({ httpStatus: 0 }));
  const status = (res as { httpStatus?: number }).httpStatus ?? 200;
  if (status >= 200 && status < 300) log(`sent a ${Math.round(png.length / 1024)} KB screenshot to the dashboard`);
  else log(`the display server would not take a screenshot (HTTP ${status})`);
}

/**
 * Turn the display off and on to the schedule, from the device's OWN clock.
 *
 * Enforced here rather than by the panel sending a command at the right moment, because the point of
 * a masjid's screen going dark at midnight is that it happens whether or not the internet does. The
 * agent already has the server's time to correct its own by, so it needs nothing at the moment it
 * acts.
 *
 * It acts on TRANSITIONS only — the minute the schedule names — never continuously. That is what
 * lets somebody turn a screen on by hand during its off hours and have it stay on until the next
 * boundary, instead of fighting a loop that switches it off again a second later.
 */
/**
 * Is this time inside the window that starts at `off` and ends at `on`?
 *
 * The window normally crosses midnight — 23:00 to 04:30 is the whole point of it — so the comparison
 * has to handle off > on. Plain string comparison is correct here and cheaper than parsing: both are
 * zero-padded HH:MM, so they sort in time order.
 */
function insideOffWindow(hhmm: string, off: string, on: string): boolean {
  if (!off || !on || off === on) return false;
  return off < on ? hhmm >= off && hhmm < on : hhmm >= off || hhmm < on;
}

function applyDisplaySchedule(live: Live): void {
  const sch = live.state?.displaySchedule;
  const reb = live.state?.rebootSchedule;
  if (!sch?.enabled && !reb?.enabled) return;
  const now = live.serverTime();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  /**
   * Once per boot: match the schedule's CURRENT state, not just its next boundary.
   *
   * Acting on transitions alone is right while the agent is running — it is what lets somebody turn
   * a screen on by hand during its off hours without a loop fighting them. It is wrong the moment
   * the board has just started, because a fresh boot leaves the framebuffer unblanked: a screen
   * scheduled dark from 23:00 to 04:30 that reboots at 03:00 — which every screen now does by
   * default — came back up LIT and stayed lit, since 04:30's "turn on" has nothing to do and 23:00
   * is twenty hours away. The two features cancelled each other out.
   *
   * Only if the display is actually on, so this does not leave a spool file on every boot.
   */
  if (!live.scheduleReconciled) {
    live.scheduleReconciled = true;
    if (sch?.enabled && insideOffWindow(hhmm, sch.offAt, sch.onAt) && !displayIsOff()) {
      requestPrivileged('sch_boot_off', 'display-off', 'this screen is inside its overnight hours, so switching it off');
    }
  }

  // ONE minute guard for both schedules, so a minute is acted on once whichever of them named it.
  if (hhmm === live.lastScheduleMinute) return;
  live.lastScheduleMinute = hhmm;
  if (sch?.enabled && sch.offAt && sch.onAt) {
    if (hhmm === sch.offAt) requestPrivileged(`sch_${hhmm.replace(':', '')}off`, 'display-off', 'switching the screen off for the night');
    else if (hhmm === sch.onAt) requestPrivileged(`sch_${hhmm.replace(':', '')}on`, 'display-on', 'switching the screen back on');
  }
  // Last, so a board scheduled to reboot at the same minute it goes dark does the dark part first.
  if (reb?.enabled && reb.at && hhmm === reb.at) {
    requestPrivileged(`sch_${hhmm.replace(':', '')}reboot`, 'reboot', 'rebooting on the nightly schedule');
  }
}

/**
 * A terminal session: dial out to the server and give it a real shell.
 *
 * The direction is the whole point. Nothing connects TO this device — it is behind a masjid's NAT
 * on an address DHCP moves, and it holds a capability rather than listening on a port. So the panel
 * mints a session, we are told about it on an ordinary state poll, and WE open the socket. The
 * invariant survives and a keystroke still arrives in milliseconds.
 *
 * ## The pty, without a native module
 *
 * `script` (util-linux, already on the image) allocates a pty and runs a command inside it. That is
 * what makes this a real terminal — a prompt, job control, an editor — rather than a pipe with a
 * shell on the end. Two details it cost to find:
 *
 *  - **`SHELL` has to be forced.** `script -c` runs its command through `$SHELL`, and this account's
 *    shell is `/usr/sbin/nologin` (it is a service account, deliberately). Without this the session
 *    opens and immediately prints "This account is currently not available".
 *  - **The size is set once, at spawn.** `stty rows/cols` inside the pty is the only handle we have
 *    on it; resizing the browser window mid-session cannot reflow it, because that needs TIOCSWINSZ
 *    on the pty fd and we do not have one without a native module. Sized from the browser's terminal
 *    when the session is minted, which is right for every case except resizing mid-session.
 *
 * ## What it is allowed to be: everything
 *
 * This runs as ROOT, and it is the only part of this agent that does. It is not started by the agent
 * — the agent cannot start anything privileged — but by the control spool, in a transient unit; see
 * the `shell-session` arm in the installer for the whole of what still holds it shut.
 *
 * It was deliberately the other way round first: the same account and sandbox as the one-shot
 * console, NoNewPrivileges, no sudo, no way to reboot the board. That is a defensible thing to build
 * and it is not a terminal. You could not restart the screen you were looking at, could not install
 * a package to diagnose something, could not read a root-owned log — and every one of those is why
 * somebody opens a terminal on a machine three hundred miles away. OpenMasjidOS's own dashboard
 * offers a real root shell; a screen managed from the same family of dashboards should not offer
 * something that merely looks like one.
 *
 * What did NOT change is the way in: the panel mints a session, the device is offered it once and
 * dials OUT, the secret never reaches a browser, and the server expires it three different ways.
 * The privilege at the far end moved; the door did not.
 *
 * Nothing here logs a byte of the session. Not the keystrokes, not the output, not a sample: a
 * terminal transcript is the likeliest thing in this whole app to contain a password — and now the
 * likeliest to contain a root one.
 */
function runShellSession(cfg: AgentConfig, s: { id: string; secret: string; rows: number; cols: number }): void {
  const url = `${cfg.server.replace(/^http/, 'ws')}/pi/${cfg.token}/shell/${encodeURIComponent(s.id)}`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url, { headers: { 'x-openmasjid-shell-secret': s.secret } });
  } catch (e) {
    log('could not open a terminal session:', (e as Error).message);
    return;
  }

  let child: ReturnType<typeof spawn> | null = null;
  let closed = false;
  const done = (why: string): void => {
    if (closed) return;
    closed = true;
    clearTimeout(cap);
    try {
      child?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    try {
      ws.close();
    } catch {
      /* already gone */
    }
    log(`terminal session ended (${why})`);
  };

  // Our own backstop for the server's limits. If the socket is wedged rather than closed, this is
  // what stops a bash sitting on the device for the rest of the week.
  const cap = setTimeout(() => done('reached the local time limit'), SHELL_SESSION_MAX_MS);

  ws.on('open', () => {
    const rows = Math.max(8, Math.min(200, Math.round(s.rows) || 24));
    const cols = Math.max(20, Math.min(400, Math.round(s.cols) || 80));
    // Root's own home, because this process IS root — started by the control spool as a transient
    // unit, not by the agent. HOME is not cosmetic here: every tool that writes a dotfile uses it,
    // and pointing root's shell at the agent's state directory would scatter root-owned files
    // through a directory the agent has to be able to write.
    const asRoot = process.getuid?.() === 0;
    try {
      child = spawn('script', ['-qfc', `stty rows ${rows} cols ${cols}; exec /bin/bash -i`, '/dev/null'], {
        cwd: asRoot ? '/root' : shellCwd(),
        env: {
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          HOME: asRoot ? '/root' : '/var/lib/openmasjid-screen',
          // Forced: see the note above about nologin.
          SHELL: '/bin/bash',
          TERM: 'xterm-256color',
          LANG: 'C.UTF-8',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      try {
        ws.send(`\r\ncould not start a shell: ${(e as Error).message}\r\n`);
      } catch {
        /* the socket went too */
      }
      done('the shell would not start');
      return;
    }
    log('terminal session open');
    child.stdout?.on('data', (b: Buffer) => {
      try {
        if (ws.readyState === 1) ws.send(b);
      } catch {
        /* closing */
      }
    });
    child.stderr?.on('data', (b: Buffer) => {
      try {
        if (ws.readyState === 1) ws.send(b);
      } catch {
        /* closing */
      }
    });
    child.on('close', () => done('the shell exited'));
    child.on('error', () => done('the shell failed'));
  });

  ws.on('message', (data: unknown) => {
    // Whatever the panel typed, straight into the pty. Not inspected and not logged.
    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      child?.stdin?.write(buf);
    } catch {
      /* the shell has gone */
    }
  });
  ws.on('close', () => done('the panel closed it'));
  ws.on('error', (e: Error) => done(`socket error: ${e.message}`));
}

/** The state directory when we can use it, otherwise the root.
 *
 *  spawn() throws synchronously on a cwd it cannot use, which would turn every console command into
 *  "could not run that: EACCES" and point the blame at the command rather than at the directory. */
function shellCwd(): string {
  const dir = '/var/lib/openmasjid-screen';
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK);
    return dir;
  } catch {
    return '/';
  }
}

/** Our own ceiling on a terminal session, behind the server's. If the socket is wedged rather
 *  than closed, this is what stops a bash sitting on the device for the rest of the week. */
/**
 * How much to shrink a screenshot before sending it.
 *
 * 2 halves each axis, so a quarter of the pixels: a 1080p timetable goes from about half a megabyte
 * to well under a hundred kilobytes, which is what makes a frame a second through a masjid's tunnel
 * reasonable rather than rude. A timetable is large flat type, so it stays readable — and reading
 * the times off it is the only thing anybody wants the picture for.
 */
const PREVIEW_SHRINK = 2;

const SHELL_SESSION_MAX_MS = 65 * 60_000;

/** How long a console command may run before it is killed, and how much of its output is kept.
 *  Both are bounded because nobody is watching this device: a command that waits for input would
 *  otherwise wait for ever, and one that prints a filesystem would fill a check-in. */
const SHELL_TIMEOUT_MS = 20_000;
const SHELL_MAX_OUT = 10_000;

/**
 * Run one line from the panel's console, and collect what it said.
 *
 * ## What this is allowed to be
 *
 * This is the one place the device does something it was not told the shape of in advance, so the
 * boundary is worth stating precisely. It runs as `omdscreen`, the agent's own account, inside the
 * agent's own unit — `NoNewPrivileges=yes`, `ProtectSystem=strict`, no write access to /opt, no
 * capability to reboot the board, no sudo. Every root action this device can perform still goes
 * through the control spool, whose verb set is closed and stays closed. So a console command can
 * READ almost anything on the board and can run almost any tool, and it cannot become root, cannot
 * rewrite the agent, and cannot reach anything the agent could not already reach.
 *
 * That is a real widening of what an admin can do to a screen, and it is deliberate: debugging a
 * screen on a wall in another building otherwise means asking somebody to carry a keyboard to it.
 *
 * ## Why `sh -c` and not an argument list
 *
 * A console is only useful if a pipe is a pipe. Building an argv here would mean reimplementing a
 * shell badly, and the thing an argv protects against — an attacker who controls part of a command
 * line — is not the situation: the whole line comes from an authenticated admin in the panel, and
 * a shell is what they asked for. Note the contrast with the media pipeline, where the URL comes
 * from a config field and ffmpeg is therefore ALWAYS spawned as an array with no shell anywhere
 * near it. Different threat, different rule.
 */
function runShell(cmd: string): Promise<{ out: string; code: number | null; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (code: number | null, note = ''): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const text = (out + note).slice(0, SHELL_MAX_OUT);
      resolve({ out: text || '(no output)', code, ms: Date.now() - started });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('/bin/sh', ['-c', cmd], {
        // Its own state directory, because it is the one place this user may write — with a fallback
        // when it is not reachable at all; see shellCwd.
        cwd: shellCwd(),
        // A deliberately plain environment. The agent's own has the server address and nothing
        // secret in it, but "nothing secret in it" is a property that has to be re-checked every
        // time somebody adds a variable, and a console does not need it to be true.
        env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/var/lib/openmasjid-screen', TERM: 'dumb', LC_ALL: 'C' },
        // No terminal, and stdin closed at once: a command that prompts gets EOF and gives up,
        // rather than sitting there until the timeout with nobody able to answer it.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ out: `could not run that: ${(e as Error).message}`, code: null, ms: Date.now() - started });
    }
    const take = (chunk: Buffer): void => {
      if (out.length < SHELL_MAX_OUT) out += chunk.toString('utf8');
    };
    child.stdout?.on('data', take);
    // Interleaved rather than labelled, because that is what a terminal shows and most tools say
    // the useful half of what they say on stderr.
    child.stderr?.on('data', take);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null, `\n[stopped after ${SHELL_TIMEOUT_MS / 1000}s]`);
    }, SHELL_TIMEOUT_MS);
    child.on('error', (e) => finish(null, `\n[could not run: ${e.message}]`));
    child.on('close', (code) => finish(code));
  });
}



/** Where root leaves the journal it collected for us. */
const JOURNAL_PATH = '/var/lib/openmasjid-screen/journal.txt';

/** Upload backoff for that file. Without it, a server that will not take the log is re-sent it on
 *  every pass of the poll loop — a rejected 90 KB POST every few seconds, for ever. */
let journalRetryAt = 0;
let journalTries = 0;

/**
 * Send the journal root collected, and delete it once the server has it.
 *
 * Deleted only on SUCCESS, unlike the Wi-Fi verdict's read-and-delete: a log is worth retrying, and
 * a failed upload that destroyed its own payload would leave somebody pressing the button again for
 * a file that no longer exists. It is bounded on the device, so keeping it costs nothing.
 *
 * Sent to its own endpoint rather than on the check-in. A check-in is capped at 32KB and carries the
 * facts the dashboard needs constantly; a log is up to 180KB and is wanted occasionally. Putting the
 * log in that body would either crowd out the facts or force the cap up for everybody — and the last
 * time a route cap and its payload disagreed, every check-in was silently discarded for weeks.
 */
async function sendJournal(cfg: AgentConfig): Promise<void> {
  if (Date.now() < journalRetryAt) return;
  let text = '';
  try {
    if (!fs.existsSync(JOURNAL_PATH)) return;
    text = fs.readFileSync(JOURNAL_PATH, 'utf8');
  } catch {
    return; // not readable yet; root may still be writing it
  }
  if (!text) return;
  const res = await postJson<{ ok?: boolean }>(`${cfg.server}/pi/${cfg.token}/logs`, {
    journal: text,
  }).catch(() => ({ httpStatus: 0 }));
  const status = (res as { httpStatus?: number }).httpStatus ?? 200;
  if (status >= 200 && status < 300) {
    try {
      fs.unlinkSync(JOURNAL_PATH);
    } catch {
      /* it will simply be overwritten next time */
    }
    journalTries = 0;
    journalRetryAt = 0;
    log(`sent ${text.length} bytes of log to the dashboard`);
    return;
  }

  // It failed, and until now that was silent — which is how a server whose route did not exist
  // could answer 401 to every upload for as long as the feature had been shipped, with nothing on
  // the device and nothing in the dashboard to say so.
  journalTries += 1;
  // A 4xx is the server refusing THIS body, and it will refuse it identically for ever; anything
  // else (a timeout, a rate limit, a 5xx, no network at all) is worth waiting out. So one is
  // dropped with a reason and the other is retried, slower each time.
  const refused = status >= 400 && status < 500 && status !== 408 && status !== 429;
  if (refused) {
    try {
      fs.unlinkSync(JOURNAL_PATH);
    } catch {
      /* it will be overwritten by the next collection */
    }
    journalTries = 0;
    journalRetryAt = 0;
    log(`the display server refused a ${text.length}-byte log upload (HTTP ${status}); dropped it — ask for the log again once the server is up to date`);
    return;
  }
  journalRetryAt = Date.now() + Math.min(5_000 * 2 ** (journalTries - 1), 5 * 60_000);
  log(`log upload failed (HTTP ${status}); retrying in ${Math.round((journalRetryAt - Date.now()) / 1000)}s`);
}


/** Tell the server what this device is, how it is attached, and what it has been saying. */
async function checkIn(
  cfg: AgentConfig,
  facts: DeviceFacts,
  /** the answer to a console command, if one is waiting to be carried */
  shellResult?: { id: string; cmd: string; out: string; code: number | null; ms: number } | null,
): Promise<void> {
  // Gathered fresh on every check-in rather than once at startup: a cable being pulled out is
  // exactly the event this exists to show, and it happens long after boot.
  const net = await netFacts();
  // What this screen can see. Reading the list NetworkManager already holds needs no privilege at
  // all — verified inside this agent's own sandbox — so it costs nothing to report and it is what
  // lets somebody pick a network in the dashboard rather than type its name from memory.
  const networks = net.hasWifi ? await scanNetworks() : [];
  await postJson(`${cfg.server}/pi/${cfg.token}/seen`, {
    hostname: facts.hostname,
    ip: facts.ip,
    model: facts.model,
    agentVersion: AGENT_VERSION,
    recentLog,
    net,
    networks,
    // Cheap enough to send every time: three world-readable files, no privilege, no subprocess.
    stats: piStats(),
    // Whether root here has a server address it trusts. Sent on every check-in rather than only
    // at enrolment because re-running the installer is how a screen GAINS one, and the dashboard
    // should stop warning about it without waiting for a restart. See rootLinked().
    rootLinked: rootHasTrustedServer(),
    displayOff: displayIsOff(),
    videoMode: readVideoMode(),
    // A provisional mode: root left this marker and will put the old one back in a few minutes
    // unless somebody confirms. The panel needs it to know to ask.
    videoModePending: fs.existsSync('/var/lib/openmasjid-screen/video-mode-pending'),
    videoModeResult: readVideoModeResult(),
    // What the device believes, not what the panel asked for: a television somebody unplugged and a
    // schedule that fired while nobody was looking both have to show correctly.
    timezone: process.env.TZ || readTimezone(),
    wifiResult: readWifiResult(),
    shellResult: shellResult ?? undefined,
  }).catch(() => ({ httpStatus: 0 }));
}

// ── waiting to be adopted ─────────────────────────────────────────────────────

/**
 * What one enrolment attempt came back with, in the words the television and the panel use.
 *
 * Shared because there are now two callers and they want the same answer on different schedules.
 * A screen the INSTALLER pointed at a server waits here until it is adopted and has nothing else
 * to do; a screen pointed at one from its OWN panel re-reads its config between attempts, because
 * the address can be corrected or withdrawn in that panel while this is running. One loop could
 * not serve both — the first blocks for ever by design, and the second must not — so what is
 * shared is the attempt rather than the loop around it.
 */
interface EnrolPass {
  /** the code to show; carried over from the last attempt when this one could not reach anybody */
  code: string;
  connected: boolean;
  /** one plain sentence about what is going on, for the screen and for the panel */
  status: string;
  /** present only once somebody has approved this screen in the server's dashboard */
  token?: string;
}

/** One attempt, with `lastCode` kept so a failed pass does not blank a code already on screen. */
async function enrolOnce(cfg: AgentConfig, facts: DeviceFacts, lastCode: string): Promise<EnrolPass> {
  const reply = await postJson<EnrolReply>(`${cfg.server}/pi/enrol`, {
    deviceId: cfg.deviceId,
    deviceSecret: cfg.deviceSecret,
    hostname: facts.hostname,
    ip: facts.ip,
    model: facts.model,
    agentVersion: AGENT_VERSION,
    rootLinked: rootHasTrustedServer(),
  }).catch((e: Error) => {
    // A name that will not resolve, a refused connection, a timeout: all the same to the person
    // looking at the screen, and all fixed by looking at the network.
    log('enrol failed:', e.message);
    return { httpStatus: 0 };
  });

  if (failed(reply)) {
    return {
      code: lastCode,
      connected: false,
      status:
        reply.httpStatus === 429
          ? 'The display server is busy. Retrying…'
          : `Cannot reach the display server at ${cfg.server}`,
    };
  }
  return {
    code: reply.code || lastCode,
    connected: true,
    status: 'Waiting for this code to be entered in the dashboard',
    ...(reply.token ? { token: reply.token } : {}),
  };
}

/**
 * Not yet adopted: show a code, and keep asking whether somebody has typed it.
 *
 * The path a screen the INSTALLER set up takes. It has no local account and no panel of its own —
 * it was built to belong to a display server — so there is nothing to do here but wait, and the
 * television is the only thing it can say it with.
 *
 * Enrolment is re-sent on every pass rather than once, for two reasons. It is how the device finds
 * out it has been adopted — the token comes back in the reply — and it is how the panel's list
 * stays current, since the facts sent along with it are what that list shows.
 */
async function waitForAdoption(screen: Screen | null, cfg: AgentConfig, facts: DeviceFacts): Promise<string> {
  let pass: EnrolPass = { code: '', connected: false, status: 'Contacting the display server…' };

  for (;;) {
    pass = await enrolOnce(cfg, facts, pass.code);
    if (pass.token) {
      log('adopted; saving credentials');
      return pass.token;
    }
    screen?.show(
      pairingSvg({
        code: pass.code,
        ip: facts.ip,
        hostname: facts.hostname,
        server: cfg.server,
        status: pass.status,
        connected: pass.connected,
        agentVersion: AGENT_VERSION,
      }),
    );
    await sleep(pass.connected ? POLL_MS : Math.min(POLL_MS * 3, 15_000));
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
  /** set by a "logs" command so the check-in loop stops waiting and reports at once */
  checkInNow = false;
  /**
   * The background, already frosted — and what it was frosted FROM, so a changed wallpaper cannot
   * keep being drawn as the old one.
   *
   * Held here rather than in the AssetCache because it is not an asset: it is derived from one, at a
   * size that depends on the timetable, and it is worthless the moment either changes. See
   * frostOnce for the measurement that makes it worth holding at all.
   */
  frosted: string | null = null;
  frostedSrc: string | null = null;
  frostedDims = '';
  /** the answer to the last console command, until a check-in has carried it */
  shellResult: { id: string; cmd: string; out: string; code: number | null; ms: number } | null = null;
  /** while this is in the future, poll faster — see the 'shell' branch of runCommand */
  fastPollUntil = 0;
  /** the last HH:MM the display schedule was evaluated for, so a boundary fires once and not on
   *  every poll inside that minute — see applyDisplaySchedule */
  lastScheduleMinute = '';
  /** Whether the schedule has been reconciled once since this process started. The schedule acts on
   *  TRANSITIONS, which is right while running and wrong immediately after a boot — see
   *  applyDisplaySchedule. */
  scheduleReconciled = false;

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

  // Once the background itself is in hand, blur it — see frostOnce. Skipped entirely by a screen
  // with no custom background, which is most of them.
  const bgUri = imageFor(live, st.assets.background);
  if (bgUri && st.timetable) {
    const { width, height } = dimsFor(st.timetable.orientation, st.timetable.quality);
    frostOnce(live, bgUri, width, height);
  } else if (!bgUri && live.frosted) {
    // The wallpaper was removed. Drop it rather than hold a megabyte for a screen that is now
    // drawing the themed scene.
    live.frosted = null;
    live.frostedSrc = null;
    live.frostedDims = '';
  }

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

/**
 * Blur the background once, instead of once a frame.
 *
 * Measured with resvg on a Raspberry Pi 4, drawing a real masjid's 1080p timetable with its own
 * wallpaper: 4764 ms a frame with the frost, 966 ms with the frost removed, 758 ms with no wallpaper
 * at all. The blur is 3.8 seconds of every frame — and it is the same blur of the same photograph
 * every time. The screen's cadence controller did exactly what it was built to do with that and
 * slowed the redraw to once every five seconds, so a masjid that set a wallpaper got a clock that
 * visibly lurched, with nothing in the panel to connect the two.
 *
 * So: rasterise the frosted layer here, on the POLL loop, and let every frame draw the result. It
 * belongs on the poll loop rather than in drawFrame for two reasons — the draw loop's timing is what
 * the cadence is measured from, and a one-off four-second frame would peg that measurement at the
 * cost it is meant to be removing.
 *
 * Failure is not fatal: leave `frosted` null and the frame draws the unblurred original through the
 * renderer's own filter, which is slow and correct rather than fast and wrong.
 */
function frostOnce(live: Live, bgUri: string, width: number, height: number): void {
  const dims = `${width}x${height}`;
  if (live.frosted && live.frostedSrc === bgUri && live.frostedDims === dims) return;
  const t0 = Date.now();
  try {
    const png = new Resvg(frostedBackgroundSvg(bgUri, width, height), {
      fitTo: { mode: 'width', value: width },
    })
      .render()
      .asPng();
    live.frosted = `data:image/png;base64,${png.toString('base64')}`;
    live.frostedSrc = bgUri;
    live.frostedDims = dims;
    log(`frosted the background once in ${Date.now() - t0}ms; every frame after this skips that blur`);
  } catch (e) {
    live.frosted = null;
    live.frostedSrc = null;
    log('could not pre-blur the background; drawing it the slow way:', (e as Error).message);
  }
}

/** A resolved `data:` URI for one of the state's asset paths, or null while it is still being
 *  fetched — in which case the renderer draws the themed scene instead, which is correct: a
 *  screen that shows the theme for a few seconds while a photograph arrives is behaving, and one
 *  that shows nothing until it does is not. */
function imageFor(live: Live, pathOrNull: string | null): string | null {
  if (!pathOrNull) return null;
  // Already resolved. A standalone screen reads its own uploads off its own disk, so there is no
  // server URL to look up and nothing to fetch — the value IS the picture.
  if (pathOrNull.startsWith('data:')) return pathOrNull;
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
      lostBadge(
        live,
        messageSvg(
          st.content.kind === 'off' ? 'Screen is off' : 'Nothing to show yet',
          st.screenName || '',
        ),
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

  // The pre-blurred layer is used only when it was made from THIS background at THIS size. Either
  // having just changed leaves it stale for one poll, and drawing a stale wallpaper is exactly the
  // bug this whole area keeps producing — so the guard is on both, and the fallback is the correct
  // slow path rather than the wrong fast one.
  const bgUri = imageFor(live, st.assets.background);
  const { width: fw, height: fh } = dimsFor(tt.orientation, tt.quality);
  const preblurred = !!bgUri && !!live.frosted && live.frostedSrc === bgUri && live.frostedDims === `${fw}x${fh}`;

  const svg = renderDisplaySvg(tt, now, {
    bg: preblurred ? live.frosted : bgUri,
    bgPreblurred: preblurred,
    logo: imageFor(live, st.assets.logo),
    announcement: imageFor(live, annUrl),
    bgLight: st.bgLight,
    ...(st.autoAccent ? { autoAccent: st.autoAccent } : {}),
    // NOT tickerBandOnly. That mode exists for pipelines where something else composites the
    // moving text over the band — ffmpeg for the video path, CSS for a browser screen. Here
    // there is no compositor, so the renderer draws the ticker itself, exactly as the admin's
    // still preview does.
  });

  return screen.show(lostBadge(live, svg), live.fontFiles, live.state?.fontFamilies);
}

/**
 * The frame, with the "server connection lost" badge on it once the server has been silent past
 * `STALE_AFTER_MS`. The timetable keeps drawing underneath it: its times are computed here. A
 * playing camera gets no badge — ffmpeg writes it straight to the framebuffer, so there is nothing
 * of ours to draw on — but a camera RELAYED by the server stops with it, and the card that takes
 * its place does carry one.
 */
function lostBadge(live: Live, svg: string): string {
  return live.stale() ? withConnectionLost(svg) : svg;
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

  /**
   * An adopted screen serves a panel too — one read-only status page.
   *
   * It used to serve nothing: createPiPanel was built inside runStandalone, so adoption took the
   * panel away. Measured on hardware — port 80 went 200, unreachable, 200 across a round trip —
   * and the cost lands on the day a masjid's display server dies for good, when every screen keeps
   * drawing and none of them can be reached except over SSH.
   *
   * A SEPARATE, much smaller handler rather than the standalone panel with its writes disabled:
   * see managedPanel.ts. Nothing that writes is registered, so there is no guard to get wrong.
   */
  const status = (): ManagedStatus => ({
    screenName: live.state?.screenName ?? '',
    hostname: facts.hostname,
    ip: facts.ip,
    model: facts.model,
    agentVersion: AGENT_VERSION,
    server: cfg.server,
    // `stale()` is the agent's own judgement of whether the server has gone quiet long enough that
    // the picture may be out of date — the same one that dims the screen. Reused rather than
    // re-derived, so the page and the television cannot disagree.
    serverReachable: live.lastPollOk > 0 && !live.stale(),
    lastContactAt: live.lastPollOk > 0 ? new Date(live.lastPollOk).toISOString() : null,
    content: !live.state
      ? 'nothing'
      : live.state.content.kind === 'source'
        ? 'camera'
        : live.state.content.kind === 'off'
          ? 'off'
          : 'timetable',
    clockSuspect: clockSuspect(),
    displayOff: displayIsOff(),
  });
  const panel = createManagedPanel({ webDir: WEB_DIR, status });
  const panelServer = http.createServer((req, res) => panel(req, res));
  panelServer.on('error', (e) => log('panel listener:', e.message));
  panelServer.listen(PANEL_PORT, () => log(`managed panel listening on port ${PANEL_PORT}`));

  // ── the polling loop ──
  const poll = async (): Promise<void> => {
    let pollMs = POLL_MS;
    while (!live.forgotten) {
      // Off and on to the schedule, from this device's OWN clock.
      //
      // First in the loop, and deliberately BEFORE the state fetch — everything below this line is
      // skipped when the server cannot be reached, and a screen going dark overnight is the one
      // thing that must not depend on that. The schedule and the clock offset are both from the
      // last successful poll, which is all it needs.
      applyDisplaySchedule(live);
      // Has root left an answer about a Wi-Fi join? Checked here, on the poll, rather than waiting
      // for the next check-in — those are five minutes apart, and somebody who has just pressed
      // Connect is watching the dashboard now. A stat every few seconds is nothing; making them
      // wait five minutes to find out whether their password was right is the difference between a
      // feature and a guessing game.
      if (fs.existsSync('/var/lib/openmasjid-screen/wifi-result')) live.checkInNow = true;
      // And upload the journal as soon as root has finished writing one. Same reasoning: somebody
      // has just pressed a button and is watching, so this cannot wait for the five-minute check-in.
      if (fs.existsSync(JOURNAL_PATH)) await sendJournal(cfg);

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

      if (st.command) {
        // Deliberately awaited: a restart ends this loop, and there is nothing after it worth
        // racing.
        await runCommand(cfg, st.command, live).catch((e: Error) => log('command failed:', e.message));
      }

      await resolveAssets(live, cache, cfg.server).catch(() => {
        /* a missing image draws the themed scene instead; the next poll tries again */
      });
      // Somebody is watching this screen in the dashboard. Send a frame, and poll fast enough for
      // it to look live — the same fast-poll window a console uses, re-armed on every frame for as
      // long as the panel keeps saying somebody is there. Both ends expire: the panel stops
      // refreshing previewUntil when its window closes, and this stops the moment that lapses.
      if (st.previewUntil && Date.now() < st.previewUntil) {
        live.fastPollUntil = Date.now() + 30_000;
        await sendScreenshot(cfg).catch(() => {
          /* a dropped frame is not worth a log line once a second */
        });
      }
      // A console open in the panel shortens the wait, for a minute at a time. Bounded, and only
      // ever set by having just run something: a screen nobody is looking at is back to five
      // seconds within a minute, so this cannot become a device that polls hard for ever.
      await sleep(Date.now() < live.fastPollUntil ? Math.min(pollMs, 1200) : pollMs);
    }
  };

  // ── the check-in ──
  //
  // Separate from polling because it answers a different question. Polling asks what to show;
  // this says what we are, so an admin looking at a list of a dozen screens can see which have
  // picked up an update and which have not.
  const checkin = async (): Promise<void> => {
    while (!live.forgotten) {
      // Taken BEFORE the post and cleared after it: an answer must be handed over exactly once, and
      // a second command answered while this one is in flight has to survive rather than be
      // overwritten by clearing the field afterwards.
      const answer = live.shellResult;
      await checkIn(cfg, facts, answer);
      if (answer && live.shellResult === answer) live.shellResult = null;
      // A "logs" request is answered by checking in early rather than by anything privileged, so
      // the wait is interruptible.
      for (let i = 0; i < CHECKIN_MS / 1000 && !live.forgotten; i++) {
        if (live.checkInNow) {
          live.checkInNow = false;
          break;
        }
        await sleep(1000);
      }
    }
  };

  /** When the camera stopped playing, so a routine reconnect can be told from a real outage. */
  let cameraDownSince = 0;

  // ── the drawing loop ──
  const draw = async (): Promise<void> => {
    while (!live.forgotten) {
      // Nothing to draw while the output is asleep.
      //
      // Not required for correctness — the blank survives us writing frames, measured on the
      // hardware — but a screen that is off between midnight and Fajr has no reason to spend a
      // Pi's CPU rendering 1080p SVG into a framebuffer nobody can see. Stopping the camera
      // matters more than the drawing does: that is a continuous H.264 decode, and it is the
      // difference between a board idling overnight and one running warm all night for nothing.
      if (displayIsOff()) {
        player.stop();
        await sleep(5000);
        continue;
      }
      if (!live.state) {
        screen?.show(messageSvg('Connecting…', `Waiting for ${cfg.server}`));
        await sleep(2000);
        continue;
      }
      // A camera and the timetable are the same pixels, so exactly one of them may be running.
      // ffmpeg draws straight to the framebuffer; anything we painted would be a flicker over it.
      const stream = live.state.stream;
      if (stream && screen) {
        player.play(stream.url, screen.geo);
        const st = player.status();
        if (st.playing) {
          cameraDownSince = 0;
          await sleep(2000);
          continue;
        }
        // A gap of a second or two is normal here and does not mean anything is wrong. Some cameras
        // tear the session down on their own schedule — a UniFi one measured on real hardware ends
        // it every seventy seconds or so, cleanly, and ffmpeg reports that as a normal end of
        // stream — and the reconnect that follows takes about as long as a TLS handshake.
        //
        // Painting "Camera unavailable" into that gap was worse than the gap. It put a warning on
        // the wall for three seconds every minute or so on a camera that was working, which reads
        // as a broken screen rather than a brief hiccup. The framebuffer still holds the last frame
        // ffmpeg wrote, so drawing NOTHING leaves the picture standing and the reconnect is
        // invisible.
        //
        // After the grace period it is no longer a hiccup and the card is the right answer: a
        // camera that is genuinely unreachable must say so, not show a frozen picture for ever.
        if (!cameraDownSince) cameraDownSince = Date.now();
        if (Date.now() - cameraDownSince < CAMERA_GRACE_MS) {
          await sleep(400);
          continue;
        }
        // Between attempts. Saying which camera and what went wrong turns "the screen is black"
        // into something whoever is standing there can act on.
        screen.show(
          lostBadge(
            live,
            messageSvg(
              'Camera unavailable',
              st.lastError ? st.lastError.slice(0, 120) : `Trying to reach the camera for "${live.state.screenName}"`,
            ),
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
  // Hand port 80 back before returning. This function returns when the screen is FORGOTTEN, and
  // the caller's next pass either waits for adoption again or runs standalone — both of which
  // bind this port. A listener left open makes that fail with EADDRINUSE, which would look like
  // a screen that forgot how to serve its own panel.
  await new Promise<void>((r) => panelServer.close(() => r()));
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
    /**
     * A server address, OR a deliberate standalone config — which the installer writes with an
     * identity already in it.
     *
     * The identity is the test for "written on purpose". A file truncated by a power cut parses
     * as `{}`: no server and no identity. Accepting that as standalone would take a screen that
     * has been adopted for a year and present it to the hall as a brand-new one asking to be set
     * up, which is a far worse failure than waiting. So a config with neither keeps waiting,
     * exactly as it did before standalone existed.
     */
    if (isUsableConfig(cfg)) return cfg!;
    if (attempt === 0) log(`no usable config at ${CONFIG_PATH}; waiting`);
    screen?.show(
      messageSvg('Not set up yet', 'This screen has no configuration. Re-run the installer on this device.'),
    );
    await sleep(10_000);
  }
}

/**
 * The state a standalone screen would have been sent, built from what is on this device.
 *
 * Same shape as the wire state the server sends, so `drawFrame` is the one that draws it and
 * there is no second rendering path to keep in step. The assets are `data:` URIs read straight
 * off this disk — `render/background` caches them by modification time, so this costs one read
 * per change rather than one per frame.
 */
/**
 * The faces this device draws with, resolved once.
 *
 * The same scan the server runs, so a standalone screen picks what the server would have picked
 * — including the Arabic face, which is the whole point. Naming the files matters: resvg is
 * given `loadSystemFonts: false` when there are files, and with system fonts and a Latin default
 * family it takes the Latin face and draws every Arabic glyph on the timetable as an empty box.
 * See Screen.show, where that measurement is recorded.
 */
const FONTS = fontOptions();

function localState(store: Store, live: Live): void {
  const db = store.db;
  // One screen, so one assignment: whatever this device was told to show, or the only timetable
  // there is. A screen with nothing configured says so rather than going black.
  const tv = db.tvs[0];
  // A volunteer's manual override outranks the default, until it expires — the same precedence
  // the server applies, and the reason the volunteer page works with no server behind it.
  const override = tv?.override && (tv.override.until === null || tv.override.until > Date.now()) ? tv.override.content : null;
  const ref = override ?? tv?.defaultContent ?? { kind: 'timetable' as const, id: db.timetables[0]?.id ?? '' };
  const tt = ref.kind === 'timetable' ? (db.timetables.find((t) => t.id === ref.id) ?? null) : null;
  const ann = tt?.announcements?.images ?? [];

  live.state = {
    content: ref,
    timetable: tt,
    assets: {
      background: tt?.backgroundImage ? backgroundDataUri(tt.backgroundImage) : null,
      logo: tt?.logoImage ? logoDataUri(tt.logoImage) : null,
      announcements: ann.map((f) => announcementDataUri(f)).filter((u): u is string => !!u),
    },
    // Only for an ENABLED source — a disabled one is "off", not "try anyway". The same rule
    // the server applies when it builds this for an adopted screen.
    stream: ref.kind === 'source' ? (() => {
      const src = db.sources.find((x) => x.id === ref.id);
      return src && src.enabled ? { url: src.url, mode: src.mode } : null;
    })() : null,
    fonts: [],
    fontFamilies: {
      default: FONTS.defaultFontFamily,
      serif: FONTS.serifFamily ?? FONTS.defaultFontFamily,
      sansSerif: FONTS.sansSerifFamily ?? FONTS.defaultFontFamily,
    },
    // Both are the render worker's job on the server, and there is no worker here. Leaving them
    // alone means the timetable's own colour choice decides, which is what it does when a masjid
    // has not set a wallpaper — the common case on a screen configured from its own panel.
    bgLight: false,
    autoAccent: null,
    serverNow: Date.now(),
    clockSuspect: clockSuspect(),
    pollMs: POLL_MS,
    screenName: tv?.name ?? '',
    // shortcut: no weekly schedule and no overnight display schedule yet — those live on the
    // screen record the server keeps, and a standalone screen has no panel for them until the
    // Screens page learns its one-screen form. Upgrade with that page.
  } as PiStateWire;
}

/**
 * A screen that runs on its own.
 *
 * It never calls anybody. The whole of its inbound surface is the panel below, on the masjid's
 * network, and the whole of its outbound traffic is whatever the admin points a camera at. Until
 * somebody claims it, the television carries the code that lets them.
 */
async function runStandalone(screen: Screen | null, cfg: AgentConfig, facts: DeviceFacts): Promise<never> {
  // `conf` not `live`: in this file `live` is the screen's live STATE, and runAdopted uses it
  // that way. Two meanings for one name in one function is how the wrong one gets passed.
  let conf = cfg;
  const store = new Store();

  /**
   * A code only while there is somebody to use it.
   *
   * Minted once and kept — a code that changed on every boot is one nobody can write down, on a
   * device whose normal shutdown is somebody switching the socket off. But ONLY while this
   * screen is unclaimed: it used to mint on every restart regardless, so a screen set up months
   * ago carried a fresh, live setup code on disk that nothing would ever show or spend. Nothing
   * could be done with it today — the claim route refuses outright once an account exists — and
   * that is exactly the kind of secret that becomes a way in the day somebody reorders those two
   * checks.
   */
  if (!conf.setupCode && !store.db.admin) {
    conf = { ...conf, setupCode: newSetupCode() };
    saveConfig(conf);
    log('minted a setup code for this screen');
  }
  /**
   * One screen, and it is this device.
   *
   * Seeded so the panel's Screens page has the same card the server would show, rather than an
   * empty state offering to add a screen on a machine that plainly has one attached. It is also
   * what `localState` reads to decide what to draw, so the admin's choice in the panel and the
   * picture on the television are the same record rather than two guesses at it.
   */
  if (store.db.tvs.length === 0) {
    store.update((db) => {
      db.tvs = [
        {
          id: rid('tv'),
          name: 'This screen',
          kind: 'pi',
          defaultContent: { kind: 'timetable', id: db.timetables[0]?.id ?? '' },
          createdAt: new Date().toISOString(),
        },
      ];
    });
    log('seeded this screen');
  }
  /**
   * How this screen is attached, for the panel's Wi-Fi section.
   *
   * Cached and refreshed off the request, never during one. `netFacts()` and `scanNetworks()` are
   * `nmcli` subprocesses and the panel polls state every couple of seconds; doing this inline
   * would put two process spawns in front of every poll, in the same process that draws the
   * television at 1 fps. So a read returns the last good answer immediately and starts a refresh
   * only if the answer is stale and one is not already running.
   *
   * The Wi-Fi verdict is different and is read on EVERY call: root's answer is written once and
   * deleted when read, so a cache would either lose it or show it for ever.
   */
  let netAt = 0;
  let netBusy = false;
  let netCache: { net?: NetFacts; networks?: AccessPoint[] } = {};
  const NET_MAX_AGE_MS = 15_000;
  const refreshNet = (): void => {
    if (netBusy || Date.now() - netAt < NET_MAX_AGE_MS) return;
    netBusy = true;
    void (async () => {
      try {
        const net = await netFacts();
        netCache = { net, networks: net.hasWifi ? await scanNetworks() : [] };
        netAt = Date.now();
      } catch (e) {
        // Keep the last good answer. A failed scan is not news worth replacing facts with.
        log('could not read the network state:', (e as Error).message);
      } finally {
        netBusy = false;
      }
    })();
  };

  // Warmed before anything asks, so the first poll after a sign-in has a real answer rather
  // than the empty cache — which the panel would otherwise have to draw as something.
  refreshNet();

  /**
   * How enrolment is going, once somebody has pointed this screen at a display server.
   *
   * Read by the panel and written by the loop below. A plain object for the same reason `Live` is
   * one: two readers, neither of which yields in the middle of touching it.
   */
  const linkStatus = { code: '', connected: false, status: '' };

  const panel = createPiPanel({
    store,
    device: {
      id: store.db.tvs[0]?.id ?? 'this-screen',
      read: () => {
        refreshNet();
        return { ...netCache, wifiResult: readWifiResult() };
      },
      // The same writer the agent uses for a command a display server queued. Only the asker
      // differs; what lands in the spool is identical.
      wifi: (action, w) => requestWifi(rid('wifi'), action, w),
    },
    // Read fresh each time rather than closing over `live`: the panel SPENDS the code, and a
    // stale copy here would keep accepting one that has already been used.
    readConfig: () => loadConfig(),
    writeConfig: (next) => saveConfig(next),
    linkState: () => linkStatus,
    webDir: WEB_DIR,
    /**
     * This screen's own status.
     *
     * On the server this comes from MediaMTX reporting a reader on the path. Here the question
     * answers itself: the process computing it is the process drawing the picture, so if
     * anything is asking, the screen is on. Reporting an empty list made the panel badge the
     * very screen the admin was looking at as OFFLINE.
     *
     * `contentStale` carries the clock warning through to the panel, so the badge agrees with
     * what the television is saying rather than contradicting it.
     */
    screens: {
      getStatuses: () => {
        const tv = store.db.tvs[0];
        if (!tv) return [];
        const override = tv.override && (tv.override.until === null || tv.override.until > Date.now()) ? tv.override : null;
        return [
          {
            tvId: tv.id,
            effective: override ? override.content : tv.defaultContent,
            source: override ? ('override' as const) : ('default' as const),
            streamReady: true,
            ...(clockSuspect() ? { contentStale: true, staleReason: 'clock' as const } : {}),
          },
        ];
      },
    },
  });

  const server = http.createServer((req, res) => void panel(req, res));
  server.on('error', (e) => log('panel listener:', e.message));
  server.listen(PANEL_PORT, () => log(`panel listening on port ${PANEL_PORT}`));

  const live = new Live('');
  const player = new VideoPlayer(FB_DEVICE, log);
  let cameraDownSince = 0;
  // Named explicitly rather than left to resvg's system-font search — see FONTS.
  live.fontFiles = FONTS.fontFiles ?? [];
  const arabic = (FONTS.fontFiles ?? []).some((f) => /arabic|amiri/i.test(f));
  log(`fonts: ${live.fontFiles.length} file(s)${arabic ? '' : ' — NO ARABIC FACE; Arabic and Urdu text will draw as empty boxes'}`);

  const cadence = new RenderCadence();

  for (;;) {
    /**
     * Has somebody pointed this screen at a display server?
     *
     * Read off DISK every pass rather than from the config this function was started with, because
     * the panel this same process is serving can change it at any moment — and that is the whole
     * mechanism: the panel writes the file, this notices. Nothing restarts anything, so a mistyped
     * address can be corrected in the same panel a second later, which is the one thing the
     * alternative (restart straight into the enrolment loop) could not offer. The admin would have
     * been left looking at a read-only page reporting a server that does not exist, with no way
     * back short of a keyboard and a monitor.
     */
    const disk = loadConfig();
    if (disk?.server) {
      // Handed a token as well — by a display server that signed in here and created the screen
      // itself. There is nothing left to wait for, and nothing in this function can draw an
      // adopted screen, so end the process and let systemd start it in the adopted mode five
      // seconds later. The panel is replaced by the read-only one at that point, which is correct:
      // the server owns this screen now.
      if (disk.token) {
        log(`adopted by ${disk.server}; restarting as a managed screen`);
        screen?.show(messageSvg('Joining a display server', 'This screen is being set up — it will be ready in a moment.'));
        await sleep(1_000);
        process.exit(0);
      }

      // Only an address so far: enrol, and put the code on the television AND in the panel. The
      // server's own admin has to approve it there, which is the point — holding this screen's
      // password should not be enough to insert a screen into somebody else's masjid.
      //
      // One attempt per pass, not a loop: the config is re-read at the top of this one, so a
      // mistyped address can be corrected — or withdrawn — in the panel this process is still
      // serving. `waitForAdoption` blocks on the same attempt for ever, which is right for a
      // screen the installer built and has no panel of its own to be rescued from.
      const pass = await enrolOnce(disk, facts, linkStatus.code);
      Object.assign(linkStatus, { code: pass.code, connected: pass.connected, status: pass.status });
      if (pass.token) {
        log('adopted; saving credentials');
        saveConfig({ ...disk, token: pass.token });
        continue; // picked up by the branch above on the next pass
      }

      screen?.show(
        pairingSvg({
          code: linkStatus.code,
          ip: facts.ip,
          hostname: facts.hostname,
          server: disk.server,
          status: linkStatus.status,
          connected: linkStatus.connected,
          agentVersion: AGENT_VERSION,
        }),
      );
      await sleep(linkStatus.connected ? POLL_MS : Math.min(POLL_MS * 3, 15_000));
      continue;
    }
    // Pointed at nothing — or pointed back at nothing after a mistyped address was cleared. Drop
    // whatever the last enrolment attempt said so the panel does not keep reporting it.
    if (linkStatus.code || linkStatus.status) {
      linkStatus.code = '';
      linkStatus.connected = false;
      linkStatus.status = '';
    }

    const code = disk?.setupCode ?? '';
    if (!store.db.admin && code) {
      screen?.show(
        pairingSvg({
          code: formatSetupCode(code),
          ip: facts.ip,
          hostname: facts.hostname,
          server: '',
          status: `Waiting to be set up — open http://${facts.ip || 'this screen'} on this network`,
          connected: !!facts.ip,
          agentVersion: AGENT_VERSION,
          standalone: true,
        }),
      );
      await sleep(2_000);
      continue;
    }

    // A clock that cannot be right must never be presented as the time. A Pi has no
    // battery-backed clock, so after a power cut it believes whatever was last written to the
    // card until NTP corrects it — and prayer times computed against that are wrong in the one
    // way nobody checks.
    if (clockSuspect()) {
      screen?.show(messageSvg('Clock is wrong', 'This screen is waiting for the correct time before showing prayer times.'));
      await sleep(5_000);
      continue;
    }

    localState(store, live);
    applyDisplaySchedule(live);
    /**
     * The camera is decided BEFORE "is there a timetable", and the order is the bug this comment
     * exists for: a screen showing a camera HAS no timetable, so checking for one first sent
     * every camera to the "Nothing to show yet" card and the player was never reached. From the
     * hall that is indistinguishable from a camera that will not connect. The adopted loop has
     * always been in this order.
     */

    /**
     * A camera and the timetable are the same pixels, so exactly one of them may be running:
     * ffmpeg draws straight to the framebuffer, and anything drawn here would flicker over it.
     *
     * The same handling the adopted path uses, including the gap. Some cameras tear the session
     * down on their own schedule — a UniFi one measured on real hardware ends it cleanly about
     * every seventy seconds — and painting "Camera unavailable" into that gap put a warning on
     * the wall every minute on a camera that was working. The framebuffer still holds the last
     * frame ffmpeg wrote, so drawing nothing leaves the picture up and the reconnect is invisible.
     */
    const stream = live.state?.stream;
    if (stream && screen) {
      player.play(stream.url, screen.geo);
      const st = player.status();
      if (st.playing) {
        cameraDownSince = 0;
        await sleep(2_000);
        continue;
      }
      if (!cameraDownSince) cameraDownSince = Date.now();
      if (Date.now() - cameraDownSince < CAMERA_GRACE_MS) {
        await sleep(400);
        continue;
      }
      // Past the grace period it is not a hiccup. Saying which camera and what went wrong turns
      // "the screen is black" into something whoever is standing there can act on.
      screen.show(
        messageSvg('Camera unavailable', st.lastError ? st.lastError.slice(0, 120) : 'Trying to reach the camera'),
        live.fontFiles,
        live.state?.fontFamilies,
      );
      await sleep(3_000);
      continue;
    }
    player.stop();

    if (!live.state?.timetable) {
      // Not black. A screen with nothing configured and a screen that is broken look identical
      // in the dark, and only one of them is somebody's job to fix.
      screen?.show(
        messageSvg('Nothing to show yet', `Add a timetable at http://${facts.ip || 'this screen'}`),
        live.fontFiles,
        live.state?.fontFamilies,
      );
      await sleep(2_000);
      continue;
    }

    // Blur the wallpaper once per wallpaper, not once per frame. Measured on a Pi 4: the frost
    // costs about 3.8 seconds of every frame, which turns a clock that ticks into one that
    // lurches. See RenderOpts.bgPreblurred.
    const bg = live.state.assets.background;
    const { width: fw, height: fh } = dimsFor(live.state.timetable.orientation, live.state.timetable.quality);
    if (bg && (live.frostedSrc !== bg || live.frostedDims !== `${fw}x${fh}`)) frostOnce(live, bg, fw, fh);

    const ms = drawFrame(screen, live);
    if (ms !== null) cadence.record(ms);
    await sleep(cadence.intervalMs());
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
    log(`sysfs: ${describeFramebuffer()}`);
    log(`ioctl: ${describeFbset()}`);
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

  // The failure hook is the point of passing anything here: a background that will not download
  // used to be completely silent, so the only symptom was a screen showing the themed scene while
  // the dashboard insisted a wallpaper was set.
  const cache = new AssetCache(undefined, undefined, (m) => log('asset:', m));

  for (;;) {
    // No server means this screen is its own: it serves a panel, is configured on the LAN, and
    // none of the adopted machinery applies to it. It never returns — a screen pointed at a server
    // from its own panel ends the process once it has a token, and systemd starts it again here.
    if (!live.server) {
      log('no display server configured; running standalone');
      await runStandalone(screen, live, facts);
    }

    if (!live.token) {
      const token = await waitForAdoption(screen, live, facts);
      live = { ...live, token };
      saveConfig(live);
    }
    await runAdopted(screen, live, cache, facts);

    /**
     * Forgotten by the server. Drop the token and keep the identity, so re-adopting this screen
     * does not grow a second row for it — and decide where it goes back TO.
     *
     * Those are two different places, and TWO facts decide between them — one is not enough.
     *
     * The INSTALLER writes the address into root's own trust.env, so a screen built that way
     * belongs to that server and goes back to showing a pairing code for it, exactly as it always
     * has. A screen pointed at a server from its OWN panel has nothing in trust.env, and has a
     * password, timetables and a panel sitting untouched underneath — so forgetting it should
     * return it to those rather than leave it asking to rejoin a dashboard it was just removed
     * from. That second case would otherwise loop in `waitForAdoption`, which serves no panel at
     * all, and the only way back would be a keyboard plugged into the Pi.
     *
     * The LOCAL ACCOUNT is the second fact, and it is what stops this being wrong for a real
     * screen in the field: a Pi installed before trust.env existed has none either, and it can
     * still reach this version of the agent because the old updater replaces agent.js without
     * rewriting anything beside it. Such a screen has no password and no standalone life, so
     * sending it there would strand it on a setup code nobody asked for. Only a screen that can
     * actually be signed in to goes back to being its own.
     */
    const ownPanel = !rootHasTrustedServer() && !!new Store().db.admin;
    if (ownPanel) log('forgotten, and this screen has a panel of its own to go back to; going standalone');
    live = {
      server: ownPanel ? '' : live.server,
      deviceId: live.deviceId,
      deviceSecret: live.deviceSecret,
    };
    saveConfig(live);
  }
}

/**
 * Run one terminal session and exit — the agent's second entry point.
 *
 * Reached only as `agent.js --shell-session <file>`, and only ever from the control spool's
 * `shell-session` arm, which starts it as root in a transient unit. The file holds four lines: the
 * session id, the one-time secret, and the terminal's rows and columns. Root has already moved it
 * somewhere the agent cannot reach and checked its shape; this reads it, deletes it, and dials out.
 *
 * Deliberately the same binary as the agent. The socket handling, the TLS trust, the config and the
 * pty are all here already, and a second program that had to be kept in step with this one is a
 * second program that would quietly stop being.
 */
async function runShellSessionOnly(file: string): Promise<void> {
  let lines: string[];
  try {
    lines = fs.readFileSync(file, 'utf8').split(String.fromCharCode(10));
  } catch (e) {
    log('could not read the terminal session details:', (e as Error).message);
    process.exit(1);
  }
  // Deleted before the session opens, not after: it holds a single-use secret, and a session that
  // runs for an hour must not leave that on disk for the hour.
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone, which is fine */
  }
  const [id = '', secret = '', rowsRaw = '', colsRaw = '', serverRaw = ''] = lines;
  // Re-validated here as well as by root. Same reasoning as everywhere else in this app: the check
  // that matters is the one made by the thing about to act on the value.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id.trim()) || !/^[A-Za-z0-9_-]{8,128}$/.test(secret.trim())) {
    log('refusing a terminal session whose id or secret is not a plain token');
    process.exit(1);
  }
  /**
   * The origin comes from the SPOOL FILE — root's own copy, out of trust.env — and never from
   * config.json.
   *
   * This is the fifth line, and it is a privilege boundary rather than a convenience. config.json
   * belongs to the agent: the installer chowns $CONFDIR to the service account and the unit grants
   * it ReadWritePaths, because the agent rewrites the file when the screen is adopted. So reading
   * `server` from there meant a compromised UNPRIVILEGED agent could point it anywhere, ask the
   * spool for a terminal, and be handed a ROOT pty on a socket of its choosing — the exact
   * escalation the closed verb set exists to prevent, straight through the one verb that grants
   * root. The token may still come from config; it is only this device's own credential. The
   * ORIGIN may not.
   */
  const server = serverRaw.trim().replace(/\/+$/, '');
  if (!SERVER_ORIGIN_RE.test(server)) {
    log('refusing a terminal session with no trusted server address');
    process.exit(1);
  }
  const cfg = loadConfig();
  if (!cfg?.token) {
    log('cannot open a terminal: this screen is not adopted');
    process.exit(1);
  }
  runShellSession({ ...cfg, server }, {
    id: id.trim(),
    secret: secret.trim(),
    rows: Number(rowsRaw) || 24,
    cols: Number(colsRaw) || 80,
  });
  // runShellSession tears everything down through its own handlers and this process has nothing
  // else to do, so the socket closing is what ends us. The backstop inside it (SHELL_SESSION_MAX_MS)
  // is what stops a wedged socket leaving a root bash on the device for the rest of the week.
}

const shellArg = process.argv.indexOf('--shell-session');
if (shellArg >= 0) {
  const file = process.argv[shellArg + 1];
  if (!file) {
    log('--shell-session needs the path to a session file');
    process.exit(1);
  }
  void runShellSessionOnly(file);
} else {
  main().catch((e: Error) => {
  // Last resort. systemd restarts us; the journal gets the reason.
    log('fatal:', e.message);
    process.exit(1);
  });
}
