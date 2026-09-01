// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Which install command the dashboard offers to copy.
 *
 * This exists because of a real failure on real hardware: the display server was reached at
 * `https://192.168.1.18:8444` behind a self-signed certificate, `curl` refused it, and the
 * one-line install died at the first hop with an error that reads like the server is broken.
 *
 * No public certificate authority will ever issue for a private address, so on those addresses
 * the first fetch simply cannot be verified. The command has to say so — and, just as important,
 * must NOT say so anywhere else, because pasting `-k` into `sudo sh` out of habit is precisely
 * the thing worth avoiding.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateHostname, installCommand } from './lanHost';

test('a masjid LAN address cannot have a publicly-signed certificate', () => {
  for (const h of [
    '192.168.1.18', // the address this was actually found on
    '10.0.0.5',
    '172.16.4.1',
    '172.31.255.254',
    '127.0.0.1',
    '169.254.1.1',
    '100.64.0.1', // CGNAT, which some routers hand out
    'display.local',
    'raspberrypi',
    'omos.lan',
    'localhost',
    '[fe80::1]',
  ]) {
    assert.equal(isPrivateHostname(h), true, h);
  }
});

test('a real domain is left alone', () => {
  // Reached through the platform's remote access, the certificate is genuine and must be checked.
  for (const h of ['masjid.example', 'display.masjid.org', 'a.b.c.example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1']) {
    assert.equal(isPrivateHostname(h), false, h);
  }
});

test('an address that is not a real IPv4 is judged by its name, not its digits', () => {
  // 999.1.1.1 is not an address; it is a (silly) hostname with dots, so it is not "private".
  assert.equal(isPrivateHostname('999.1.1.1'), false);
});

test('the command verifies by default', () => {
  const r = installCommand('https://masjid.example');
  assert.equal(r.command, 'curl -fsSL https://masjid.example/pi.sh | sudo sh');
  assert.equal(r.insecureFirstHop, false);
});

test('plain HTTP needs no -k — there is no certificate to refuse', () => {
  const r = installCommand('http://192.168.1.18:7860');
  assert.equal(r.command, 'curl -fsSL http://192.168.1.18:7860/pi.sh | sudo sh');
  assert.equal(r.insecureFirstHop, false);
});

test('HTTPS on a LAN address gets -k, and says it did', () => {
  // The exact case from the failing Pi.
  const r = installCommand('https://192.168.1.18:8444');
  assert.equal(r.command, 'curl -fsSLk https://192.168.1.18:8444/pi.sh | sudo sh');
  assert.equal(r.insecureFirstHop, true, 'the panel must be able to explain itself');
});

test('a tunnel prefix is preserved', () => {
  assert.equal(
    installCommand('https://masjid.example/display').command,
    'curl -fsSL https://masjid.example/display/pi.sh | sudo sh',
  );
});

test('a trailing slash does not become a double slash', () => {
  assert.equal(installCommand('http://h:7860/').command, 'curl -fsSL http://h:7860/pi.sh | sudo sh');
});

test('an unparseable origin falls back to verifying', () => {
  // Fail towards checking the certificate, never towards skipping the check.
  assert.equal(installCommand('not a url').insecureFirstHop, false);
});
