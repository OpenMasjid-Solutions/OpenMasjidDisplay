// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Single-admin auth. The admin account is created in-app on first run (no
 *  install-time password). Password is stored as a scrypt hash in the data
 *  volume; the session is a signed, HTTP-only cookie. */
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const COOKIE = 'omd_session';
const VOL_COOKIE = 'omd_vol';
/**
 * The `Secure` variants get their OWN NAMES, and that is load-bearing.
 *
 * A cookie is identified by (name, domain, path) and IGNORES the port. This app is
 * published on BOTH a TLS-proxied port and a plain-HTTP port of the SAME host —
 * manifest.yaml opts into `https: true` and says in as many words that "The plain HTTP port
 * stays published as a legacy fallback", and the volunteer page is served both on the
 * proxied main port at /volunteer and on its own unproxied HTTP port. Our cookies set no
 * `Domain` and use `Path=/`, so with ONE shared name both entry points contend for a single
 * jar slot.
 *
 * That combination is a trap: once the HTTPS entry point stores a `Secure` cookie, the
 * plain-HTTP entry point can neither receive it NOR replace it, because browsers refuse a
 * non-`Secure` Set-Cookie that would overwrite a `Secure` cookie of the same name/domain/
 * path ("Leave Secure Cookies Alone", RFC 6265bis §5.7 — Chrome/Firefox 52+, Safari). The
 * admin then types the correct password on the HTTP port, gets a 200, and bounces straight
 * back to the login form because the browser silently discarded the new cookie — with no
 * in-app way out, exactly when TLS is broken and the fallback is what they need.
 *
 * Separate names mean the two schemes never collide, so each entry point can always mint
 * and clear its own session. Do not merge them back into one name.
 */
const COOKIE_S = 'omd_session_s';
const VOL_COOKIE_S = 'omd_vol_s';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const VOL_MAX_AGE_MS = 12 * 3600 * 1000; // volunteer sessions are short-lived

// COOKIE_SECURE=yes forces `Secure` on every session cookie regardless of how the request
// arrived. Left as an escape hatch; it is no longer the only way to get `Secure`, because
// in practice nothing ever set it — see isSecureRequest below.
const FORCE_SECURE = (process.env.COOKIE_SECURE ?? '').trim().toLowerCase() === 'yes';

/**
 * Did THIS request arrive over HTTPS? Decided per request rather than per deployment.
 *
 * manifest.yaml opts into `https: true`, so the platform fronts the panel with a TLS
 * proxy — but docker-compose.yml never set COOKIE_SECURE, so the flag was off everywhere
 * and a 30-day admin cookie went out without `Secure`. Cookies aren't isolated by scheme
 * and the plain-HTTP port stays published as a legacy fallback, so that cookie was also
 * sent in cleartext and could be lifted by anyone watching the masjid LAN.
 *
 * Flipping COOKIE_SECURE on globally is NOT the fix: auth.ts has always warned (correctly)
 * that a `Secure` cookie is silently never sent over http, which would lock admins out of
 * the plain-HTTP LAN flow this app ships in. So decide per request instead — HTTPS callers
 * get a `Secure` cookie, plain-HTTP LAN callers keep working exactly as before.
 *
 * X-Forwarded-Proto is trusted only because the OpenMasjidOS ingress sanitises it
 * (CLAUDE.md §4). Reached directly the header is absent. Note the failure direction is
 * safe: a spoofed `https` only ADDS `Secure`, so the spoofer's own cookie stops being sent
 * over http — it can never remove protection or grant access.
 */
export function isSecureRequest(req: IncomingMessage): boolean {
  if (FORCE_SECURE) return true;
  const xfp = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (xfp) return xfp === 'https';
  // `socket` is optional-chained deliberately: hasValidSession() now calls this on EVERY
  // request, and req.socket is null once the socket has been destroyed (an aborted request,
  // or the WebSocket upgrade path). An unguarded dereference here would throw inside the
  // auth check — the very shape of bug DISPLAY-001 was about. Absent socket → not secure,
  // which fails safe (a non-Secure cookie is still usable).
  return (req.socket as { encrypted?: boolean } | null | undefined)?.encrypted === true;
}

const secureAttr = (secure: boolean): string => (secure ? '; Secure' : '');

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(password, salt, 32);
  return { hash: dk.toString('hex'), salt: salt.toString('hex') };
}

export function verifyPassword(password: string, cred: { hash: string; salt: string }): boolean {
  try {
    const dk = crypto.scryptSync(password, Buffer.from(cred.salt, 'hex'), 32);
    const stored = Buffer.from(cred.hash, 'hex');
    return stored.length === dk.length && crypto.timingSafeEqual(stored, dk);
  } catch {
    return false;
  }
}

