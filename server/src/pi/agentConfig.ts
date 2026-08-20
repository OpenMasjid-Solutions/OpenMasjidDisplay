// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * pi/agentConfig.ts — the four things the agent has to remember across a reboot.
 *
 * A masjid's screen loses power. It is on a shelf behind a television, on the same circuit as
 * the lights, and it will be switched off at the wall more often than it is ever rebooted
 * deliberately. So everything that would otherwise have to be set up again by a human lives in
 * one small file, and losing it is the only thing that sends someone back to the television with
 * a code to read.
 *
 * The file holds a credential, which is why it is written 0600 and why the token is only ever
 * added to it — never logged, never sent anywhere but back to the server that issued it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CONFIG_DIR = '/etc/openmasjid-screen';

/**
 * Where the config lives.
 *
 * Overridable so the agent can be run against a development server from a checkout, on a machine
 * that has neither /etc/openmasjid-screen nor a framebuffer. On a real Pi the variable is unset
 * and this is the only path ever used — the systemd unit grants write access to that one
 * directory and nothing else, so a redirected config would not be writable there anyway.
 */
export const CONFIG_PATH = process.env.OMD_SCREEN_CONFIG || `${CONFIG_DIR}/config.json`;

export interface AgentConfig {
  /** the display server's origin, baked in by the installer from the URL it was fetched from */
  server: string;
  /** stable across reboots so a power cut does not create a second pending device */
  deviceId: string;
  /** proves this Pi is the one that enrolled under that id — see piAgent.ts */
  deviceSecret: string;
  /** issued on adoption; absent until then */
  token?: string;
}

/**
 * Read a config object out of untrusted text.
 *
 * Separate from the file reading so the validation is testable, and strict about the server URL
 * in particular: it is the one field that decides where this device sends its identity, and a
 * malformed one should stop the agent with a message on the screen rather than have it try.
 */
export function parseConfig(text: string): AgentConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const server = typeof o.server === 'string' ? o.server.trim().replace(/\/+$/, '') : '';
  if (!/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(server)) return null;

  const deviceId = typeof o.deviceId === 'string' ? o.deviceId.trim() : '';
  const deviceSecret = typeof o.deviceSecret === 'string' ? o.deviceSecret.trim() : '';
  const token = typeof o.token === 'string' && o.token.trim() ? o.token.trim() : undefined;

  return { server, deviceId, deviceSecret, ...(token ? { token } : {}) };
}

export function loadConfig(file = CONFIG_PATH): AgentConfig | null {
  try {
    return parseConfig(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write the config back.
 *
 * Through a temporary file and a rename, because the one moment this is written is right after
 * adoption — and a power cut mid-write would leave a truncated file, which reads as "never
 * adopted" and sends someone back to the television for a code that has already been used.
 */
export function saveConfig(cfg: AgentConfig, file = CONFIG_PATH): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // MERGED, not overwritten. Two reasons, and the second one has already cost a real screen.
  //
  // `parseConfig` deliberately returns only the fields it understands, so writing that object
  // straight back deletes everything else in the file — including anything a future version of
  // the installer leaves for something other than the agent to read. That is not hypothetical:
  // an install-time trust setting stored here was destroyed by the first adoption, minutes after
  // setup, which silently stopped the device updating itself for good.
  //
  // It also means a transient read failure cannot blank the device's identity. Writing
  // `{...loadConfig(), token}` when the load returned nothing would leave a config with a token
  // and no device id, which is unrecoverable without walking to the television.
  let existing: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) existing = raw as Record<string, unknown>;
  } catch {
    /* no file yet, or unreadable — start from nothing rather than refusing to save */
  }

  const merged: Record<string, unknown> = { ...existing, ...cfg };
  // An absent token means "forgotten", which has to be able to REMOVE the key rather than leave
  // the old one behind — the one field where merging would be wrong.
  if (cfg.token === undefined) delete merged.token;

  // Write, FLUSH, rename, flush the directory. All four steps, and the flushes are the point.
  //
  // Write-then-rename gives ordering: nobody ever reads a half-written config. It does NOT give
  // durability. On ext4 in ordered-data mode the rename is journalled while the temp file's
  // contents may still be sitting in the page cache, so a power cut in that window leaves a
  // zero-length config.json — atomically replacing a good file with an empty one.
  //
  // That is not a theoretical window on this device. A screen on a wall is switched off at the
  // socket, so an unclean shutdown is its NORMAL shutdown, and the same mechanism was caught
  // destroying a Wi-Fi profile on a real Pi 4 — 0 bytes on disk, "orphan cleanup" in dmesg, the
  // saved network simply gone. This file holds the device TOKEN, so the same accident costs
  // somebody a walk to the television to read a new pairing code off it.
  //
  // The directory flush matters as much as the file one: without it the rename itself can be lost,
  // and the config reverts to whatever it was before.
  const tmp = `${file}.tmp`;
  const body = `${JSON.stringify(merged, null, 2)}\n`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dir = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } catch {
    // Not every filesystem lets you fsync a directory. The config is already written and renamed
    // by this point, so a refusal here costs durability of the rename and nothing else — far
    // better than throwing away a save that has otherwise succeeded.
  }
}

/** A device secret: 16 random bytes, url-safe. Not a password — nothing here derives it from
 *  anything a person chose, which is why the server can store a plain SHA-256 of it. */
export function makeDeviceSecret(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/** A device id that says what it is in a log line, with enough randomness that two Pis set up
 *  from the same image do not collide. */
export function makeDeviceId(): string {
  return `pi_${crypto.randomBytes(6).toString('hex')}`;
}
