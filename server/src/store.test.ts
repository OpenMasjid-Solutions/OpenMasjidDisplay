// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** The session-cookie secret must fail CLOSED when its file is damaged.
 *
 *  DISPLAY-003: loadSecret() did not check the length of what it read.
 *  Buffer.from(s, 'hex') does not throw on malformed input — it silently returns a short
 *  or EMPTY buffer — and crypto.createHmac accepts a zero-length key. So a session.secret
 *  truncated by a power cut, a full disk or a partial restore left the app signing cookies
 *  with a key every attacker also knows, and anyone could mint an admin session. */
import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

// config reads DATA_DIR at import time, so it must be set BEFORE store/config load.
// Static imports are hoisted above this assignment, so these two are require()d instead
// (this package is CommonJS — top-level await is not available here).
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-store-test-'));
process.env.DATA_DIR = DIR;

const { Store } = require('./store') as typeof import('./store');
const { hasValidSession } = require('./auth') as typeof import('./auth');

const SECRET_FILE = path.join(DIR, 'session.secret');
const reqWith = (cookie: string) => ({ headers: { cookie } }) as unknown as IncomingMessage;

/** Mint an admin token the way auth.ts does, with a chosen key. */
function tokenSignedWith(key: Buffer): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 3_600_000, aud: 'admin' })).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

test('a fresh install writes a full-length secret', () => {
  const store = new Store();
  assert.ok(store.secret.length >= 32, `secret too short: ${store.secret.length}`);
  assert.equal(fs.readFileSync(SECRET_FILE, 'utf8').trim().length, 64, 'expected 32 bytes as hex');
});

test('a VALID secret is reused across restarts (must not sign everyone out)', () => {
  const first = new Store().secret.toString('hex');
  const second = new Store().secret.toString('hex');
  assert.equal(second, first, 'a healthy secret must survive a restart');
});

test('a damaged secret is replaced, and a token forged with an empty key is refused', () => {
  // Each of these used to decode to a zero-length or too-short HMAC key.
  for (const damaged of ['', '   ', '\n', 'zzzz', 'ab', 'abcd', 'not-hex-at-all', 'a'.repeat(63)]) {
    fs.writeFileSync(SECRET_FILE, damaged);
    const store = new Store();

    assert.ok(store.secret.length >= 32, `short secret accepted for input ${JSON.stringify(damaged)}`);
    // The decisive check: the exploit token, signed with an empty key, must not authenticate.
    const forged = tokenSignedWith(Buffer.alloc(0));
    assert.equal(
      hasValidSession(reqWith(`omd_session=${forged}`), store.secret),
      false,
      `empty-key forgery accepted for input ${JSON.stringify(damaged)}`,
    );
    // Nor may a token signed with the damaged bytes themselves.
    const forged2 = tokenSignedWith(Buffer.from(damaged.trim(), 'hex'));
    assert.equal(hasValidSession(reqWith(`omd_session=${forged2}`), store.secret), false);
    // A token signed with the REAL new secret still works, so auth isn't simply broken.
    assert.equal(hasValidSession(reqWith(`omd_session=${tokenSignedWith(store.secret)}`), store.secret), true);
    // The repaired secret is persisted, so the next restart is stable.
    assert.equal(fs.readFileSync(SECRET_FILE, 'utf8').trim().length, 64);
  }
});

test('the secret is written atomically (no .tmp left behind)', () => {
  fs.writeFileSync(SECRET_FILE, ''); // force a regeneration
  new Store();
  assert.ok(!fs.existsSync(`${SECRET_FILE}.tmp`), 'temp file should have been renamed away');
});

test('session.secret is not group/other-readable', { skip: process.platform === 'win32' ? 'POSIX modes only' : false }, () => {
  fs.writeFileSync(SECRET_FILE, ''); // force a regeneration through the write path
  new Store();
  const mode = fs.statSync(SECRET_FILE).mode & 0o077;
  assert.equal(mode, 0, `session.secret is group/other-accessible (mode ${mode.toString(8)})`);
});
