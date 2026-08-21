// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * pi/stats.ts — how hard this screen is working.
 *
 * Read straight out of /proc and /sys, which needs no privilege at all: every file here is
 * world-readable, so this works from inside the agent's sandbox without asking root for anything.
 * That is the reason for choosing these sources over `vcgencmd` or `top` — the moment a fact needs a
 * privileged helper it needs a spool round trip, and a number that updates every few seconds cannot
 * afford one.
 *
 * Parsing is split from reading so the interesting half is testable without a Pi, which is the same
 * shape as network.ts and decode.ts and for the same reason.
 *
 * Nothing here may throw. These numbers exist to be displayed; a fact gathered for a readout once
 * took a television down through sixteen restarts, and that lesson applies to every one of them.
 */
import fs from 'node:fs';
import os from 'node:os';

export interface PiStats {
  /** 1-minute load average. */
  load1: number;
  /** How many cores that load is spread across, so a reader can judge it. */
  cores: number;
  /** Load as a percentage of capacity: load1 / cores. Can exceed 100 — that is the useful part. */
  cpuPercent: number;
  /** Megabytes. */
  memUsedMb: number;
  memTotalMb: number;
  memPercent: number;
  /** Celsius, or 0 when the board does not say. */
  tempC: number;
  /** Seconds since boot, so "it restarted an hour ago" is answerable. */
  uptimeSec: number;
}

/** Parse /proc/loadavg — "0.52 0.58 0.59 1/180 12345". */
export function parseLoadAvg(text: string): number {
  const n = Number.parseFloat(text.trim().split(/\s+/)[0] ?? '');
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Parse /proc/meminfo into used and total megabytes.
 *
 * Uses MemAvailable rather than MemFree, and the difference matters on a Pi: MemFree excludes the
 * page cache, so a healthy board that has cached a few hundred megabytes of fonts and wallpaper
 * reports itself as nearly out of memory. MemAvailable is the kernel's own estimate of what a new
 * process could actually get, which is the question anybody looking at this is asking.
 */
export function parseMeminfo(text: string): { usedMb: number; totalMb: number } {
  const kb = (key: string): number => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text);
    return m ? Number.parseInt(m[1], 10) : 0;
  };
  const total = kb('MemTotal');
  const avail = kb('MemAvailable');
  if (!total) return { usedMb: 0, totalMb: 0 };
  const used = avail > 0 ? total - avail : 0;
  return { usedMb: Math.round(used / 1024), totalMb: Math.round(total / 1024) };
}

/** Parse a thermal zone's temp file, which is millidegrees ("58312" = 58.3C). */
export function parseTemp(text: string): number {
  const n = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Some boards report degrees directly rather than millidegrees; anything under 200 is already C.
  const c = n > 200 ? n / 1000 : n;
  return c > 0 && c < 150 ? Math.round(c * 10) / 10 : 0;
}

/** Put the pieces together, given the raw file contents. Pure, so it can be tested exactly. */
export function buildStats(input: {
  loadavg: string;
  meminfo: string;
  temp: string;
  uptimeSec: number;
  cores: number;
}): PiStats {
  const load1 = parseLoadAvg(input.loadavg);
  const cores = input.cores > 0 ? input.cores : 1;
  const mem = parseMeminfo(input.meminfo);
  return {
    load1,
    cores,
    cpuPercent: Math.round((load1 / cores) * 100),
    memUsedMb: mem.usedMb,
    memTotalMb: mem.totalMb,
    memPercent: mem.totalMb > 0 ? Math.round((mem.usedMb / mem.totalMb) * 100) : 0,
    tempC: parseTemp(input.temp),
    uptimeSec: Math.max(0, Math.round(input.uptimeSec)),
  };
}

const read = (p: string): string => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

/** Everything above, from this machine. Never throws. */
export function piStats(): PiStats {
  let cores = 1;
  let uptimeSec = 0;
  try {
    cores = os.cpus().length || 1;
  } catch {
    /* a readout is never worth a crash */
  }
  try {
    uptimeSec = os.uptime();
  } catch {
    /* same */
  }
  return buildStats({
    loadavg: read('/proc/loadavg'),
    meminfo: read('/proc/meminfo'),
    // The first thermal zone is the SoC on a Pi. World-readable, unlike vcgencmd's /dev/vcio.
    temp: read('/sys/class/thermal/thermal_zone0/temp'),
    uptimeSec,
    cores,
  });
}
