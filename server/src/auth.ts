// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Single-admin auth. The admin account is created in-app on first run (no
 *  install-time password). Password is stored as a scrypt hash in the data
 *  volume; the session is a signed, HTTP-only cookie. */
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const COOKIE = 'omd_session';
const VOL_COOKIE = 'omd_vol';
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
  return (req.socket as { encrypted?: boolean }).encrypted === true;
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

/** A valid, unexpired session cookie. (The caller separately checks that an
 *  admin account exists — before setup, nobody is authed.) */
export function hasValidSession(req: IncomingMessage, secret: Buffer): boolean {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  return !!token && verifyToken(secret, token, 'admin');
}

/** @param secure add `Secure` — pass isSecureRequest(req) so an HTTPS caller's cookie is
 *  protected while the plain-HTTP LAN flow keeps working. */
export function setCookieHeader(token: string, maxAgeMs = MAX_AGE_MS, secure = FORCE_SECURE): string {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}${secureAttr(secure)}`;
}

export function clearCookieHeader(secure = FORCE_SECURE): string {
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureAttr(secure)}`;
}

// ── Volunteer session (separate cookie + audience from the admin) ─────────────
export function makeVolunteerToken(secret: Buffer): string {
  return makeToken(secret, VOL_MAX_AGE_MS, 'vol');
}

export function hasValidVolunteerSession(req: IncomingMessage, secret: Buffer): boolean {
  const token = parseCookies(req.headers.cookie)[VOL_COOKIE];
  return !!token && verifyToken(secret, token, 'vol');
}

export function setVolunteerCookieHeader(token: string, secure = FORCE_SECURE): string {
  return `${VOL_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(VOL_MAX_AGE_MS / 1000)}${secureAttr(secure)}`;
}

export function clearVolunteerCookieHeader(secure = FORCE_SECURE): string {
  return `${VOL_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureAttr(secure)}`;
}
