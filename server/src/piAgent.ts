// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * piAgent.ts — pairing a Raspberry Pi that drives a screen.
 *
 * ## The shape of it
 *
 * A browser screen (`webScreen.ts`) is a page someone opens. This is a *device*: a Pi running
 * our agent, installed with one command, which then behaves like a screen the masjid owns.
 * The difference that matters is what happens when the screen shows a camera. A browser has to
 * be fed video by the server; the Pi is on the same LAN as the camera and can pull the RTSP
 * itself. So the server hands it an ADDRESS instead of a stream, and never touches the video —
 * which is what lets the display server run in the cloud at all.
 *
 * ## Why the device calls us
 *
 * "Read the IP off the screen, type it into the dashboard" is how the setup reads, and it is
 * how an installer experiences it. It is not how the connection can work: the Pi is behind the
 * masjid's NAT on an address DHCP may move, and a cloud server can never reach 192.168.x.x. So
 * the agent polls outward — it learned the server's address from its own install command — and
 * the thing the admin types is a short pairing CODE.
 *
 * ## Three states, and the token is what separates them
 *
 *  - **pending**: the device has announced itself and shows a code. It has NO token, so it can
 *    learn nothing about this masjid beyond "you are not adopted yet".
 *  - **adopted**: an admin matched the code. A token is issued, and only then does the device
 *    get a screen's content.
 *  - **forgotten**: the token is dropped and the device falls back to pending on its next call.
 *
 * Enrolment is necessarily unauthenticated — a fresh Pi has no credentials — so it is bounded
 * in every direction: rate-limited upstream, capped in number, and it can only ever create a
 * pending row carrying self-reported display text.
 */
import crypto from 'node:crypto';
import type { DB, DeviceNet, PiDevice, Timetable, Tv } from './types';
import { resolveTv } from './scheduler';

/** How many un-adopted devices may be remembered at once.
 *
 *  Enrolment is unauthenticated, so without a cap anyone who can reach the port could grow the
 *  store without bound. A masjid adopts a Pi within minutes of plugging it in; twenty pending
 *  at once is already generous, and the oldest is evicted rather than the newest refused —
 *  otherwise a flood would lock out the very device someone is standing in front of. */
export const MAX_PENDING_DEVICES = 20;

/** A pending device forgotten after this long without checking in. Long enough to survive
 *  someone plugging the Pi in and going to find a laptop. */
export const PENDING_TTL_MS = 24 * 60 * 60_000;

/** Missed check-ins before a device counts as offline — the `streamReady` equivalent, matching
 *  the browser screens' six missed polls. */
export const PI_SEEN_TIMEOUT_MS = 30_000;

/** How often the agent asks for its state. Same as a browser screen: fast enough that changing
 *  what a screen shows feels immediate, small enough to be free. */
export const PI_POLL_MS = 5_000;

/**
 * The pairing-code alphabet: no 0/O/1/I/5/S, because this is read off a television from across
 * a room and then typed. A code that can be misread is a support call.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';

export function makePairingCode(): string {
  const b = crypto.randomBytes(6);
  return Array.from(b, (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
}

/** The agent's credential once adopted. 16 bytes, like a screen token — it is the whole access
 *  control on an endpoint no human will ever authenticate. */
export function makeDeviceToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/** Self-reported text from an unauthenticated device, reduced to something safe to show an
 *  admin: control characters folded to spaces (written as ESCAPES — literal control bytes in
 *  source are invisible and get reformatted away), then trimmed and clamped. */
/**
 * Hash of the device's secret.
 *
 * A plain SHA-256 rather than scrypt, deliberately: this is not a human-chosen password but 16
 * random bytes minted by the agent, so there is no dictionary to slow an attacker down and
 * nothing for a work factor to buy. What matters is that the stored value is not itself usable
 * and that the comparison is constant time.
 */
function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

