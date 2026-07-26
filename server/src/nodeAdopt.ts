// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * nodeAdopt.ts — adopt a Raspberry Pi display node by IP, UniFi-style.
 *
 * The admin types (or picks) the address the node is showing on its TV; we ask it who it
 * is, mint a 256-bit token, hand the token over exactly once, and store only its hash.
 * From then on the node dials us and everything is token-authenticated (see nodeHub.ts).
 *
 * ── SECURITY: this is the one place the controller makes an outbound request to an
 * address an ADMIN chose, which is a server-side request forgery surface. Two guards:
 *
 *  1. PRIVATE RANGES ONLY. Adoption is inherently a local-network operation — the node
 *     is a box plugged into a TV in the building — so a public address is never
 *     legitimate here and is refused. Without this, `POST /api/nodes/adopt` with
 *     `{ip:'169.254.169.254'}`-style targets turns the controller into a probe for
 *     whatever its host can reach. (Link-local IS in the private set because masjid LANs
 *     use it, so cloud metadata endpoints are additionally denied by name below.)
 *  2. No redirects, a short timeout, a small response cap, and every field of the reply
 *     validated by the shared protocol validators before it touches the store.
 *
 * Mirrors the reasoning behind the Fabric private-range guard in fabric.ts; kept separate
 * because that one protects our app secret and this one protects the network.
 */
import { makeLog } from './logger';
import { hashPassword } from './auth';
import { rid } from './store';
import { newNodeToken } from './nodeHub';
import { NODE_WS_PATH, parseAdoptResponse, parseNodeStatusResponse, type NodeStatusResponse } from '../../packages/protocol/src/index';
import type { PiNode } from './types';

const log = makeLog('node-adopt');

/** How long we wait on a node that may be booting. */
const TIMEOUT_MS = 6000;
/** A node's status/adopt reply is a few hundred bytes; refuse anything absurd. */
const MAX_REPLY_BYTES = 64 * 1024;

/**
 * Addresses that are always refused even though they fall inside a "private" range,
 * because they are well-known cloud instance-metadata services. A masjid's node is never
 * at one of these, and reaching them from inside a container can leak credentials.
 */
const DENIED_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', '100.100.100.200']);

/** Is this a bare IPv4 literal in a private/LAN range? */
function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 127) return true; // loopback — used by the mock node in tests
  return false;
}

/**
 * Validate an admin-supplied node address, returning a safe `http://host` origin or an
 * error message. Accepts a bare IPv4 or an `*.local` / `*.lan` mDNS name (which is how
 * the panel's discovery picker offers nodes).
 */
