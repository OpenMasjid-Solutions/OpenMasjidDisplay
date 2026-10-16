// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The spool writer, which two callers now share: the agent carrying a command a display server
 * queued, and a standalone screen's own panel carrying one somebody just pressed in a browser.
 *
 * What is tested here is the ORDER things land on disk and the SHAPE of what lands, because both
 * are invariants that root depends on and neither is visible from either caller.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeControl, readWifiResult, isWifiAction, WIFI_ACTIONS } from './control';

function sandbox(): { dir: string; ctl: ReturnType<typeof makeControl>; said: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-control-'));
  const said: string[] = [];
  return { dir, ctl: makeControl((...a) => said.push(a.join(' ')), dir), said };
}

const verbOf = (dir: string, id: string): string => fs.readFileSync(path.join(dir, 'control', id), 'utf8').trim();

test('a plain verb is one word in one file, and nothing else', () => {
  const { dir, ctl } = sandbox();
  const why = ctl.requestWifi('r1', 'wifi-rescan');
  assert.equal(why, null);
  assert.equal(verbOf(dir, 'r1'), 'wifi-rescan');
  // No payload file: only a join has one, and a stray one would be read by the NEXT join.
  assert.ok(!fs.existsSync(path.join(dir, 'wifi-request')));
});

test('a join writes its details BEFORE the verb, never after', () => {
  // This is the whole reason there is one writer rather than two.
  //
  // Root watches the control directory with a systemd .path unit, so the verb file appearing is
  // what wakes it. If the verb landed first, root could read it, find no details beside it, and
  // log "a Wi-Fi join was asked for with no details attached" — for a join that was perfectly
  // well formed and is about to have its details written a microsecond later. Nobody would ever
  // reproduce that, and the screen would simply not move onto the new network some of the time.
  const { ctl } = sandbox();
  const order: string[] = [];
  const realRename = fs.renameSync;
  // @ts-expect-error -- replaced for the duration of this test
  fs.renameSync = (from: string, to: string) => {
    order.push(path.basename(String(to)));
    return realRename(from as never, to as never);
  };
  try {
    ctl.requestWifi('j1', 'wifi-join', { ssid: 'Masjid', psk: 'abcdefgh' });
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(order, ['wifi-request', 'j1'], 'the details have to be in place before root is woken');
});

test('the network name and passphrase travel base64, one per line', () => {
  // The verb file cannot carry them: root reads a verb as `head -c 32 | tr -dc 'a-z-'`, which
  // would turn "Masjid 5G" into "masjidg". Encoding keeps a newline, a quote or a leading dash
  // in either field from changing the shape of the file root parses.
  const { dir, ctl } = sandbox();
  ctl.requestWifi('j2', 'wifi-join', { ssid: 'Masjid 5G', psk: 'a-b\nc"d' });
  const lines = fs.readFileSync(path.join(dir, 'wifi-request'), 'utf8').split('\n');
  assert.equal(Buffer.from(lines[0], 'base64').toString('utf8'), 'Masjid 5G');
  assert.equal(Buffer.from(lines[1], 'base64').toString('utf8'), 'a-b\nc"d');
  // And the encoded form carries no line break of its own, or root's `sed -n 1p` would split it.
  assert.ok(!/[^A-Za-z0-9+/=]/.test(lines[0]) && !/[^A-Za-z0-9+/=]/.test(lines[1]));
});

test('a join with no network name is refused with something a person can read', () => {
  const { dir, ctl } = sandbox();
  const why = ctl.requestWifi('j3', 'wifi-join', { ssid: '', psk: 'x' });
  assert.ok(why && /network name/i.test(why), 'the panel shows this to whoever pressed the button');
  // And nothing was left behind for root to act on.
  assert.ok(!fs.existsSync(path.join(dir, 'control', 'j3')));
  assert.ok(!fs.existsSync(path.join(dir, 'wifi-request')));
});

test('the passphrase is never logged, and the network name may be', () => {
  // The name is broadcast on the air for anyone to read. The passphrase is the masjid's.
  const { ctl, said } = sandbox();
  ctl.requestWifi('j4', 'wifi-join', { ssid: 'Masjid 5G', psk: 'correct-horse-battery' });
  const all = said.join('\n');
  assert.ok(all.includes('Masjid 5G'));
  assert.ok(!all.includes('correct-horse-battery'), 'a Wi-Fi password must never reach the log');
});

test('the verdict is read once and then gone', () => {
  // Root writes one answer to one request. Leaving it would have the panel showing an old failure
  // beside a working connection for ever after.
  const { dir } = sandbox();
  fs.writeFileSync(path.join(dir, 'wifi-result'), 'yes\n192.168.1.42\njoin\n');
  assert.deepEqual(readWifiResult(dir), { ok: true, detail: '192.168.1.42', kind: 'join' });
  assert.equal(readWifiResult(dir), undefined);
});

test("'unverified' is its own answer and must not read as success", () => {
  // It means the join worked but nothing proved the dashboard still reachable — which on a
  // standalone screen is the normal outcome, because there is no server to test against.
  const { dir } = sandbox();
  fs.writeFileSync(path.join(dir, 'wifi-result'), 'unverified\n192.168.1.42\n');
  assert.equal(readWifiResult(dir)?.ok, null);
});

test('a missing or unreadable verdict is no answer, not a problem', () => {
  const { dir } = sandbox();
  assert.equal(readWifiResult(dir), undefined);
  fs.writeFileSync(path.join(dir, 'wifi-result'), '');
  assert.equal(readWifiResult(dir)?.ok, null);
});

test('only the five Wi-Fi verbs pass isWifiAction', () => {
  // What the standalone panel is allowed to ask for, and the guard the route leans on.
  for (const a of WIFI_ACTIONS) assert.ok(isWifiAction(a));
  for (const a of ['reboot', 'update', 'shell', 'shell-session', 'wifi', 'wifi-', '', null, 7]) {
    assert.ok(!isWifiAction(a), `${String(a)} must not be a Wi-Fi action`);
  }
});
