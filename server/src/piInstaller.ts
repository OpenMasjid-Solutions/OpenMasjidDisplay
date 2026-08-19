// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * piInstaller.ts — the one-line install, and the address it bakes in.
 *
 * Setting up a Raspberry Pi screen is one command, and the reason it can be one command is that
 * the script is served BY the display server. Whatever address you fetched it from is the address
 * it writes into the Pi's config, so there is nothing to fill in and nothing to get wrong:
 *
 *     curl -fsSL http://192.168.1.18:7860/pi.sh | sudo sh
 *
 * That convenience is also the security-sensitive part of this file, because the address is
 * derived from the request — and `Host` is set by whoever is calling. So the whole job here is
 * to substitute a value into a shell script *safely*.
 *
 * Two things make that sound rather than hopeful:
 *
 *   1. **The allowed characters cannot express an escape.** The host, scheme and base path are
 *      matched against strict patterns with no quotes, no backslash, no `$`, no backtick and no
 *      newline in them. There is no string that passes and then means something else in sh.
 *   2. **The substitution lands inside single quotes.** Even if a character did slip through,
 *      `SERVER='…'` does not expand anything.
 *
 * A host that fails the pattern gets a refusal, not a best-effort guess. Serving a script with a
 * mangled address in it would produce a Pi that installs cleanly and then never connects, which
 * is a far worse outcome than being told the address is wrong.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';

/** A hostname, an IPv4 literal, or a bracketed IPv6 one, with an optional port. Note what is
 *  absent: quotes, spaces, `$`, backslashes, semicolons — anything with a meaning in sh. */
const HOST_RE = /^(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;

/** The tunnel prefix the platform mounts this app under, e.g. `/display`. Empty on the LAN. */
const PREFIX_RE = /^(?:\/[a-z0-9-]{1,40})?$/;

/**
 * Work out the address a Pi should be told to talk to.
 *
 * `X-Forwarded-*` is honoured for the same reason and under the same condition as everywhere else
 * in this app: the OpenMasjidOS ingress sanitises those headers, and when the app is reached
 * directly they are simply absent (CLAUDE.md §4). The failure direction is safe — a spoofed value
 * can only change the address written into the script that the spoofer is themselves fetching.
 */
export function originFor(req: IncomingMessage, pathname: string): string | null {
  const fwdHost = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
  const host = (fwdHost || String(req.headers.host ?? '')).trim();
  if (!HOST_RE.test(host)) return null;

  const fwdProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  const encrypted = (req.socket as { encrypted?: boolean } | null | undefined)?.encrypted === true;
  const scheme = fwdProto ? (fwdProto === 'https' ? 'https' : 'http') : encrypted ? 'https' : 'http';

  // Keep whatever prefix this app is mounted under, so a Pi set up through the platform's tunnel
  // reaches /display/pi/enrol rather than /pi/enrol at the platform root.
  const m = /^(\/[a-z0-9-]+)\/pi\.sh$/.exec(pathname);
  const prefix = m ? m[1] : '';
  if (!PREFIX_RE.test(prefix)) return null;

  return `${scheme}://${host}${prefix}`;
}

/**
 * Put the address, the renderer version and the agent version into the script.
 *
 * The renderer version is pinned from *this* server's own dependency rather than written into
 * the script by hand. A Pi drawing with a different resvg than the server would produce nearly —
 * but not exactly — the same timetable, and "nearly" is the kind of difference that gets noticed
 * once and never reproduced.
 */
export function renderInstaller(
  template: string,
  origin: string,
  resvgVersion: string,
  agentVersion: string,
): string {
  const safe = (v: string): string => (/^[A-Za-z0-9.+_:/@^~-]{1,64}$/.test(v) ? v : 'unknown');
  return template
    .split('@@SERVER@@')
    .join(origin)
    .split('@@RESVG@@')
    .join(safe(resvgVersion))
    .split('@@AGENT_VERSION@@')
    .join(safe(agentVersion));
}

/** Where the installer template and the bundled agent live in the image. Overridable so the
 *  same code runs from a source checkout during development. */
const ASSET_DIRS = [
  process.env.OMD_PI_DIR,
  '/app/pi',
  path.join(__dirname, '..', 'assets', 'pi'),
  path.join(__dirname, '..', '..', 'assets', 'pi'),
].filter((d): d is string => !!d);

function findAsset(name: string): string | null {
  for (const dir of ASSET_DIRS) {
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

/** The installer template, read once — it is a few kilobytes and never changes at runtime. */
let templateCache: string | null = null;
export function installerTemplate(): string | null {
  if (templateCache !== null) return templateCache;
  const p = findAsset('install.sh');
  if (!p) return null;
  try {
    templateCache = fs.readFileSync(p, 'utf8');
    return templateCache;
  } catch {
    return null;
  }
}

/** The bundled agent, built by the image and served to Pis. Not cached in memory: it is around
 *  a megabyte, and it is fetched once per install rather than once a second. */
export function agentBundlePath(): string | null {
  return findAsset('agent.js');
}

/** The resvg this server renders with, so the Pi installs the identical version. */
export function resvgVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return String(require('@resvg/resvg-js/package.json').version ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

/**
 * This build's version, which is the agent version too.
 *
 * The agent and the server ship from the same commit, so one number describes both — and a
 * panel listing a dozen screens can say which of them are running something older than the
 * server they are talking to.
 */
export function appVersion(): string {
  for (const dir of [path.resolve(__dirname, '..'), path.resolve(__dirname, '..', '..')]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      /* try the next one */
    }
  }
  return 'unknown';
}

/** Test seam — the template is cached for the life of the process. */
export function __resetInstallerCacheForTests(): void {
  templateCache = null;
}