export function nodeOrigin(raw: string): { origin: string } | { error: string } {
  const hostPort = raw.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!hostPort) return { error: 'Enter the address shown on the screen.' };
  // No credentials: stops `user@evil.com`-style tricks from reaching the fetch below.
  if (hostPort.includes('@')) {
    return { error: 'Enter just the IP address shown on the screen (for example 192.168.1.40).' };
  }

  /*
   * A PORT is accepted only for LOOPBACK.
   *
   * A real node always answers on :80 — it is a dedicated appliance, so nothing competes
   * for the port and an admin can type just the IP they read off the TV. Allowing an
   * arbitrary port on a LAN address would turn this endpoint into a port scanner for the
   * masjid's network, which is the whole point of the guard, so that stays refused.
   *
   * Loopback is different: the controller can already reach its own loopback trivially, so
   * no new reachability is granted — and it is what lets `node/agent`'s devnode harness be
   * adopted through the real panel UI on a developer's machine. That matters because
   * OpenMasjidOS itself binds :80 on the host, so a dev node must NOT use :80 there.
   */
  // The host part is matched as "no colons" so an IPv6 literal cannot be mis-split into a
  // host and a port (`::1` would otherwise parse as host `::` port `1`). IPv6 is then
  // refused outright below: a node is reached by IPv4 or by its mDNS name, and supporting a
  // third address form here would only add a parse to get wrong.
  const portMatch = /^([^:]*):(\d{1,5})$/.exec(hostPort);
  const host = portMatch ? portMatch[1] : hostPort;
  const port = portMatch ? Number.parseInt(portMatch[2], 10) : 0;
  if (host.includes(':')) {
    return { error: 'Enter the IPv4 address or name shown on the screen (for example 192.168.1.40).' };
  }
  const isLoopback = ['127.0.0.1', 'localhost'].includes(host.toLowerCase());
  if (portMatch) {
    if (!isLoopback) {
      return {
        error:
          'A display node answers on the standard port, so enter just the address shown on the ' +
          'screen (for example 192.168.1.40) with no “:port”.',
      };
    }
    if (port < 1 || port > 65535) return { error: 'That port number is not valid.' };
  }
  const lower = host.toLowerCase();
  if (DENIED_HOSTS.has(lower)) return { error: 'That address is not a display node.' };
  const isMdns = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(local|lan)$/.test(lower);
  if (!isPrivateIPv4(lower) && !isMdns && !isLoopback) {
    return {
      error:
        'A Pi node is adopted over your local network, so its address must be a local one ' +
        '(for example 192.168.1.40 or omd-node-1a2b.local).',
    };
  }
  return { origin: portMatch ? `http://${lower}:${port}` : `http://${lower}` };
}

/** Read a bounded JSON body, or throw. */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length > MAX_REPLY_BYTES) throw new Error('reply too large');
  return JSON.parse(text) as unknown;
}