function hmac(secret: Buffer, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

type Audience = 'admin' | 'vol';

export function makeToken(secret: Buffer, maxAgeMs = MAX_AGE_MS, aud: Audience = 'admin'): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + maxAgeMs, aud })).toString('base64url');
  return `${payload}.${hmac(secret, payload)}`;
}

/** Verify signature, expiry AND audience. The audience binding is what stops a
 *  volunteer token (aud:'vol') from being replayed as an admin cookie (aud:'admin') —
 *  the cookie *name* is not a security boundary on its own. */
function verifyToken(secret: Buffer, token: string, aud: Audience): boolean {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(secret, payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: number; aud?: string };
    return typeof obj.exp === 'number' && obj.exp > Date.now() && obj.aud === aud;
  } catch {
    return false;
  }
}

/** Decode one cookie value, tolerating malformed percent-escapes.
 *
 *  The Cookie header is entirely attacker-controlled and `decodeURIComponent` THROWS a
 *  URIError on input as trivial as `%`. That used to be fatal rather than cosmetic:
 *  hasValidSession() is also called from the WebSocket 'upgrade' listener (see ws.ts),
 *  and a throw inside an event listener is an uncaught exception that takes the whole
 *  process down — an unauthenticated remote kill of every screen in the masjid.
 *  A value that isn't valid percent-encoding is used verbatim; it simply won't verify. */
function decodeCookieValue(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeCookieValue(part.slice(i + 1).trim());
  }
  return out;
}

/** Names to look for, in order, for a request of this scheme. Over HTTPS the plain-named
 *  cookie is also accepted, so a session started on the legacy HTTP port keeps working when
 *  the admin moves to the TLS port. Over plain HTTP the `Secure` cookie is never sent by the
 *  browser at all, so there is nothing extra to consider. */
const namesFor = (base: string, secureName: string, secure: boolean): string[] =>
  secure ? [secureName, base] : [base];

/** A valid, unexpired session cookie. (The caller separately checks that an
 *  admin account exists — before setup, nobody is authed.) */
export function hasValidSession(req: IncomingMessage, secret: Buffer): boolean {
  const jar = parseCookies(req.headers.cookie);
  return namesFor(COOKIE, COOKIE_S, isSecureRequest(req)).some(
    (n) => !!jar[n] && verifyToken(secret, jar[n], 'admin'),
  );
}

/** @param secure add `Secure` AND use the Secure cookie name — pass isSecureRequest(req),
 *  so an HTTPS caller's cookie is protected while the plain-HTTP flow keeps its own. */
export function setCookieHeader(token: string, maxAgeMs = MAX_AGE_MS, secure = FORCE_SECURE): string {
  const name = secure ? COOKIE_S : COOKIE;
  return `${name}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}${secureAttr(secure)}`;
}

/** Clear EVERY name this scheme could have authenticated with, so a logout is never
 *  partial. Returns an array — `res.setHeader('set-cookie', …)` accepts one. */
export function clearCookieHeader(secure = FORCE_SECURE): string[] {
  const gone = (name: string, sec: boolean) =>
    `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureAttr(sec)}`;
  // Over HTTPS hasValidSession accepts either name, so both must go. Over plain HTTP the
  // Secure cookie is neither sent nor clearable (and cannot authenticate), so leave it.
  return secure ? [gone(COOKIE_S, true), gone(COOKIE, false)] : [gone(COOKIE, false)];
}

// ── Volunteer session (separate cookie + audience from the admin) ─────────────
export function makeVolunteerToken(secret: Buffer): string {
  return makeToken(secret, VOL_MAX_AGE_MS, 'vol');
}

export function hasValidVolunteerSession(req: IncomingMessage, secret: Buffer): boolean {
  const jar = parseCookies(req.headers.cookie);
  return namesFor(VOL_COOKIE, VOL_COOKIE_S, isSecureRequest(req)).some(
    (n) => !!jar[n] && verifyToken(secret, jar[n], 'vol'),
  );
}

export function setVolunteerCookieHeader(token: string, secure = FORCE_SECURE): string {
  const name = secure ? VOL_COOKIE_S : VOL_COOKIE;
  return `${name}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(VOL_MAX_AGE_MS / 1000)}${secureAttr(secure)}`;
}

export function clearVolunteerCookieHeader(secure = FORCE_SECURE): string[] {
  const gone = (name: string, sec: boolean) =>
    `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureAttr(sec)}`;
  return secure ? [gone(VOL_COOKIE_S, true), gone(VOL_COOKIE, false)] : [gone(VOL_COOKIE, false)];
}
