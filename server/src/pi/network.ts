// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * pi/network.ts — how this screen is attached to the network, and what else it could attach to.
 *
 * Read-only. Everything here answers a question the dashboard asks ("is this screen on a cable or
 * on Wi-Fi?", "what networks can it see?"); nothing here changes anything. Changing the network
 * needs privileges the agent deliberately does not have — see the control spool in install.sh.
 *
 * All of it goes through `nmcli`, which is the supported interface on Raspberry Pi OS (Bookworm
 * onwards ship NetworkManager as the default stack; verified against nmcli 1.52.1 on a Pi 3 B+
 * running Debian 13). Parsing is split from running so the interesting part is testable off-device.
 *
 * Two things measured on a real Pi shaped this file:
 *
 *  • Reading the AP list needs no privilege at all. `wifi.scan` is an "auth" polkit action, but it
 *    only guards asking for a NEW scan; reading the results NetworkManager already has is free.
 *    So the agent can report what it can see, and only a rescan has to be asked of root.
 *
 *  • One network is several access points. A single SSID came back three times on one Pi — two
 *    2.4GHz APs and one 5GHz — so anything showing this list to a person has to collapse it by
 *    name, or they are asked to choose between three identical-looking rows.
 */
import { execFile } from 'node:child_process';

/** How long any one nmcli call gets. It talks to a local daemon; if that is wedged, we are not. */
const NMCLI_TIMEOUT_MS = 6_000;

export type LinkKind = 'ethernet' | 'wifi' | 'none';

export interface AccessPoint {
  ssid: string;
  /** 0-100 as NetworkManager reports it. */
  signal: number;
  /** true when the network needs a passphrase. Open networks are worth showing as such. */
  secured: boolean;
  /** true for the network this device is currently associated with. */
  active: boolean;
}

export interface NetFacts {
  /** What is actually carrying traffic. Ethernet wins when both are up — see linkFrom(). */
  link: LinkKind;
  /** The network wlan0 is associated with, if any. Empty when not on Wi-Fi. */
  ssid: string;
  /** Signal of that association, 0-100. Zero when not on Wi-Fi. */
  signal: number;
  /** Whether the Wi-Fi radio is switched on. Distinct from "has a Wi-Fi interface". */
  radio: boolean;
  /** Whether this device has Wi-Fi hardware at all. A Pi without it must not be offered Wi-Fi. */
  hasWifi: boolean;
}

/**
 * Split one line of `nmcli -t` output into fields.
 *
 * Terse mode is colon-separated and escapes a literal colon in a value as `\:` and a literal
 * backslash as `\\`. A plain `line.split(':')` therefore corrupts any network whose name contains
 * a colon — rare, but it is somebody's actual SSID, and the failure would be a mangled name in the
 * list they are trying to pick their own network out of.
 */
export function splitTerse(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i];
    } else if (ch === ':') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Decide what this screen is attached to, from `nmcli -t -f DEVICE,TYPE,STATE device status`.
 *
 * Ethernet wins a tie deliberately. A screen with both up routes over the cable (the default route
 * follows it — measured on a dual-homed Pi whose two links were on different subnets), so calling
 * that "Wi-Fi" because a radio happens to be associated would be wrong in the one case where the
 * answer matters: somebody deciding whether it is safe to unplug.
 */
export function linkFrom(deviceStatus: string): LinkKind {
  let wifi = false;
  for (const line of deviceStatus.split('\n')) {
    if (!line.trim()) continue;
    const [, type, state] = splitTerse(line);
    // "connected (externally)" is loopback and container-managed interfaces; only a plain
    // "connected" is a link NetworkManager is actually carrying traffic over for us.
    if (state !== 'connected') continue;
    if (type === 'ethernet') return 'ethernet';
    if (type === 'wifi') wifi = true;
  }
  return wifi ? 'wifi' : 'none';
}

