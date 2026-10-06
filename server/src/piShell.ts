// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * piShell.ts — a real terminal on a Raspberry Pi screen, without anything connecting to the Pi.
 *
 * ## Why it is built inside out
 *
 * The whole Pi feature rests on one property: **nothing ever connects TO a screen.** It sits behind
 * a masjid's NAT on an address DHCP moves, the display server may be in the cloud, and the device
 * holds a capability rather than listening on a port. Every other command works by the device
 * asking us what to do next.
 *
 * An interactive shell cannot be built that way — a keystroke cannot wait for the next five-second
 * poll — so this inverts the direction instead of the rule: the panel MINTS a session, the session
 * is offered to the device on its ordinary state poll, and **the device dials out** to us with the
 * one-time secret it was given. We pair that socket with the admin's browser and copy bytes. No
 * inbound port, no listener on the Pi, no hole in the invariant.
 *
 * ## What holds it shut
 *
 * A remote shell into every masjid's device, reachable through the platform's tunnel, is the most
 * dangerous thing in this app. Six things, and none of them is decoration:
 *
 *  - **In memory only.** Sessions are never written to the store. A session that survived a restart
 *    would be a standing back door nobody remembered opening.
 *  - **The secret only ever goes to the device.** The browser is given the session id and nothing
 *    else, so a compromised panel session cannot impersonate a screen.
 *  - **Both ends are authenticated, differently.** The device presents its token (in the path, the
 *    credential it already has) AND the session secret, compared in constant time, and the session
 *    must belong to that device. The browser presents the admin session cookie.
 *  - **Single use.** A session goes pending → live → closed and never back. A second device attach
 *    is refused, so a replayed secret buys nothing.
 *  - **Bounded three ways**: it must be claimed within a minute, dies after ten idle minutes, and
 *    cannot outlive an hour however busy it is.
 *  - **Unprivileged.** The device runs the shell as its own service account, exactly as the one-shot
 *    console does. The root control spool is not involved and must never be: its verb set is what
 *    makes root's side of a screen simple enough to reason about.
 *
 * Nothing here logs a byte of the session. Not the keystrokes, not the output, not a truncated
 * sample "for debugging" — a terminal transcript is the one thing in this app most likely to
 * contain a password somebody typed.
 */
import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import { makeLog } from './logger';

const log = makeLog('pi-shell');

/** How long the device has to dial in after an admin asks for a terminal. Longer than the poll
 *  interval by a wide margin, short enough that an unclaimed secret is not left lying about. */
export const SHELL_CLAIM_MS = 60_000;
/** No bytes either way for this long and the session closes. */
export const SHELL_IDLE_MS = 10 * 60_000;
/** And it cannot outlive this however busy it is — an admin who walks away mid-session does not
 *  leave a shell open on a masjid's device for the weekend. */
export const SHELL_MAX_MS = 60 * 60_000;

export type ShellState = 'pending' | 'live' | 'closed';

interface Session {
  id: string;
  deviceId: string;
  /** what the DEVICE must present. Never sent to a browser. */
  secret: string;
  rows: number;
  cols: number;
  state: ShellState;
  createdAt: number;
  lastByteAt: number;
  device?: WebSocket;
  admin?: WebSocket;
}

/** Live sessions, by id. In memory, deliberately — see the file header. */
const sessions = new Map<string, Session>();

const now = () => Date.now();
const token = (bytes = 18) => crypto.randomBytes(bytes).toString('base64url');

