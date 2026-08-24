// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * fabricInbound.ts — the envelope every INBOUND Fabric request has to get through.
 *
 * Almost every Fabric call this app makes goes outward: we present our secret to
 * OpenMasjidOS. A small number come the other way, and they share exactly one property —
 * the platform presents *our own* `OPENMASJID_APP_SECRET` back to us. There are two of them
 * and they are NOT the same trust boundary, which is the reason this file holds primitives
 * rather than one blanket check:
 *
 *  - `POST /fabric/commands/run` — the PLATFORM asking us to run an admin's WhatsApp command.
 *    It can write prayer times. Its caller is always `omos:platform`, a value no app id can be.
 *    See fabricCommands.ts; it composes its own envelope from the helpers here.
 *  - `POST /fabric/timetable/{list,get}` — ANOTHER APP reading our timetable through the
 *    app-to-app broker. Read-only, and the caller is a real app id. See fabricTimetable.ts.
 *
 * The one thing they must never share is a handler. A capability in `fabric.provides` is
 * reachable by any app the admin granted it to; the commands route is reachable only by the
 * platform. They sit under the same `/fabric/` prefix and that prefix is not a permission.
 */
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Compare two secrets without leaking their contents through timing. Lengths are compared
 * first because timingSafeEqual throws on a mismatch — and the length of a secret is not
 * what an attacker is missing.
 */
export function secretMatches(presented: string | undefined, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** One header value, flattened — Node hands back an array for repeated headers. */
export function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The path as it arrived ON THE WIRE, with any query or fragment removed — and deliberately
 * NOT normalised.
 *
 * This exists because the router's `pathname` is not the request line. api.ts derives it with
 * `new URL(req.url, …)`, and that normalises far more than one dot-dot. Every one of these
 * arrives with `pathname === '/fabric/timetable/list'`, i.e. matches an "exact path" route:
 *
 *     /display/../fabric/timetable/list          the obvious one
 *     /display/%2e%2e/fabric/timetable/list      %2e IS a dot to the URL spec's path parser,
 *     /display/.%2e/fabric/timetable/list          in either case, mixed either way
 *     /x/y/../../fabric/timetable/list           any depth
 *     http://evil.example/fabric/timetable/list  absolute-form target: only the path survives
 *     //evil.example/fabric/timetable/list       protocol-relative: segment 1 becomes the host
 *     \fabric/timetable/list                     a backslash is a separator
 *
 * A blocklist of those is a losing game. Comparing the RAW target wins structurally instead:
 * the tunnel does not strip the `/<basePath>/` prefix, so anything it can deliver is a longer
 * string than the bare path, and every trick above is a rewrite of the prefix rather than a way
 * to remove it. There is no spelling of a tunnelled request that equals the exact path.
 *
 * A query string is tolerated, deliberately — the check is about the path, and refusing one
 * would be a brittle way to break if the platform ever appended a trace id.
 */
export function rawPath(req: IncomingMessage): string {
  const raw = req.url ?? '';
  const cut = raw.search(/[?#]/);
  return cut === -1 ? raw : raw.slice(0, cut);
}

/** App ids are lowercase and hyphenated; `omos:platform` is the platform's own reserved form.
 *  Bounded, because this value is caller-supplied and ends up in a log line. */
const CALLER_SHAPE = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

/** A caller id rendered safe to log: metadata only, never echoed to the caller. */
export function safeCaller(v: string | undefined): string {
  if (!v) return '(none)';
  return CALLER_SHAPE.test(v) ? v : '(malformed)';
}

export type EnvelopeResult =
  | { ok: true; caller: string }
  | { ok: false; status: number; error: string; caller: string };

/**
 * The envelope for a capability served through the **app-to-app broker**.
 *
 * What each test is actually for, because only one of them is the authentication:
 *
 *  - **The secret is the authentication.** It proves the call came through the platform rather
 *    than straight off the network at our container, and it is compared in constant time.
 *  - **The path is the authorisation.** The broker maps
 *    `/api/fabric/app/display/<capability>/<method>` onto `/fabric/<capability>/<method>`, so
 *    the capability the admin granted IS the path segment. A grant for one capability cannot
 *    reach another's handler. That is why the grant list lives with the platform and there is
 *    deliberately no second allow-list here: a copy of it would only ever drift.
 *  - **The exact raw path is the LAN-only rule.** Not a header — see `rawPath`. Anything the
 *    tunnel could deliver is a different string, and this is checked BEFORE the secret so a
 *    probe from outside never reaches the comparison at all.
 *  - **The caller id is neither.** Anything holding the secret can spell it however it likes,
 *    so it buys no security; it is required because a genuine broker call always carries it,
 *    and it is kept because a refusal is worth nothing in a log without knowing who was asking.
 *    It is checked for SHAPE only, never against a list of apps we expect — a route that
 *    refused a caller the platform legitimately started using would fail closed and silently.
 */
export function checkBrokerEnvelope(req: IncomingMessage, exactPath: string, expectedSecret: string): EnvelopeResult {
  const caller = safeCaller(header(req, 'x-openmasjid-caller-app'));
  // No secret of our own yet means we cannot authenticate anybody, so the capability stays
  // shut rather than open. 503 is the contract's "still starting up", which is accurate: this
  // app is not connected to OpenMasjidOS yet and the platform should retry, not give up.
  if (!expectedSecret) return { ok: false, status: 503, error: 'not_ready', caller };
  // `rawPath`, NOT `new URL(...).pathname`. Rewriting this line to use the parsed pathname
  // silently re-opens every shape in the table on `rawPath` above, because that is the very
  // normalisation the router already did before this route matched. The test file fails if it is.
  if (rawPath(req) !== exactPath) return { ok: false, status: 403, error: 'forbidden', caller };
  if (!secretMatches(header(req, 'x-openmasjid-app-secret'), expectedSecret)) {
    return { ok: false, status: 403, error: 'forbidden', caller };
  }
  // Deliberately not "which one was wrong".
  if (caller === '(none)' || caller === '(malformed)') return { ok: false, status: 403, error: 'forbidden', caller };
  return { ok: true, caller };
}
