// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A remote shell into every masjid's screen is the most dangerous thing in this app.
 *
 * It is reachable through the platform's tunnel, it runs on a device nobody is watching, and the
 * thing it carries is a terminal — so what is tested here is not "does it work" but every way it
 * must refuse. Each test below is a way in that has to stay shut.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { WebSocket } from 'ws';
import {
  openShellSession,
  pendingShellFor,
  attachShellDevice,
  attachShellAdmin,
  closeShellSession,
  closeShellSessionsFor,
  sweepShellSessions,
  shellSessionState,
  SHELL_CLAIM_MS,
  SHELL_IDLE_MS,
  SHELL_MAX_MS,
  __shellSessionsForTests,
} from './piShell';

/** A socket that records what it was sent and whether it was closed. */
function fakeSocket() {
  const sent: unknown[] = [];
  const handlers = new Map<string, (arg?: unknown) => void>();
  let closed: string | null = null;
  const ws = {
    readyState: 1,
    send: (d: unknown) => sent.push(d),
    close: (_code?: number, why?: string) => {
      closed = why ?? '';
    },
    on: (ev: string, fn: (arg?: unknown) => void) => {
      handlers.set(ev, fn);
      return ws;
    },
  };
  return {
    ws: ws as unknown as WebSocket,
    sent,
    closed: () => closed,
    fire: (ev: string, arg?: unknown) => handlers.get(ev)?.(arg),
  };
}

function reset() {
  for (const s of __shellSessionsForTests()) closeShellSession(s.id, 'test reset');
}

// ── the secret ──────────────────────────────────────────────────────────────

test('the browser is never given the secret the device must present', () => {
  reset();
  // openShellSession returns it because the API route has to put it on the COMMAND for the device.
  // What matters is that the two are different values and only one is device-bound; the route hands
  // back the id alone, and this is the test that says so about the pieces it is built from.
  const { id, secret } = openShellSession('pi_a', 24, 80);
  assert.notEqual(id, secret);
  assert.ok(secret.length >= 24, 'a guessable secret would make the id enough on its own');
  // And a session's state is readable without it — that is all the panel needs to poll.
  assert.equal(shellSessionState(id), 'pending');
});

test('a wrong secret does not get a second try — it ends the session', () => {
  reset();
  const { id } = openShellSession('pi_a', 24, 80);
  const bad = fakeSocket();
  assert.equal(attachShellDevice(id, 'pi_a', 'not-the-secret', bad.ws), false);
  assert.equal(shellSessionState(id), null, 'the session is gone, so guessing again is pointless');
});

test('the secret is compared without leaking its length', () => {
  reset();
  const { id, secret } = openShellSession('pi_a', 24, 80);
  const short = fakeSocket();
  // A length-only mismatch must be refused like any other, not throw out of timingSafeEqual —
  // which is what happens if two different-length buffers reach it.
  assert.doesNotThrow(() => attachShellDevice(id, 'pi_a', secret.slice(0, 4), short.ws));
  assert.equal(shellSessionState(id), null);
});

// ── who may attach ──────────────────────────────────────────────────────────

test("a device cannot attach to another screen's session", () => {
  reset();
  const { id, secret } = openShellSession('pi_a', 24, 80);
  const other = fakeSocket();
  // pi_b holds a perfectly valid token for ITSELF — the route resolved it — and still gets nothing.
  assert.equal(attachShellDevice(id, 'pi_b', secret, other.ws), false);
  assert.equal(shellSessionState(id), 'pending', 'and pi_a can still claim its own session');
  const mine = fakeSocket();
  assert.equal(attachShellDevice(id, 'pi_a', secret, mine.ws), true);
});

test('a session can only be claimed once', () => {
  reset();
  const { id, secret } = openShellSession('pi_a', 24, 80);
  const first = fakeSocket();
  const replay = fakeSocket();
  assert.equal(attachShellDevice(id, 'pi_a', secret, first.ws), true);
  // A replayed secret — captured off the wire, or a second agent process — buys nothing.
  assert.equal(attachShellDevice(id, 'pi_a', secret, replay.ws), false);
});

test('an unknown session id is refused, for either end', () => {
  reset();
  const s = fakeSocket();
  assert.equal(attachShellDevice('no-such-session', 'pi_a', 'x', s.ws), false);
  assert.equal(attachShellAdmin('no-such-session', s.ws), false);
});

// ── the three clocks ────────────────────────────────────────────────────────

test('a session nobody picks up is swept', () => {
  reset();
  const { id } = openShellSession('pi_a', 24, 80);
  sweepShellSessions(Date.now() + SHELL_CLAIM_MS - 1000);
  assert.equal(shellSessionState(id), 'pending', 'not before its minute is up');
  sweepShellSessions(Date.now() + SHELL_CLAIM_MS + 1000);
  assert.equal(shellSessionState(id), null, 'an unclaimed secret must not lie about');
});

test('a claimed session cannot be claimed late either', () => {
  reset();
  const { id, secret } = openShellSession('pi_a', 24, 80);
  // Simulate a device that polled, went away, and came back much later with the same secret.
  sweepShellSessions(Date.now() + SHELL_CLAIM_MS + 1000);
  const late = fakeSocket();
  assert.equal(attachShellDevice(id, 'pi_a', secret, late.ws), false);
});

test('an idle session closes', () => {
  reset();
  const { id, secret } = openShellSession('pi_a', 24, 80);
  const dev = fakeSocket();
  const adm = fakeSocket();
  attachShellDevice(id, 'pi_a', secret, dev.ws);
  attachShellAdmin(id, adm.ws);
  sweepShellSessions(Date.now() + SHELL_IDLE_MS - 1000);
  assert.equal(shellSessionState(id), 'live');
  sweepShellSessions(Date.now() + SHELL_IDLE_MS + 1000);
  assert.equal(shellSessionState(id), null);
});

