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
import { pairingSvg, messageSvg } from './pairing';
import { fitMode, blitCentered, rotateRgba, overscanBox } from './raster';
import { deviceFacts, type DeviceFacts } from './device';
import { netFacts, scanNetworks } from './network';
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
  /** How the television is mounted, and how much of the edge it crops. Applied to the frame, so a
   *  change takes effect on the next one — see raster.ts. */
  displayTransform?: { rotate?: number; overscan?: number };
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
      | 'set-hostname'
      | 'os-update'
      | 'screenshot'
      | 'set-video-mode'
      | 'keep-video-mode';
    /** Only ever present for 'wifi-join'. The password is used once and never logged. */
    wifi?: { ssid: string; psk: string };
    /** Only ever present for 'shell'. One line, run as THIS user — see runShell. */
    shell?: string;
    /** Only ever present for 'shell-session'. Where to dial in, and the one-time secret. */
    shellSession?: { id: string; secret: string; rows: number; cols: number };
    /** Only ever present for 'set-timezone' / 'set-hostname'. Root validates it again. */
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
    /**
     * How this television is mounted and how much of the picture it eats.
     *
     * Mutable, and set from the state poll rather than passed in: the framebuffer is opened once at
     * startup and these are per-screen settings an admin can change while it is running. Both are
     * applied to the FRAME, not to the boot config — see raster.ts for why that is not a shortcut.
     */
    public transform: { rotate: 0 | 90 | 180 | 270; overscan: number } = { rotate: 0, overscan: 0 },
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

      // The box the picture is allowed to fill, and which way round it is. For a quarter turn the
      // target is the framebuffer's dimensions SWAPPED, because the frame is rasterised the way it
      // will be seen and then turned into the framebuffer's shape.
      const box = overscanBox(this.geo.width, this.geo.height, this.transform.overscan);
      const quarter = this.transform.rotate === 90 || this.transform.rotate === 270;
      const fitW = quarter ? box.height : box.width;
      const fitH = quarter ? box.width : box.height;

      const t0 = process.hrtime.bigint();
      const img = new Resvg(svg, {
        fitTo: fitMode(srcW, srcH, fitW, fitH),
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
          : { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' },
      }).render();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;

      // Rotated after rasterising and before blitting: resvg has no concept of the framebuffer's
      // orientation, and blitCentered's letterboxing is what turns "a portrait picture" into "a
      // portrait picture centred in a landscape framebuffer with black down both sides" — which is
      // exactly what a television turned on its side needs to be sent.
      const rot = rotateRgba(img.pixels, img.width, img.height, this.transform.rotate);
      const frame = blitCentered(rot.pixels, rot.width, rot.height, this.geo.width, this.geo.height);
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

  if (cmd.action === 'wifi-on' || cmd.action === 'wifi-off' || cmd.action === 'wifi-forget' || cmd.action === 'wifi-rescan') {
    requestPrivileged(cmd.id, cmd.action, `asked the system to ${cmd.action.replace('-', ' ')}`);
    return;
  }

  if (cmd.action === 'wifi-join') {
    // The details CANNOT travel in the spool file. The dispatcher reads a verb as
    // `head -c 32 | tr -dc 'a-z-'`, which deletes digits, spaces, punctuation and capitals — a
    // network called "Masjid 5G" would arrive as "masjidg". That filter's narrowness is what keeps
    // the verb set closed, so it stays exactly as it is and the payload goes beside it.
    //
    // Both fields are base64 so no network name or password can introduce a newline, a quote or a
    // leading dash into the file's shape. Root decodes and validates them itself — this side is a
    // courier, not the check.
    if (!cmd.wifi?.ssid) {
      log('a Wi-Fi join arrived with no network name; ignoring it');
      return;
    }
    try {
      const dir = '/var/lib/openmasjid-screen';
      const b64 = (v: string): string => Buffer.from(v, 'utf8').toString('base64');
      const NL = String.fromCharCode(10);
      const body = b64(cmd.wifi.ssid) + NL + b64(cmd.wifi.psk ?? '') + NL;
      // Written and renamed BEFORE the verb, so the dispatcher can never wake on a join whose
      // details have not landed yet. Mode 0600: it holds the masjid's Wi-Fi password.
      const tmp = `${dir}/.wifi-request`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, `${dir}/wifi-request`);
    } catch (e) {
      log('could not leave the Wi-Fi details for the system:', (e as Error).message);
      return;
    }
    // The name is fine to log — it is on the air for anyone to see. The password never is.
    requestPrivileged(cmd.id, 'wifi-join', `asked the system to join "${cmd.wifi.ssid}"`);
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

  if (cmd.action === 'os-update') {
    requestPrivileged(cmd.id, 'os-update', 'asked the system to install operating-system updates');
    return;
  }

  // Both of these carry a short string, which cannot travel in the spool file: the dispatcher reads
  // a verb as `head -c 32 | tr -dc 'a-z-'`, which would turn "America/New_York" into
  // "americanewyork". Same shape as a Wi-Fi join — the payload goes beside the verb, and root
  // validates it itself rather than trusting this side.
  if (cmd.action === 'set-timezone' || cmd.action === 'set-hostname') {
    if (!cmd.text) {
      log(`a ${cmd.action} arrived with nothing to set; ignoring it`);
      return;
    }
    const file = cmd.action === 'set-timezone' ? 'tz-request' : 'hostname-request';
    try {
      const dir = '/var/lib/openmasjid-screen';
      // Written and renamed BEFORE the verb, so the dispatcher can never wake on a request whose
      // payload has not landed.
      fs.writeFileSync(`${dir}/.${file}`, `${cmd.text}
`, { mode: 0o600 });
      fs.renameSync(`${dir}/.${file}`, `${dir}/${file}`);
    } catch (e) {
      log(`could not leave the ${cmd.action} details for the system:`, (e as Error).message);
      return;
    }
    requestPrivileged(cmd.id, cmd.action, `asked the system to set ${cmd.action === 'set-timezone' ? 'the timezone' : 'the hostname'} to "${cmd.text}"`);
    live.checkInNow = true;
    return;
  }

  // No privilege at all: the agent is already in the video group, because drawing is its job.
  if (cmd.action === 'screenshot') {
    log('taking a screenshot for the dashboard');
    await sendScreenshot(cfg);
    return;
  }

  if (cmd.action === 'shell-session') {
    if (!cmd.shellSession?.id || !cmd.shellSession.secret) {
      log('a terminal session arrived with nothing to dial into; ignoring it');
      return;
    }
    // Not awaited: the session lives for as long as somebody is typing, and the poll loop has a
    // screen to keep drawing. Everything it owns is torn down by its own handlers.
    runShellSession(cfg, cmd.shellSession);
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
async function sendScreenshot(cfg: AgentConfig): Promise<void> {
  const png = framebufferPng();
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
function applyDisplaySchedule(live: Live): void {
  const sch = live.state?.displaySchedule;
  const reb = live.state?.rebootSchedule;
  if (!sch?.enabled && !reb?.enabled) return;
  const now = live.serverTime();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
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
 * ## What it is allowed to be
 *
 * The same account and the same unit sandbox as the one-shot console: NoNewPrivileges, no write
 * access to /opt, no capability to reboot the board, no sudo. The root control spool is not involved
 * and must never be — its closed verb set is what makes root's half of this device simple enough to
 * reason about, and "run this string" would end that for every verb at once.
 *
 * Nothing here logs a byte of the session. Not the keystrokes, not the output, not a sample: a
 * terminal transcript is the likeliest thing in this whole app to contain a password.
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
    try {
      child = spawn('script', ['-qfc', `stty rows ${rows} cols ${cols}; exec /bin/bash -i`, '/dev/null'], {
        cwd: shellCwd(),
        env: {
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          HOME: '/var/lib/openmasjid-screen',
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

/**
 * Leave a request for the root side to carry out.
 *
 * The agent cannot do either of these itself, deliberately: it cannot write /opt, so it cannot
 * rewrite its own code, and it holds no capability that would let it reboot the machine. What it
 * CAN do is write one file into a spool directory that a root-owned systemd path unit is watching.
 *
 * Written under a dot-prefixed temporary name and renamed into place, so the watcher never wakes on
 * a half-written file — and the verb is one of a fixed set the dispatcher matches against, never
 * anything derived from the network.
 */
type PrivilegedVerb =
  // 'screenshot' is deliberately absent: the agent reads the framebuffer itself, because it is
  // already in the video group. Nothing that can be done unprivileged belongs in this list.
  | 'display-off'
  | 'display-on'
  | 'set-timezone'
  | 'set-hostname'
  | 'os-update'
  | 'set-video-mode'
  | 'keep-video-mode'
  | 'update'
  | 'reboot'
  | 'reinstall'
  | 'logs'
  | 'wifi-on'
  | 'wifi-off'
  | 'wifi-join'
  | 'wifi-forget'
  | 'wifi-rescan';

function requestPrivileged(id: string, verb: PrivilegedVerb, said: string): void {
  try {
    const dir = '/var/lib/openmasjid-screen/control';
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${dir}/.${id}`;
    fs.writeFileSync(tmp, `${verb}\n`);
    fs.renameSync(tmp, `${dir}/${id}`);
    log(said);
  } catch (e) {
    log(`could not ask for "${verb}":`, (e as Error).message);
  }
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

/**
 * What root said about the last Wi-Fi join, if it has said anything since we last looked.
 *
 * Read-and-delete: the result is a one-off answer to one request, and leaving it would have the
 * panel reporting an old failure next to a working connection. Root writes it; we only ever read
 * it, so a corrupt or half-written file is treated as no answer rather than as a problem.
 */
function readWifiResult(): { ok: boolean | null; detail: string } | undefined {
  const p = '/var/lib/openmasjid-screen/wifi-result';
  try {
    if (!fs.existsSync(p)) return undefined;
    const [verdict = '', detail = ''] = fs.readFileSync(p, 'utf8').split(String.fromCharCode(10));
    fs.unlinkSync(p);
    // 'unverified' is its own answer and must not read as success: it means the join worked but
    // nothing proved the display server could still be reached afterwards.
    const ok = verdict.trim() === 'yes' ? true : verdict.trim() === 'no' ? false : null;
    return { ok, detail: detail.trim().slice(0, 200) };
  } catch {
    return undefined;
  }
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

  return screen.show(svg, live.fontFiles, live.state?.fontFamilies);
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
      // Re-read every poll rather than only on change: it costs nothing, and it means a screen that
      // was mounted sideways picks the setting up on its next poll with no restart.
      if (screen) {
        const r = Number(st.displayTransform?.rotate);
        screen.transform = {
          rotate: r === 90 || r === 180 || r === 270 ? r : 0,
          overscan: Number(st.displayTransform?.overscan) || 0,
        };
      }
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
        player.play(stream.url, screen.geo, screen.transform.rotate);
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