function secretMatches(presented: string, storedHash: string | undefined): boolean {
  if (!presented || !storedHash) return false;
  const a = Buffer.from(hashSecret(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').trim().slice(0, max) : '';

export interface EnrolInput {
  /** the device's own persistent id, so a reboot does not create a second pending row */
  deviceId?: unknown;
  /**
   * A high-entropy secret the agent mints at install and keeps. It is what makes the device id
   * safe to accept from a client: the id says "which row", the secret says "and I am really
   * it". Without this pair, an unauthenticated enrol could hand someone else's token out.
   */
  deviceSecret?: unknown;
  hostname?: unknown;
  ip?: unknown;
  model?: unknown;
  agentVersion?: unknown;
  /** the agent's own recent log lines, for the panel to show */
  recentLog?: unknown;
  /** how the device is attached to the network, for the panel to draw an icon from */
  net?: unknown;
  /** the Wi-Fi networks the device can currently see */
  networks?: unknown;
  /** load, memory and temperature, for the dashboard readout */
  stats?: unknown;
  /** what root reported about the last join it was asked to make */
  wifiResult?: unknown;
}

export interface EnrolResult {
  /** what the agent should show on screen while it waits */
  code: string;
  deviceId: string;
  adopted: boolean;
  /**
   * The device's credential, returned ONLY once it has been adopted AND it proved it is the
   * same device that first enrolled.
   *
   * This is the whole reason `deviceSecret` exists. The agent has to learn its token somehow,
   * and enrolment is the only channel it has — but enrolment is unauthenticated, so handing
   * the token to anyone who presents a device id would make the id a credential, and the id is
   * not secret. It is printed in logs, shown in the panel, and guessable if someone picks it.
   */
  token?: string;
  pollMs: number;
}

/**
 * A device announcing itself.
 *
 * Everything here is self-reported and unauthenticated, so it is treated as display text and
 * nothing else — stripped of control characters and clamped. The one thing that matters is
 * that a device which reboots or loses power comes back as the SAME pending row with the SAME
 * code, rather than papering the dashboard with duplicates of one screen.
 */
export function enrolDevice(db: DB, input: EnrolInput, nowMs: number): { device: PiDevice; result: EnrolResult } {
  const now = new Date(nowMs).toISOString();
  const devices = (db.piDevices ??= []);

  const claimedId = str(input.deviceId, 64);
  const secret = str(input.deviceSecret, 200);
  const existing = claimedId ? devices.find((d) => d.id === claimedId) : undefined;

  // An id that exists but cannot be proved is treated as an UNKNOWN device, not as an error.
  // Refusing would confirm the id is real; enrolling it fresh tells an attacker nothing and
  // leaves the genuine device's row untouched.
  let device = existing && secretMatches(secret, existing.secretHash) ? existing : undefined;
  const impostor = !!existing && !device;

  if (device) {
    // A known device: refresh what it says about itself, and its liveness.
    device.hostname = str(input.hostname, 64) || device.hostname;
    device.ip = str(input.ip, 64) || device.ip;
    device.model = str(input.model, 64) || device.model;
    device.agentVersion = str(input.agentVersion, 32) || device.agentVersion;
    device.lastSeenAt = now;
  } else {
    // A device id is accepted from the agent so a reboot is not a new device, but it is only
    // ever a LOOKUP key — it grants nothing, because a pending device has no token.
    device = {
      // A claimed id is only reused when it was not already taken by someone who can prove it.
      id: !claimedId || impostor ? `pi_${crypto.randomBytes(6).toString('hex')}` : claimedId,
      secretHash: secret ? hashSecret(secret) : undefined,
      code: makePairingCode(),
      hostname: str(input.hostname, 64) || 'raspberrypi',
      ip: str(input.ip, 64),
      model: str(input.model, 64),
      agentVersion: str(input.agentVersion, 32),
      firstSeenAt: now,
      lastSeenAt: now,
    };
    devices.push(device);
    prunePending(db, nowMs);
  }

  // The token is handed back only to a device that proved itself. A device that enrolled
  // before secrets existed, or one that sent none, stays pending as far as it can tell — the
  // fix is to re-run the installer, which mints one.
  const proved = !!device.secretHash && secretMatches(secret, device.secretHash);
  return {
    device,
    result: {
      code: device.code,
      deviceId: device.id,
      adopted: !!device.token && proved,
      ...(device.token && proved ? { token: device.token } : {}),
      pollMs: PI_POLL_MS,
    },
  };
}

/** Forget stale pending devices, then the oldest if still over the cap. Adopted devices are
 *  never touched — they belong to the masjid, not to this bound. */
export function prunePending(db: DB, nowMs: number): void {
  const devices = db.piDevices ?? [];
  const kept = devices.filter((d) => d.token || nowMs - Date.parse(d.lastSeenAt || '') < PENDING_TTL_MS);
  const pending = kept.filter((d) => !d.token).sort((a, b) => Date.parse(a.lastSeenAt) - Date.parse(b.lastSeenAt));
  const drop = new Set(pending.slice(0, Math.max(0, pending.length - MAX_PENDING_DEVICES)).map((d) => d.id));
  db.piDevices = kept.filter((d) => !drop.has(d.id));
}

/** Look a device up by the token it presents. Adopted devices only — a pending one has no
 *  token, so there is nothing to match and nothing it can reach. */
export function findDeviceByToken(db: DB, token: string): PiDevice | null {
  if (!token) return null;
  return (db.piDevices ?? []).find((d) => d.token === token) ?? null;
}

/** Match a code an admin typed. Case- and space-insensitive, because it was read off a screen
 *  and typed by hand. Only pending devices can be matched — a code is spent at adoption. */
export function findPendingByCode(db: DB, code: string): PiDevice | null {
  const want = code.replace(/[\s-]/g, '').toUpperCase();
  if (want.length < 4) return null;
  return (db.piDevices ?? []).find((d) => !d.token && d.code === want) ?? null;
}

export interface PiState {
  content: { kind: 'timetable' | 'source' | 'off'; id?: string };
  source: 'override' | 'schedule' | 'default';
  /** the timetable to render locally, when showing one */
  timetable: Timetable | null;
  assets: { background: string | null; logo: string | null; announcements: string[] };
  /**
   * The font files this server renders with, for the Pi to fetch once and draw with.
   *
   * Not a nicety. resvg picks ONE font per run and does not fall back per glyph, so a Pi
   * drawing with whatever the distro happens to ship renders Arabic as tofu boxes — and the
   * ﷺ ligature in particular, which the vendored face exists specifically to carry. Handing
   * over the same files is what makes a Pi screen and a decoder screen agree.
   */
  fonts: string[];
  /**
   * The family NAMES the server resolves generic families to — not a nicety either.
   *
   * Sending the font files was only half of it. resvg also has to be told which family to use for
   * an unnamed font and for a `serif` request, and the server computes those from what it actually
   * loaded: it has no serif at all, so it maps serif onto the sans it did load, and the sans it
   * loads is DejaVu unless a Noto Sans happens to be present.
   *
   * The agent used to hardcode "Noto Sans". Where the server had settled on DejaVu that named a
   * face which was not loaded, resvg substituted something else, and text laid out with one set of
   * metrics was drawn with another — so it overflowed the boxes around it. Same files, same SVG,
   * different widths.
   */
  fontFamilies: { default: string; serif: string; sansSerif: string };
  bgLight: boolean;
  autoAccent: string | null;
  /**
   * The camera's OWN address, for the agent to open directly.
   *
   * This single field is the reason the whole device exists. A browser screen has to be fed
   * video through the server — which, with the server in the cloud, means the picture crosses
   * the internet twice and arrives as a slideshow. The Pi is on the same network as the
   * camera, so it is handed the address and pulls the stream itself: the server carries none
   * of it, and a cloud-hosted display server becomes possible.
   */
  stream: { url: string; mode: 'direct' | 'normalize' } | null;
  serverNow: number;
  clockSuspect: boolean;
  pollMs: number;
  screenName: string;
  /** What the panel has asked this device to do, if anything. Collected on the device's own poll,
   *  because nothing can connect to it. */
  command: { id: string; action: PiCommandAction } | null;
}

const asset = (base: string, token: string, file: string) =>
  `${base}/pi/${encodeURIComponent(token)}/asset/${encodeURIComponent(file)}`;

const fontUrl = (base: string, token: string, name: string) =>
  `${base}/pi/${encodeURIComponent(token)}/font/${encodeURIComponent(name)}`;

export function piState(
  db: DB,
  device: PiDevice,
  tv: Tv | null,
  nowMs: number,
  opts: {
    basePrefix: string;
    clockSuspect: boolean;
    bgLight: boolean;
    autoAccent: string | null;
    /** basenames of the font files this server draws with, resolved by the caller */
    fontNames: string[];
    /** and the family names it resolves generic families to, so the Pi resolves them identically */
    fontFamilies: { default: string; serif: string; sansSerif: string };
  },
): PiState {
  const off = { kind: 'off' as const };
  if (!tv) {
    return {
      content: off,
      source: 'default',
      timetable: null,
      assets: { background: null, logo: null, announcements: [] },
      fonts: [],
      fontFamilies: opts.fontFamilies,
      bgLight: false,
      autoAccent: null,
      stream: null,
      serverNow: nowMs,
      clockSuspect: opts.clockSuspect,
      pollMs: PI_POLL_MS,
      screenName: '',
      command: pendingCommand(device, nowMs),
    };
  }
  // The SAME resolution every other kind of screen uses, so a schedule rule or a volunteer's
  // override moves a Pi, a browser and a decoder identically.
  const res = resolveTv(tv, db.schedules, new Date(nowMs), db.settings.scheduleTimezone);
  const tt = res.content.kind === 'timetable' ? db.timetables.find((t) => t.id === res.content.id) ?? null : null;
  const src = res.content.kind === 'source' ? db.sources.find((s) => s.id === res.content.id) : undefined;
  const token = device.token ?? '';
  return {
    content: res.content,
    source: res.source,
    timetable: tt,
    assets: {
      background: tt?.backgroundImage ? asset(opts.basePrefix, token, tt.backgroundImage) : null,
      logo: tt?.logoImage ? asset(opts.basePrefix, token, tt.logoImage) : null,
      announcements: (tt?.announcements?.images ?? []).map((f) => asset(opts.basePrefix, token, f)),
    },
    fonts: opts.fontNames.map((n) => fontUrl(opts.basePrefix, token, n)),
    fontFamilies: opts.fontFamilies,
    bgLight: opts.bgLight,
    autoAccent: opts.autoAccent,
    // Only for an ENABLED source. A disabled one is "off", not "try anyway".
    stream: src && src.enabled ? { url: src.url, mode: src.mode } : null,
    serverNow: nowMs,
    clockSuspect: opts.clockSuspect,
    pollMs: PI_POLL_MS,
    screenName: tv.name,
    command: pendingCommand(device, nowMs),
  };
}

// ── liveness, exactly as browser screens do it ───────────────────────────────

const seen = new Map<string, number>();

export function markDeviceSeen(deviceId: string, nowMs: number): void {
  seen.set(deviceId, nowMs);
  if (seen.size > 200) for (const [k, t] of seen) if (nowMs - t > PI_SEEN_TIMEOUT_MS) seen.delete(k);
}

export function deviceOnline(deviceId: string, nowMs: number): boolean {
  const at = seen.get(deviceId);
  return at != null && nowMs - at <= PI_SEEN_TIMEOUT_MS;
}

/**
 * Update the facts an adopted device reports about itself.
 *
 * These arrive at enrolment, and enrolment stops once a device is adopted — so without this the
 * panel would show whatever was true the day the screen was set up, forever. That matters most
 * for the agent version: a Pi that has updated itself overnight would otherwise still be listed
 * as running the build it was installed with, which is exactly the thing an admin looks at this
 * list to find out.
 *
 * Every field is self-reported by an authenticated but unprivileged device, so all of it is
 * sanitised and none of it is trusted for anything but display.
 */
export function updateDeviceFacts(db: DB, deviceId: string, input: EnrolInput, nowMs = Date.now()): void {
  const device = db.piDevices?.find((d) => d.id === deviceId);
  if (!device) return;
  const hostname = str(input.hostname, 64);
  const ip = str(input.ip, 64);
  const model = str(input.model, 80);
  const agentVersion = str(input.agentVersion, 40);
  if (hostname) device.hostname = hostname;
  if (ip) device.ip = ip;
  if (model) device.model = model;
  if (agentVersion) device.agentVersion = agentVersion;

  // Bounded on BOTH axes and stripped of control characters, because every byte here was chosen by
  // an unprivileged device and is going straight into a page. Eighty lines is what the agent keeps;
  // anything longer means something other than our agent is talking to us.
  if (Array.isArray(input.recentLog)) {
    device.recentLog = input.recentLog.slice(-80).map((l) => str(l, 300)).filter(Boolean);
    device.logAt = new Date(nowMs).toISOString();
  }

  const net = normDeviceNet(input.net);
  if (net) device.net = net;

  // Every field re-derived and clamped. A NaN here would end up as a CSS bar width, and a
  // device-chosen number is not a number until it has been checked.
  if (input.stats && typeof input.stats === 'object' && !Array.isArray(input.stats)) {
    const o = input.stats as Record<string, unknown>;
    const num = (v: unknown, max: number): number => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.min(max, Math.round(n * 10) / 10) : 0;
    };
    device.stats = {
      load1: num(o.load1, 999),
      cores: Math.max(1, Math.round(num(o.cores, 256))),
      // Deliberately allowed above 100: a board at 150% of its cores is the interesting case,
      // and clamping it to 100 would hide exactly the state somebody opened this to see.
      cpuPercent: num(o.cpuPercent, 10000),
      memUsedMb: num(o.memUsedMb, 1_000_000),
      memTotalMb: num(o.memTotalMb, 1_000_000),
      memPercent: num(o.memPercent, 100),
      tempC: num(o.tempC, 150),
      uptimeSec: num(o.uptimeSec, 10 ** 9),
    };
    device.statsAt = new Date(nowMs).toISOString();
  }

  // Bounded hard, and every field re-derived. This is a list chosen entirely by an unprivileged
  // device that goes straight into a page somebody clicks on. Thirty is far more networks than any
  // masjid can see and still leaves the list usable.
  if (Array.isArray(input.networks)) {
    device.networks = input.networks
      .slice(0, 30)
      .map((n) => {
        const o = (n ?? {}) as Record<string, unknown>;
        const sig = Number(o.signal);
        return {
          ssid: str(o.ssid, 32),
          signal: Number.isFinite(sig) ? Math.max(0, Math.min(100, Math.round(sig))) : 0,
          secured: o.secured !== false,
          active: o.active === true,
        };
      })
      .filter((n) => n.ssid);
  }

  if (input.wifiResult && typeof input.wifiResult === 'object') {
    const o = input.wifiResult as Record<string, unknown>;
    device.wifiResult = {
      // null is a real third answer: the join worked but nothing could prove the server was still
      // reachable over it. Collapsing that into success is how a screen gets stranded quietly.
      ok: o.ok === true ? true : o.ok === false ? false : null,
      detail: str(o.detail, 200),
      at: new Date(nowMs).toISOString(),
    };
  }
}

/**
 * Whatever the device claimed about its network, reduced to something safe to render.
 *
 * Every field is re-derived rather than copied: `link` has to be one of three known strings or the
 * panel would render an unknown state, and `signal` has to be a real 0-100 integer or it ends up as
 * a CSS width. Returns null for anything that is not an object, so an old agent that sends nothing
 * simply leaves the last known state alone instead of blanking it.
 */
export function normDeviceNet(raw: unknown): DeviceNet | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const link = o.link === 'ethernet' || o.link === 'wifi' ? o.link : 'none';
  const n = Number(o.signal);
  return {
    link,
    // Only meaningful on Wi-Fi, and carrying a stale SSID next to an "ethernet" icon reads as a
    // claim about the current link that is not true.
    ssid: link === 'wifi' ? str(o.ssid, 32) : '',
    signal: link === 'wifi' && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0,
    radio: o.radio === true,
    // A device on Wi-Fi self-evidently has Wi-Fi, whatever else it claimed.
    hasWifi: o.hasWifi === true || link === 'wifi',
  };
}

/** Test seam. */
export function __resetDevicesForTests(): void {
  seen.clear();
}

// ── telling a device to do something, when nothing can connect to it ─────────
//
// The device only ever polls us, so a command is not sent — it is LEFT for the device to find on
// its next state poll, at most five seconds later. That shapes everything here.

/** Actions a Pi can be asked to perform from the panel. A closed set, checked on the way in. */
export const PI_COMMANDS = [
  'restart',
  'update',
  'reboot',
  'reinstall',
  'logs',
  // Managing the screen's own network. Every one of these is carried out by root on the device via
  // the control spool, because NetworkManager refuses all of them to an unprivileged caller
  // (measured: enable-disable-wifi is "no" even for the pi user, and settings.modify.system needs
  // an interactive polkit prompt no daemon can answer). READING what networks are visible needs no
  // privilege at all and is therefore not a command — the agent just reports it.
  'wifi-on',
  'wifi-off',
  'wifi-join',
  'wifi-forget',
  'wifi-rescan',
] as const;
export type PiCommandAction = (typeof PI_COMMANDS)[number];

/**
 * How long a queued command stays valid.
 *
 * Short on purpose. A screen switched off at the wall on Tuesday must not come back on Friday and
 * immediately act on something somebody clicked days ago — least of all restart itself in the
 * middle of Jumuah. Two minutes is far longer than the five-second poll and far shorter than an
 * outage anybody would notice.
 */
export const PI_COMMAND_TTL_MS = 120_000;

export interface PiCommand {
  /** unique per issue, so a device can tell a repeat from a new instruction */
  id: string;
  action: PiCommandAction;
  issuedAt: number;
  /** Only for 'wifi-join'. Held just long enough for the device to collect it — see queueCommand. */
  wifi?: { ssid: string; psk: string };
}

export function isPiCommand(v: unknown): v is PiCommandAction {
  return typeof v === 'string' && (PI_COMMANDS as readonly string[]).includes(v);
}

/**
 * Queue a command for an adopted device, replacing anything already waiting.
 *
 * Replacing rather than queueing is deliberate: these are not a work list, they are "what should
 * this screen do next". Two clicks on Restart mean one restart, and a click on Update after a click
 * on Restart means update.
 */
export function queueCommand(
  db: DB,
  deviceId: string,
  action: PiCommandAction,
  nowMs: number,
  wifi?: { ssid: string; psk: string },
): PiCommand | null {
  const device = db.piDevices?.find((d) => d.id === deviceId);
  if (!device || !device.token) return null;
  device.command = { id: `c_${crypto.randomBytes(6).toString('hex')}`, action, issuedAt: nowMs };
  // Remember when an install was asked for, because the panel has nothing else to go on.
  //
  // A reinstall takes over two minutes on a Pi — fetch, apt, npm, restart — and for all of that
  // time the card showed the OLD version and "update available", which is indistinguishable from
  // the button having done nothing. Somebody watching that reasonably presses it again, and the
  // device's own five-minute rate limit then refuses the second press silently, which makes it look
  // broken twice. The command itself is cleared the moment the device acknowledges it, seconds
  // later, so it cannot answer "is an update happening"; this can.
  if (action === 'reinstall' || action === 'update') device.updateAskedAt = nowMs;
  // A Wi-Fi passphrase, on its way to a device that is going to use it once.
  //
  // It lives on the command, which means it is written to the store like everything else, and it is
  // deleted the instant the device acknowledges — seconds later, and at the latest when the 120s TTL
  // expires. That is the shortest life this can have while still surviving a server restart between
  // the click and the device's next poll, which it must: losing it would leave somebody wondering
  // why nothing happened. It is never logged, and never returned by any read endpoint.
  if (action === 'wifi-join' && wifi) device.command.wifi = wifi;
  return device.command;
}

/** What this device should be told to do, if anything — expired commands are not mentioned. */
export function pendingCommand(
  device: PiDevice,
  nowMs: number,
): { id: string; action: PiCommandAction; wifi?: { ssid: string; psk: string } } | null {
  const c = device.command;
  if (!c || nowMs - c.issuedAt > PI_COMMAND_TTL_MS) return null;
  return c.wifi ? { id: c.id, action: c.action, wifi: c.wifi } : { id: c.id, action: c.action };
}

/**
 * The details for a 'wifi-join', validated here as well as on the device.
 *
 * Checked in both places deliberately. This is the friendly check, so somebody typing a password
 * into the dashboard is told what is wrong immediately instead of waiting two minutes for a screen
 * to report a failure. The check that actually MATTERS is the one root does on the device, because
 * this one is on the far side of a network from it and cannot be the thing standing between an
 * attacker and an nmcli argument.
 *
 * Rejects a leading dash for the same reason the device does: nmcli would read it as an option.
 */
export function normWifiJoin(raw: unknown): { ssid: string; psk: string } | { error: string } {
  const o = (raw ?? {}) as Record<string, unknown>;
  const ssid = typeof o.ssid === 'string' ? o.ssid : '';
  const psk = typeof o.psk === 'string' ? o.psk : '';
  if (!ssid) return { error: 'Choose a network to join.' };
  // 32 BYTES, not characters — an SSID is a byte string and a name in Arabic or Urdu reaches the
  // limit at a third of the character count.
  if (Buffer.byteLength(ssid, 'utf8') > 32) return { error: 'That network name is too long to be a real one.' };
  if (ssid.startsWith('-')) return { error: 'A network name cannot begin with a dash.' };
  // Character CODES rather than a regex character class. A control character written as an escape
  // inside a class is exactly the kind of thing that survives one round of editing and not the
  // next — this validator was briefly a syntax error for that reason — and a silently broken
  // check here is worse than no check, because it reads as one.
  const hasControl = (v: string): boolean => {
    for (let k = 0; k < v.length; k++) {
      const c = v.charCodeAt(k);
      if (c < 0x20 || c === 0x7f) return true;
    }
    return false;
  };
  if (hasControl(ssid)) return { error: 'That network name contains characters a screen cannot use.' };
  if (psk) {
    const hex64 = /^[0-9a-fA-F]{64}$/.test(psk);
    if (!hex64 && (psk.length < 8 || psk.length > 63)) {
      return { error: 'A Wi-Fi password must be at least 8 characters.' };
    }
    if (hasControl(psk)) return { error: 'That password contains characters a screen cannot use.' };
  }
  return { ssid, psk };
}

/**
 * The device has taken the instruction; stop offering it.
 *
 * Acknowledged BEFORE the device acts, not after, and that ordering is the whole safety property.
 * `restart` and `update` both end the process that would have done the acknowledging, so a device
 * that acted first would come back, poll, still be offered the same command, and act again —
 * for ever, every five seconds, with `Restart=always` guaranteeing nothing ever stops it.
 *
 * The id is matched so a late ack from a previous command cannot clear a newer one.
 */
export function ackCommand(db: DB, deviceId: string, id: string): void {
  const device = db.piDevices?.find((d) => d.id === deviceId);
  if (device?.command && device.command.id === id) delete device.command;
}

/**
 * Store the journal a device collected for us.
 *
 * ONE bundle per device, overwritten. A history would be more useful for about a week and then be
 * the largest thing in the store — this file is persisted to disk on a masjid's own volume, and a
 * screen that is being debugged is a screen somebody is pressing the button on repeatedly.
 *
 * Bounded and stripped on arrival like every other device-supplied string. This one goes into a page
 * and is the largest thing any device can send, so both matter: 200_000 characters is a little above
 * the 180_000 BYTES the device caps itself at, so a legitimate maximum log survives, and anything
 * beyond that is a device that is not ours.
 *
 * Control characters are removed EXCEPT newline and tab, which is the difference between a log and a
 * wall of text. That is why this does not reuse `str()` — that strips every control character, which
 * would turn eight hundred lines into one.
 */
export function setDeviceJournal(db: DB, deviceId: string, journal: string, nowMs: number): void {
  const device = db.piDevices?.find((d) => d.id === deviceId);
  if (!device) return;
  // Keep the END, not the start: the useful part of a log is the most recent, and the device already
  // sends the tail. Truncating from the front would silently discard what somebody is looking for.
  const clipped = journal.length > 200_000 ? journal.slice(-200_000) : journal;
  let out = '';
  for (const ch of clipped) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 10 || c === 9) out += ch;
    else if (c >= 32 && c !== 127) out += ch;
    // else: dropped. ANSI escapes arrive as ESC (27) plus printable text, so the escape byte goes
    // and its "[36m" tail would remain — see stripAnsi, which the panel applies for that reason.
  }
  device.journal = out;
  device.journalAt = new Date(nowMs).toISOString();
}

/**
 * Remove ANSI colour sequences.
 *
 * The installer deliberately colours its nine steps, so its output in the journal is full of
 * `ESC[36m`. Dropping the escape byte alone leaves the `[36m` behind as literal text, which is
 * worse than leaving it coloured — so the whole sequence goes, here, where it can be tested.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}