test('typing keeps it alive; the hour does not care', () => {
  reset();
  const { id, secret } = openShellSession('pi_a', 24, 80);
  const dev = fakeSocket();
  const adm = fakeSocket();
  attachShellDevice(id, 'pi_a', secret, dev.ws);
  attachShellAdmin(id, adm.ws);
  // A keystroke resets the idle clock…
  adm.fire('message', Buffer.from('ls\n'));
  sweepShellSessions(Date.now() + SHELL_IDLE_MS - 500);
  assert.equal(shellSessionState(id), 'live');
  // …but nothing resets the hard cap. An admin who wanders off mid-session does not leave a shell
  // open on a masjid's device for the weekend.
  sweepShellSessions(Date.now() + SHELL_MAX_MS + 1000);
  assert.equal(shellSessionState(id), null);
});

// ── one shell per screen ────────────────────────────────────────────────────

test('opening a session replaces the screen\'s previous one', () => {
  reset();
  const first = openShellSession('pi_a', 24, 80);
  const dev = fakeSocket();
  attachShellDevice(first.id, 'pi_a', first.secret, dev.ws);
  const second = openShellSession('pi_a', 24, 80);
  assert.equal(shellSessionState(first.id), null, 'the old one is closed, not left running');
  assert.equal(shellSessionState(second.id), 'pending');
  assert.equal(__shellSessionsForTests().filter((s) => s.deviceId === 'pi_a').length, 1);
});

test('forgetting a screen ends any shell on it', () => {
  reset();
  const { id, secret } = openShellSession('pi_a', 24, 80);
  attachShellDevice(id, 'pi_a', secret, fakeSocket().ws);
  closeShellSessionsFor('pi_a', 'forgotten');
  assert.equal(shellSessionState(id), null);
});

// ── what the device is told ─────────────────────────────────────────────────

test('a device is only offered its own pending session, and only while it is claimable', () => {
  reset();
  const a = openShellSession('pi_a', 40, 120);
  assert.equal(pendingShellFor('pi_b'), null, 'not another screen\'s');
  const offer = pendingShellFor('pi_a');
  assert.equal(offer?.id, a.id);
  assert.equal(offer?.rows, 40);
  assert.equal(offer?.cols, 120);
  // Once claimed there is nothing left to offer, so a device that polls twice does not dial in twice.
  attachShellDevice(a.id, 'pi_a', a.secret, fakeSocket().ws);
  assert.equal(pendingShellFor('pi_a'), null);
});

test('a terminal size from the network is clamped before it reaches stty', () => {
  reset();
  for (const [rows, cols] of [[0, 0], [-5, -5], [99999, 99999], ['big', 'big'], [NaN, NaN]] as [unknown, unknown][]) {
    const s = openShellSession('pi_clamp', rows, cols);
    const offer = pendingShellFor('pi_clamp');
    assert.ok(offer, 'a session was made');
    assert.ok(offer.rows >= 8 && offer.rows <= 200, `rows ${offer.rows} out of range`);
    assert.ok(offer.cols >= 20 && offer.cols <= 400, `cols ${offer.cols} out of range`);
    closeShellSession(s.id, 'done');
  }
});

// ── the bytes ───────────────────────────────────────────────────────────────

test('bytes are copied between the two ends and nowhere else', () => {
  reset();
  const { id, secret } = openShellSession('pi_a', 24, 80);
  const dev = fakeSocket();
  const adm = fakeSocket();
  attachShellDevice(id, 'pi_a', secret, dev.ws);
  attachShellAdmin(id, adm.ws);
  adm.fire('message', Buffer.from('whoami\n'));
  assert.deepEqual(dev.sent.map(String), ['whoami\n'], 'keystrokes reach the screen');
  dev.fire('message', Buffer.from('omdscreen\n'));
  assert.deepEqual(adm.sent.map(String), ['omdscreen\n'], 'output reaches the panel');
});

test('either end hanging up ends the session', () => {
  reset();
  for (const who of ['device', 'admin'] as const) {
    const { id, secret } = openShellSession('pi_a', 24, 80);
    const dev = fakeSocket();
    const adm = fakeSocket();
    attachShellDevice(id, 'pi_a', secret, dev.ws);
    attachShellAdmin(id, adm.ws);
    (who === 'device' ? dev : adm).fire('close');
    assert.equal(shellSessionState(id), null, `${who} closing must end it`);
  }
});

// ── and it must not be written down ─────────────────────────────────────────

test('sessions are held in memory and nothing else', () => {
  // A session that survived a restart would be a standing back door nobody remembered opening, so
  // this module must not reach the store at all.
  const src = fs.readFileSync(path.resolve(__dirname, 'piShell.ts'), 'utf8');
  assert.ok(!/from '\.\/store'/.test(src), 'piShell must not import the store');
  assert.ok(!/writeFile|readFile/.test(src), 'and must not touch the filesystem');
});

test('nothing in the session is logged', () => {
  // A terminal transcript is the likeliest thing in this app to contain a password somebody typed.
  const src = fs.readFileSync(path.resolve(__dirname, 'piShell.ts'), 'utf8');
  const logged = [...src.matchAll(/log\.[a-z]+\(([^\n]*)\)/g)].map((m) => m[1]);
  assert.ok(logged.length > 0, 'it does log session lifecycle');
  for (const line of logged) {
    assert.ok(!/\bdata\b/.test(line), `a log line references the payload: ${line}`);
  }
});
