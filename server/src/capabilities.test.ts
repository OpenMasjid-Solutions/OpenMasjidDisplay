// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The capability contract between the two hosts.
 *
 * The point of this file is drift. One web app serves an OpenMasjidOS server and a Raspberry Pi,
 * and the only thing separating them is this object — so the failure that matters is not a wrong
 * value, it is a capability added to one profile and forgotten in the other. That is invisible in
 * review (both diffs look fine on their own) and shows up as a page that renders on one host and
 * throws on the other.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVER_CAPABILITIES, PI_CAPABILITIES, capabilitiesFor, type Capabilities } from './capabilities';

test('both hosts answer the same questions', () => {
  // Not deepEqual — the VALUES must differ. It is the key sets that have to match, so a new
  // capability cannot be added to one profile and left off the other.
  assert.deepEqual(Object.keys(SERVER_CAPABILITIES).sort(), Object.keys(PI_CAPABILITIES).sort());
});

test('every OpenMasjidOS-only feature is off on a Pi', () => {
  // The brief's list, written out rather than derived, so that adding a capability does not
  // silently join it. A Pi has no platform to sign in through, no gateway to send through and
  // nowhere to send an alert.
  const omosOnly: (keyof Capabilities)[] = ['whatsapp', 'companion', 'sso', 'notifications', 'widget', 'terminal', 'remoteAccess'];
  for (const k of omosOnly) {
    assert.equal(PI_CAPABILITIES[k], false, `${k} must be off on a Pi`);
    assert.equal(SERVER_CAPABILITIES[k], true, `${k} must be on for the server`);
  }
});

test('a Pi manages one screen; the server manages a fleet', () => {
  assert.equal(PI_CAPABILITIES.screens, 'self');
  assert.equal(SERVER_CAPABILITIES.screens, 'fleet');
});

test('nothing is left to a default', () => {
  // An undefined capability reads as false in the panel, which would hide a feature the host
  // actually has — and would do it silently, on one host only.
  for (const caps of [SERVER_CAPABILITIES, PI_CAPABILITIES]) {
    for (const [k, v] of Object.entries(caps)) assert.notEqual(v, undefined, `${caps.host}.${k}`);
  }
});

test('the host picks its own profile', () => {
  assert.equal(capabilitiesFor('server'), SERVER_CAPABILITIES);
  assert.equal(capabilitiesFor('pi'), PI_CAPABILITIES);
});

test('the server profile is what the server has always done', () => {
  // Phase 1 must change nothing a masjid sees. If this profile ever reports a feature off, the
  // panel loses it — so the no-behaviour-change promise is exactly this assertion.
  const { host, screens, ...flags } = SERVER_CAPABILITIES;
  assert.equal(host, 'server');
  assert.equal(screens, 'fleet');
  assert.deepEqual(Object.values(flags).filter((v) => v !== true), []);
});
