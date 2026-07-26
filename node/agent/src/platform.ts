// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * platform.ts — everything about the agent that is specific to a Raspberry Pi, behind
 * one interface.
 *
 * WHY THIS SEAM EXISTS: the agent's real work is a state machine and a protocol client,
 * and neither needs a Pi. Putting `/proc/cpuinfo`, `cog`, GStreamer, NetworkManager and
 * `reboot` behind an interface means the interesting logic can be exercised on a
 * developer machine against the REAL controller (see agent.test.ts) instead of being
 * verifiable only by flashing a card. It also isolates the Pi-specific surface if the
 * agent is ever rewritten in Go (spec §6).
 *
 * Rule: no other module in the agent may import `node:child_process`, read `/proc`, or
 * shell out. If you need a new device capability, add a method here.
 */
import fs from 'node:fs';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { NodeCapsMsg, NodeHealthMsg } from '../../../packages/protocol/src/index';

/** A supervised child process (the kiosk browser, or the video player). */
export interface Proc {
  /** stop it; resolves once it is gone */
  stop(): Promise<void>;
  /** fires once if the process exits on its own */
  onExit(cb: (info: { code: number | null; signal: string | null }) => void): void;
  readonly running: boolean;
}

export interface Platform {
  /** Stable hardware serial. The controller keys a node's identity off this. */
  serial(): string;
  /** Human-readable board model, e.g. 'Raspberry Pi Zero 2 W'. */
  model(): string;
  /** What this board can decode in HARDWARE. */
  caps(): NodeCapsMsg;
  /** Best-effort health for the heartbeat. Never throws. */
  health(): NodeHealthMsg;
  /** Has the clock been set by NTP yet? The Pi has no RTC, so prayer times must not be
   *  drawn from a wrong clock (spec §10). */
  clockSynced(): boolean;
  /** Show a local page full-screen on HDMI (the kiosk browser). */
  startKiosk(url: string): Proc;
  /** Play an RTSP stream full-screen on HDMI, hardware-decoded. */
  startPlayer(url: string, transport: 'tcp' | 'udp'): Proc;
  /** Blank the output (DPMS off). */
  blank(): void;
  reboot(): void;
  /** Wipe persistent state and return to unadopted (factory reset). */
  wipeData(): void;
}

/** The Pi implementation. */
export class LinuxPlatform implements Platform {
  constructor(
    private readonly dataDir: string,
    /** where the kiosk bundle is served from by our own local HTTP server */
    private readonly opts: { cogBin?: string; gstBin?: string } = {},
  ) {}

  serial(): string {
    // /proc/cpuinfo carries a stable 16-hex-digit serial on every Pi. Falling back to the
    // machine id keeps a non-Pi board (or a future model that drops the field) usable
    // rather than refusing to start — the serial only has to be STABLE and unique.
    try {
      const m = /^Serial\s*:\s*([0-9a-fA-F]+)\s*$/m.exec(fs.readFileSync('/proc/cpuinfo', 'utf8'));
      if (m) return m[1].toLowerCase();
    } catch {
      /* not a Pi, or /proc unreadable */
    }
    try {
      const id = fs.readFileSync('/etc/machine-id', 'utf8').trim();
      if (id) return id.slice(0, 32);
    } catch {
      /* fall through */
    }
    return `unknown-${os.hostname()}`.slice(0, 64);
  }

  model(): string {
    try {
      // A NUL-terminated string on the Pi; trim it or it corrupts JSON downstream.
      return fs.readFileSync('/proc/device-tree/model', 'utf8').replace(/\0+$/, '').trim().slice(0, 64);
    } catch {
      return '';
    }
  }

  caps(): NodeCapsMsg {
    // A Pi Zero 2 W hardware-decodes H.264 up to 1080p30 and nothing else — no H.265, no
    // VP9 (spec §12). Stated rather than probed: getting this wrong in the optimistic
    // direction means a black screen at a masjid, so we under-claim by default.
    return { codecs: ['h264'], maxHeight: 1080, maxFps: 30 };
  }

  health(): NodeHealthMsg {
    const h: NodeHealthMsg = { uptimeS: Math.round(os.uptime()), memFreeMb: Math.round(os.freemem() / 1048576) };
    try {
      const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim();
      const milli = Number.parseInt(raw, 10);
      if (Number.isFinite(milli)) h.tempC = Math.round(milli / 100) / 10;
    } catch {
      /* no thermal zone */
    }
    const ip = primaryIPv4();
    if (ip) h.ip = ip;
    const rssi = wifiRssi();
    if (rssi != null) h.wifiRssi = rssi;
    return h;
  }