/**
 * True when this device has a Wi-Fi interface at all, regardless of whether it is up.
 *
 * `p2p-dev-wlan0` is excluded: NetworkManager reports a Wi-Fi Direct pseudo-device alongside the
 * real radio, and counting it would claim Wi-Fi on hardware that has none.
 */
export function hasWifiFrom(deviceStatus: string): boolean {
  return deviceStatus.split('\n').some((l) => {
    if (!l.trim()) return false;
    const f = splitTerse(l);
    return f[1] === 'wifi' && !f[0].startsWith('p2p-dev');
  });
}

/**
 * Parse `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list`, collapsed to one entry per
 * network, strongest first, with the connected one pinned to the top.
 *
 * The collapsing is the point — see the file header. A hidden network reports an empty SSID and is
 * dropped: it cannot be joined by picking it out of a list, so offering it is offering a dead row.
 */
export function accessPointsFrom(wifiList: string): AccessPoint[] {
  const best = new Map<string, AccessPoint>();
  for (const line of wifiList.split('\n')) {
    if (!line.trim()) continue;
    const [inUse, ssid, signalRaw, security] = splitTerse(line);
    if (!ssid) continue;
    const ap: AccessPoint = {
      ssid: ssid.slice(0, 32),
      signal: Math.max(0, Math.min(100, Number.parseInt(signalRaw, 10) || 0)),
      // nmcli prints "--" for an open network, and a list of protocols otherwise.
      secured: Boolean(security) && security !== '--',
      active: inUse.trim() === '*',
    };
    const prev = best.get(ap.ssid);
    if (!prev) best.set(ap.ssid, ap);
    // Keep the strongest signal, but never let a stronger band hide the fact that we are
    // associated on a weaker one — "connected" is the more important of the two facts.
    else if (ap.signal > prev.signal) best.set(ap.ssid, { ...ap, active: ap.active || prev.active });
    else if (ap.active) best.set(ap.ssid, { ...prev, active: true });
  }
  return [...best.values()].sort((a, b) => Number(b.active) - Number(a.active) || b.signal - a.signal);
}

/** Parse `nmcli -t -f WIFI radio`. Anything other than a clear "enabled" is treated as off. */
export function radioFrom(radioOut: string): boolean {
  return splitTerse(radioOut.trim())[0] === 'enabled';
}

/** Run one nmcli invocation. Array-form argv, never a shell — the same rule as the media pipeline. */
function nmcli(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('nmcli', args, { timeout: NMCLI_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
      // A missing nmcli, a wedged daemon and a non-zero exit are all the same to us: no facts.
      resolve(err ? '' : stdout);
    });
  });
}

const NO_NETWORK: NetFacts = { link: 'none', ssid: '', signal: 0, radio: false, hasWifi: false };

/**
 * Everything this module knows, gathered without privileges and without ever throwing.
 *
 * Non-fatal for the same reason `deviceFacts()` is, and that reason is not hypothetical: a fact
 * gathered only in order to draw an icon in the dashboard once took a television down for sixteen
 * restarts. Nothing here may be able to do that.
 */
export async function netFacts(): Promise<NetFacts> {
  try {
    const [status, wifiList, radio] = await Promise.all([
      nmcli(['-t', '-f', 'DEVICE,TYPE,STATE', 'device', 'status']),
      nmcli(['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list']),
      nmcli(['-t', '-f', 'WIFI', 'radio']),
    ]);
    const active = accessPointsFrom(wifiList).find((a) => a.active);
    return {
      link: linkFrom(status),
      ssid: active?.ssid ?? '',
      signal: active?.signal ?? 0,
      radio: radioFrom(radio),
      hasWifi: hasWifiFrom(status),
    };
  } catch {
    return { ...NO_NETWORK };
  }
}

/** The visible networks, strongest first. Separate from netFacts() because the panel asks for it. */
export async function scanNetworks(): Promise<AccessPoint[]> {
  try {
    return accessPointsFrom(await nmcli(['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list']));
  } catch {
    return [];
  }
}
