// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * pi/lanHost.ts — is this address one that a public certificate authority could ever vouch for?
 *
 * The Raspberry Pi installer is fetched with `curl`, and `curl` refuses a certificate it cannot
 * verify. On a masjid's LAN the display server is very often reached at something like
 * `https://192.168.1.18:8444` behind a **self-signed** certificate, because no certificate
 * authority will issue for a private address — so the one-line install fails at the first hop with
 * an error that reads like the server is broken.
 *
 * The honest fix is not to always pass `-k`. It is to know *when* verification cannot possibly
 * succeed, say so, and pass it only there. Reached through the platform's remote access on a real
 * hostname, the certificate is real and the command should verify it like anything else.
 *
 * This is a **heuristic about names, not a security check.** It only decides which command the
 * dashboard offers to copy; nothing trusts its answer. The actual trust decision happens on the Pi
 * a moment later, where the installer pins the server's certificate and turns verification back on
 * for everything that follows.
 *
 * Shared by the panel (which builds the command) and the server's tests (which is where anything
 * this fiddly ought to be checked), so it is kept free of imports and browser or Node globals.
 */

/** RFC1918, loopback, link-local and CGNAT — everything a public CA will refuse to issue for. */
function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((n) => Number(n) > 255)) return false;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * True when a certificate for this host cannot have come from a public authority.
 *
 * Covers the four shapes a masjid's own server actually takes: a private IPv4 address, an IPv6
 * literal, an mDNS `.local` name, and a bare single-label hostname. A public domain — which is
 * what the platform's remote access gives you — is none of these.
 */
export function isPrivateHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (isPrivateIPv4(h)) return true;
  // Any IPv6 literal. Reaching a server by raw IPv6 is not something a public certificate covers
  // in practice, and the failure mode of guessing wrong here is only a needless `-k`.
  if (h.includes(':')) return true;
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home') || h.endsWith('.internal')) return true;
  // A bare name with no dot at all — `raspberrypi`, `display` — is a LAN name by construction.
  if (!h.includes('.')) return true;
  return false;
}

/**
 * The command to show in the dashboard, and whether it had to give up verifying the first hop.
 *
 * `insecureFirstHop` is surfaced to the admin rather than hidden. Somebody about to pipe a script
 * into `sudo sh` deserves to be told which part is unverified and why, and the panel says both.
 */
export function installCommand(origin: string): { command: string; insecureFirstHop: boolean } {
  let insecure = false;
  try {
    const u = new URL(origin);
    insecure = u.protocol === 'https:' && isPrivateHostname(u.hostname);
  } catch {
    insecure = false;
  }
  return {
    command: `curl -fsSL${insecure ? 'k' : ''} ${origin.replace(/\/+$/, '')}/pi.sh | sudo sh`,
    insecureFirstHop: insecure,
  };
}