async function nodeFetch(origin: string, path: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${origin}${path}`, {
      ...init,
      signal: ctrl.signal,
      // A node must never bounce us somewhere else — that would defeat the address check.
      redirect: 'error',
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Ask a node who it is, without adopting it (the panel's "check" step). */
export async function probeNode(address: string): Promise<{ status: NodeStatusResponse } | { error: string }> {
  const o = nodeOrigin(address);
  if ('error' in o) return o;
  return probeAtOrigin(o.origin, address);
}

/**
 * `probeNode` with the address guard already applied.
 *
 * Split out so tests can drive a mock node on an ephemeral port: `nodeOrigin` refuses
 * addresses carrying a port (that IS the SSRF guard), so going through the front door in a
 * test would mean binding port 80 or loosening the guard. Callers handling an
 * admin-supplied address must use `probeNode`/`adoptNode`, never this.
 */
export async function probeAtOrigin(
  origin: string,
  label = origin,
): Promise<{ status: NodeStatusResponse } | { error: string }> {
  try {
    const res = await nodeFetch(origin, '/api/status');
    if (!res.ok) return { error: `The device at ${label} answered with HTTP ${res.status}.` };
    const parsed = parseNodeStatusResponse(await readJson(res));
    if (!parsed.ok) return { error: `That device does not look like a display node (${parsed.error}).` };
    return { status: parsed.value };
  } catch (err) {
    log.debug(`probe ${label} failed: ${err instanceof Error ? err.message : err}`);
    return { error: `Could not reach a display node at ${label}. Check the address on the screen and that it is powered on.` };
  }
}

export interface AdoptOutcome {
  node: PiNode;
}

/**
 * Adopt the node at an admin-supplied `address` (guard first, then handshake).
 *
 * `wsUrl` is where the node will dial us forever after, so the caller passes the
 * externally-reachable origin of THIS controller (see controllerWsUrl). Returns the new
 * PiNode record for the caller to persist — this function does not touch the store, so
 * it stays testable and the caller controls the transaction.
 */
export async function adoptNode(
  address: string,
  opts: { controllerName: string; wsUrl: string; name?: string },
): Promise<AdoptOutcome | { error: string }> {
  const o = nodeOrigin(address);
  if ('error' in o) return o;
  return adoptAtOrigin(o.origin, opts, address);
}

/** `adoptNode` with the address guard already applied — see probeAtOrigin. */
export async function adoptAtOrigin(
  origin: string,
  opts: { controllerName: string; wsUrl: string; name?: string },
  label = origin,
): Promise<AdoptOutcome | { error: string }> {
  const o = { origin };
  const address = label;
  const probed = await probeAtOrigin(origin, label);
  if ('error' in probed) return probed;
  if (probed.status.adopted) {
    return {
      error:
        'That node is already adopted. Remove it from its current controller, or factory-reset it ' +
        '(create a file named "factory-reset" on the SD card\'s boot partition, or hold GPIO21 to ' +
        'ground for 10 seconds while it boots).',
    };
  }

  const token = newNodeToken();
  try {
    const res = await nodeFetch(o.origin, '/api/adopt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerName: opts.controllerName, wsUrl: opts.wsUrl, nodeToken: token }),
    });
    if (res.status === 409) return { error: 'That node was adopted by another controller a moment ago.' };
    if (!res.ok) return { error: `The node refused adoption (HTTP ${res.status}).` };
    const parsed = parseAdoptResponse(await readJson(res));
    if (!parsed.ok) return { error: `The node sent a reply we could not read (${parsed.error}).` };
    if (parsed.value.serial !== probed.status.serial) {
      // The identity changed between the two calls — two devices behind one address, or
      // something impersonating a node. Refuse rather than record a mismatched pairing.
      return { error: 'That address answered as two different devices. Try again.' };
    }

    const cred = hashPassword(token);
    const node: PiNode = {
      id: rid('node'),
      serial: parsed.value.serial,
      name: (opts.name || `Screen ${parsed.value.serial.slice(-4)}`).slice(0, 80),
      tokenHash: cred.hash,
      tokenSalt: cred.salt,
      fw: parsed.value.fw,
      model: parsed.value.model,
      caps: parsed.value.caps,
      ip: o.origin.replace(/^http:\/\//, ''),
      lastSeen: 0,
      createdAt: new Date().toISOString(),
    };
    log.info(`adopted node "${node.serial}" (${node.model || 'unknown model'}) at ${node.ip}`);
    // The plaintext token is deliberately NOT returned or logged: it lives only on the
    // node from here on, and we keep just the scrypt hash.
    return { node };
  } catch (err) {
    log.debug(`adopt ${address} failed: ${err instanceof Error ? err.message : err}`);
    return { error: `Could not complete adoption with the node at ${address}.` };
  }
}

/**
 * The WebSocket URL a node should dial to reach this controller.
 *
 * Derived from the request the admin adopted through, because that address is by
 * definition one that reaches us: on a LAN it is the panel's host, and behind the
 * OpenMasjidOS tunnel it is the public hostname (which is what makes a cloud-hosted
 * controller work at all). `NODE_WS_URL` overrides it for split-horizon networks.
 *
 * X-Forwarded-* is trusted ONLY because the platform's ingress sanitises those headers
 * (see CLAUDE.md §4); `trustProxy` must be false when the app is reached directly.
 */
export function controllerWsUrl(headers: Record<string, string | string[] | undefined>): string {
  const override = (process.env.NODE_WS_URL ?? '').trim();
  if (override) return override;
  const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? '' : v ?? '');
  const host = first(headers['x-forwarded-host']).split(',')[0].trim() || first(headers.host);
  if (!host) return '';
  // `x-forwarded-proto` only decides ws:// vs wss://. Worst case a spoofed value makes
  // the node try the wrong scheme and fail loudly at connect time — it leaks nothing and
  // reaches nowhere new — so this needs none of the trust machinery the Fabric guard has.
  const proto = first(headers['x-forwarded-proto']).split(',')[0].trim().toLowerCase();
  const scheme = proto === 'https' ? 'wss' : 'ws';
  // Host may include the tunnel's app-id path prefix upstream of us; NodeHub.matches()
  // accepts one leading segment for exactly that reason.
  return `${scheme}://${host}${NODE_WS_PATH}`;
}