  clockSynced(): boolean {
    // chrony/systemd-timesyncd drop this once the clock is stepped. If neither marker is
    // present, fall back to a sanity check: a Pi with no RTC boots in 1970.
    for (const f of ['/run/systemd/timesync/synchronized', '/var/lib/chrony/synced']) {
      try {
        if (fs.existsSync(f)) return true;
      } catch {
        /* ignore */
      }
    }
    return new Date().getUTCFullYear() >= 2024;
  }

  startKiosk(url: string): Proc {
    // cog = WPE WebKit on DRM/KMS: a real browser engine with no desktop, no compositor
    // and ~250 MB RSS. Chromium does not fit in 512 MB alongside anything else.
    const bin = this.opts.cogBin ?? 'cog';
    return supervise(bin, ['--platform=drm', url], { WAYLAND_DISPLAY: '' });
  }

  startPlayer(url: string, transport: 'tcp' | 'udp'): Proc {
    const bin = this.opts.gstBin ?? 'gst-launch-1.0';
    // ARRAY-FORM spawn with the URL as its own argument — never a shell string. A camera
    // URL is attacker-influenceable data (it can carry credentials and arbitrary
    // characters), and this is the same invariant the controller's ffmpeg pipeline keeps.
    return supervise(bin, [
      '-q',
      'rtspsrc',
      `location=${url}`,
      `protocols=${transport}`,
      'latency=200',
      '!',
      'rtph264depay',
      '!',
      'h264parse',
      '!',
      'v4l2h264dec',
      '!',
      'kmssink',
      'force-modesetting=true',
    ]);
  }

  blank(): void {
    // Best effort: DPMS off via the KMS console. A screen that stays lit is a cosmetic
    // failure, so never let it take the agent down.
    try {
      fs.writeFileSync('/sys/class/graphics/fb0/blank', '1');
    } catch {
      /* ignore */
    }
  }

  reboot(): void {
    try {
      spawn('systemctl', ['reboot'], { stdio: 'ignore', detached: true }).unref();
    } catch {
      /* ignore */
    }
  }

  wipeData(): void {
    // Remove the adoption state, then reboot into the unadopted flow. rmSync on the
    // directory contents (not the mount point) because /data is its own partition.
    try {
      for (const entry of fs.readdirSync(this.dataDir)) {
        fs.rmSync(`${this.dataDir}/${entry}`, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
    this.reboot();
  }
}

/** First non-internal IPv4 address, or ''. */
export function primaryIPv4(): string {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal && a.address) return a.address;
  }
  return '';
}

/** Wi-Fi signal in dBm from /proc/net/wireless, or null when wired/unavailable. */
function wifiRssi(): number | null {
  try {
    const lines = fs.readFileSync('/proc/net/wireless', 'utf8').split('\n').slice(2);
    for (const line of lines) {
      // "wlan0: 0000   54.  -56.  -256        0      0 …" — level is the 4th field.
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4) {
        const level = Number.parseFloat(parts[3]);
        if (Number.isFinite(level) && level < 0) return Math.round(level);
      }
    }
  } catch {
    /* wired, or no wireless stack */
  }
  return null;
}

/** Spawn a child and wrap it as a Proc. */
function supervise(bin: string, args: string[], env?: Record<string, string>): Proc {
  const child: ChildProcess = spawn(bin, args, {
    stdio: 'ignore',
    env: env ? { ...process.env, ...env } : process.env,
  });
  let alive = true;
  const exitCbs: Array<(i: { code: number | null; signal: string | null }) => void> = [];
  child.on('exit', (code, signal) => {
    alive = false;
    for (const cb of exitCbs) cb({ code, signal });
  });
  child.on('error', () => {
    alive = false;
    for (const cb of exitCbs) cb({ code: null, signal: null });
  });
  return {
    get running() {
      return alive;
    },
    onExit(cb) {
      exitCbs.push(cb);
    },
    stop() {
      return new Promise<void>((resolve) => {
        if (!alive) return resolve();
        const done = setTimeout(() => {
          // Escalate: a wedged GStreamer pipeline holding the display must not keep a
          // masjid's screen frozen because it ignored SIGTERM.
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(done);
          resolve();
        });
        try {
          child.kill('SIGTERM');
        } catch {
          clearTimeout(done);
          resolve();
        }
      });
    },
  };
}
