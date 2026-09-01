// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * pi/device.ts — what this Pi can say about itself.
 *
 * All three facts here exist for one purpose: to make a screen identifiable by someone standing
 * in front of it, or on the phone to someone who is. They are shown on the pairing screen and
 * sent with enrolment so the panel can list "raspberrypi · 192.168.1.44 · Raspberry Pi 3 Model
 * B Plus" rather than an opaque id. None of them is trusted for anything — the server treats
 * every one as self-reported text and sanitises it.
 */
import os from 'node:os';
import fs from 'node:fs';

interface Addr {
  address: string;
  family: string | number;
  internal: boolean;
}

/**
 * Pick the address a person would recognise as "the Pi's IP".
 *
 * A Pi has more addresses than you would expect — loopback always, a link-local `169.254.x` when
 * DHCP has not answered yet, and often both a wired and a wireless address. The one worth
 * showing is a real private-network IPv4, and wired is preferred over wireless because a screen
 * that matters is usually the one on a cable.
 *
 * Returns an empty string when there is no usable address, which is itself worth showing: "no
 * network" on the television is the answer to why nothing else is working.
 */
export function pickLanIp(ifaces: Record<string, Addr[] | undefined>): string {
  const candidates: { name: string; ip: string }[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal) continue;
      // Not an address anybody can reach us on, and showing it would send someone chasing a
      // DHCP problem they have already got.
      if (a.address.startsWith('169.254.')) continue;
      candidates.push({ name, ip: a.address });
    }
  }
  if (!candidates.length) return '';
  // Wired first (`eth*`/`en*`), then anything else. Docker/virtual bridges last — a Pi should
  // not have them, but a Pi someone has been experimenting on might.
  const rank = (n: string): number => {
    if (/^(docker|br-|veth|virbr)/.test(n)) return 3;
    if (/^(eth|en)/.test(n)) return 0;
    if (/^(wlan|wl)/.test(n)) return 1;
    return 2;
  };
  candidates.sort((a, b) => rank(a.name) - rank(b.name));
  return candidates[0].ip;
}

/** Which Pi this is, as the firmware describes it. The device-tree string is NUL-terminated. */
export function readModel(): string {
  try {
    return fs.readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').trim().slice(0, 80);
  } catch {
    return '';
  }
}

export interface DeviceFacts {
  hostname: string;
  ip: string;
  model: string;
}

/**
 * Everything here is decoration, and it must be impossible for decoration to take a screen down.
 *
 * That is not a precaution written in advance — it is written after the fact. `os.networkInterfaces()`
 * threw `EAFNOSUPPORT` on a real Pi because the service unit restricted socket families and
 * enumerating interfaces goes through netlink. The throw reached the top of `main`, the process
 * exited, systemd restarted it five seconds later, and the television sat frozen through sixteen
 * restarts — all because the agent could not work out an IP address it only wanted in order to
 * print it in small text at the bottom of a setup screen.
 *
 * The unit is fixed. This is the second lock: no fact gathered for display may ever be fatal.
 */
export function deviceFacts(): DeviceFacts {
  let hostname = '';
  let ip = '';
  try {
    hostname = os.hostname().slice(0, 64);
  } catch {
    /* nothing to show; the screen still works */
  }
  try {
    ip = pickLanIp(os.networkInterfaces() as Record<string, Addr[] | undefined>);
  } catch {
    /* the pairing screen will say "no network" — which is a better answer than not booting */
  }
  return { hostname, ip, model: readModel() };
}