/** Constant-time compare that is not fooled by a length difference. */
function sameSecret(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Clamp a terminal size the browser asked for. It reaches `stty` on the device, so it is a number
 *  from the network and gets treated as one. */
function clampSize(rows: unknown, cols: unknown): { rows: number; cols: number } {
  const n = (v: unknown, def: number, min: number, max: number) => {
    const x = Math.round(Number(v));
    return Number.isFinite(x) && x >= min && x <= max ? x : def;
  };
  return { rows: n(rows, 24, 8, 200), cols: n(cols, 80, 20, 400) };
}

/**
 * Open a session for a device, replacing any it already had.
 *
 * Replacing rather than refusing: an admin whose browser tab died holds a session the server still
 * thinks is live, and making them wait ten minutes for the idle timer to notice would be answered
 * by reloading the page — which is this call. One shell per screen is the invariant that matters.
 */
export function openShellSession(
  deviceId: string,
  rows: unknown,
  cols: unknown,
): { id: string; secret: string; rows: number; cols: number } {
  for (const s of sessions.values()) {
    if (s.deviceId === deviceId) closeShellSession(s.id, 'replaced by a new session');
  }
  const size = clampSize(rows, cols);
  const s: Session = {
    id: token(),
    deviceId,
    secret: token(24),
    rows: size.rows,
    cols: size.cols,
    state: 'pending',
    createdAt: now(),
    lastByteAt: now(),
  };
  sessions.set(s.id, s);
  log.info(`terminal session opened for pi device ${deviceId}`);
  // The CLAMPED size goes back with it, so the caller cannot hand the device an unbounded one and
  // cannot accidentally hand it a different one from the session it belongs to.
  return { id: s.id, secret: s.secret, rows: s.rows, cols: s.cols };
}

/** What to hand the device on its next state poll, if it has a session waiting to be claimed. */
export function pendingShellFor(deviceId: string): { id: string; secret: string; rows: number; cols: number } | null {
  for (const s of sessions.values()) {
    if (s.deviceId === deviceId && s.state === 'pending' && now() - s.createdAt <= SHELL_CLAIM_MS) {
      return { id: s.id, secret: s.secret, rows: s.rows, cols: s.cols };
    }
  }
  return null;
}

/** Only for the panel: is this session waiting, running, or gone? Carries no secret. */
export function shellSessionState(id: string): ShellState | null {
  return sessions.get(id)?.state ?? null;
}

/**
 * The device dialling in.
 *
 * Everything is checked here rather than trusted from the path: the session has to exist, be
 * pending, belong to THIS device, and the secret has to match. A device that presents a valid token
 * for itself still cannot attach to another screen's session.
 */
export function attachShellDevice(id: string, deviceId: string, secret: string, ws: WebSocket): boolean {
  const s = sessions.get(id);
  if (!s || s.state !== 'pending') return false;
  if (s.deviceId !== deviceId) return false;
  if (now() - s.createdAt > SHELL_CLAIM_MS) {
    closeShellSession(id, 'not claimed in time');
    return false;
  }
  if (!sameSecret(s.secret, secret)) {
    // A wrong secret ends the session rather than allowing another go: the only party who should
    // ever present one is the device we just handed it to.
    closeShellSession(id, 'bad secret');
    return false;
  }
  s.state = 'live';
  s.device = ws;
  s.lastByteAt = now();
  ws.on('message', (data) => pipe(s, s.admin, data));
  ws.on('close', () => closeShellSession(id, 'the screen closed the session'));
  ws.on('error', () => closeShellSession(id, 'the screen dropped'));
  log.info(`terminal attached for pi device ${deviceId}`);
  return true;
}

/** The admin's browser attaching. Authentication is the panel session, checked before we are called. */
export function attachShellAdmin(id: string, ws: WebSocket): boolean {
  const s = sessions.get(id);
  if (!s || s.state === 'closed') return false;
  // Replacing an existing viewer rather than refusing, for the same reason openShellSession
  // replaces: a dead tab must not lock somebody out of their own screen.
  if (s.admin && s.admin !== ws) {
    try {
      s.admin.close(1000, 'replaced');
    } catch {
      /* already gone */
    }
  }
  s.admin = ws;
  s.lastByteAt = now();
  ws.on('message', (data) => pipe(s, s.device, data));
  ws.on('close', () => closeShellSession(id, 'the panel closed the session'));
  ws.on('error', () => closeShellSession(id, 'the panel dropped'));
  return true;
}

/** Copy bytes between the two sockets. Deliberately says nothing about what they contain. */
function pipe(s: Session, to: WebSocket | undefined, data: unknown): void {
  s.lastByteAt = now();
  if (!to) return;
  try {
    // readyState 1 is OPEN. Compared numerically so this module needs no value import from `ws`,
    // which keeps it importable by tests that never open a socket.
    if (to.readyState === 1) to.send(data as Buffer);
  } catch {
    /* the other end went away; the close handler will tidy up */
  }
}

export function closeShellSession(id: string, why: string): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  if (s.state !== 'closed') log.info(`terminal session for pi device ${s.deviceId} ended: ${why}`);
  s.state = 'closed';
  for (const sock of [s.device, s.admin]) {
    try {
      sock?.close(1000, why);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Time out what needs timing out. Called on a timer by the caller that owns the interval, so this
 * module holds no timer of its own and a test can drive it directly.
 */
export function sweepShellSessions(atMs = now()): void {
  for (const s of [...sessions.values()]) {
    if (s.state === 'pending' && atMs - s.createdAt > SHELL_CLAIM_MS) {
      closeShellSession(s.id, 'the screen never picked it up');
    } else if (atMs - s.createdAt > SHELL_MAX_MS) {
      closeShellSession(s.id, 'reached the one-hour limit');
    } else if (s.state === 'live' && atMs - s.lastByteAt > SHELL_IDLE_MS) {
      closeShellSession(s.id, 'idle');
    }
  }
}

/** Test seam, and used when a device is forgotten. */
export function closeShellSessionsFor(deviceId: string, why: string): void {
  for (const s of [...sessions.values()]) if (s.deviceId === deviceId) closeShellSession(s.id, why);
}

/** Test seam. */
export function __shellSessionsForTests(): { id: string; deviceId: string; state: ShellState }[] {
  return [...sessions.values()].map((s) => ({ id: s.id, deviceId: s.deviceId, state: s.state }));
}
