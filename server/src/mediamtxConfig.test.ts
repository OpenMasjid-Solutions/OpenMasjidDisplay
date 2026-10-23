// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The RTSP server accepts PUBLISH from this container only.
 *
 * MediaMTX's stock config lets anyone publish to any path and lets a new publisher take over an
 * existing one, and port 8554 is open to the LAN for the screens to read. Anyone on the network who
 * learnt a timetable's id — the public widget URL carries it — could push their own video to every
 * screen showing that timetable. The Dockerfile closes it with MTX_* overrides, verified against
 * the image by publishing from another host (401) and reading from one (plays).
 *
 * Those overrides name POSITIONS in MediaMTX's default user list, not names, so a MediaMTX upgrade
 * that reorders that list would quietly reopen it. This test cannot run the image; what it does is
 * refuse to let the version move without somebody re-checking — Dependabot proposes these bumps.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DOCKERFILE = fs.readFileSync(path.join(__dirname, '..', '..', 'Dockerfile'), 'utf8');

test('publish is moved off the anonymous user and onto the loopback one', () => {
  for (const line of [
    'MTX_AUTHINTERNALUSERS_0_PERMISSIONS_0_ACTION=read',
    'MTX_AUTHINTERNALUSERS_0_PERMISSIONS_1_ACTION=playback',
    'MTX_AUTHINTERNALUSERS_0_PERMISSIONS_2_ACTION=playback',
    'MTX_AUTHINTERNALUSERS_1_PERMISSIONS_3_ACTION=publish',
  ]) {
    assert.ok(DOCKERFILE.includes(line), `missing: ${line}`);
  }
});

test('MediaMTX is the version those positions were verified against', () => {
  assert.match(
    DOCKERFILE,
    /^FROM bluenviron\/mediamtx:1\.19\.1@/m,
    'MediaMTX was upgraded. Re-check its default authInternalUsers list against the MTX_AUTHINTERNALUSERS_* ' +
      'overrides in the Dockerfile (publish from another host must get 401, a read must still play), then ' +
      'update the version in this test.',
  );
});
