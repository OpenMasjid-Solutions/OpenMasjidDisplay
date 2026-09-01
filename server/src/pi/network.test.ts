// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The fixtures here are not invented. They are the verbatim output of nmcli 1.52.1 on a Pi 3 B+
 * running Debian 13, captured while that Pi was dual-homed — a cable on one subnet and Wi-Fi on
 * another — which is exactly the state a screen is in halfway through being moved onto Wi-Fi.
 *
 * That capture is what these tests are for. Two of the cases below would not have been written
 * from the documentation:
 *
 *  • the same SSID appearing three times, once per access point and band, and
 *  • `p2p-dev-wlan0`, a Wi-Fi Direct pseudo-device NetworkManager lists next to the real radio.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { splitTerse, linkFrom, hasWifiFrom, accessPointsFrom, radioFrom } from './network';

/** Verbatim `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status` from the dual-homed Pi. */
const STATUS_BOTH = [
  'eth0:ethernet:connected:Wired connection 1',
  'wlan0:wifi:connected:netplan-wlan0-Noor The Cat',
  'lo:loopback:connected (externally):lo',
  'p2p-dev-wlan0:wifi-p2p:disconnected:',
].join('\n');

/** Verbatim `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list` from the same Pi. */
const WIFI_LIST = [
  ' :Noor The Cat:100:WPA2 WPA3',
  ' :Noor The Cat:72:WPA2 WPA3',
  '*:Noor The Cat:70:WPA2 WPA3',
].join('\n');

test('a cable and Wi-Fi both up reads as ethernet, because that is what carries the traffic', () => {
  // Measured on this Pi: eth0 held the default route while wlan0 was associated on another subnet.
  // Reporting "Wi-Fi" here would tell somebody it is safe to unplug the cable. It is not.
  assert.equal(linkFrom(STATUS_BOTH), 'ethernet');
});

test('Wi-Fi only reads as wifi, and nothing connected reads as none', () => {
  const wifiOnly = ['eth0:ethernet:unavailable:', 'wlan0:wifi:connected:home'].join('\n');
  assert.equal(linkFrom(wifiOnly), 'wifi');

  // A cable that is plugged in but has no carrier is "disconnected", not a link.
  const nothing = ['eth0:ethernet:disconnected:', 'wlan0:wifi:disconnected:'].join('\n');
  assert.equal(linkFrom(nothing), 'none');

  // Loopback says "connected (externally)" and must never count as a link.
  assert.equal(linkFrom('lo:loopback:connected (externally):lo'), 'none');
});

test('the Wi-Fi Direct pseudo-device does not count as having Wi-Fi', () => {
  assert.equal(hasWifiFrom(STATUS_BOTH), true);
  // A Pi with no radio still lists p2p-dev; counting it would offer Wi-Fi setup on hardware that
  // cannot do it, and every step of that flow would then fail for a reason nobody could see.
  assert.equal(hasWifiFrom(['eth0:ethernet:connected:', 'p2p-dev-wlan0:wifi-p2p:disconnected:'].join('\n')), false);
  assert.equal(hasWifiFrom('eth0:ethernet:connected:'), false);
});

test('one network listed once, however many access points it has', () => {
  // The real capture: three rows, three signals, two bands, one network.
  const aps = accessPointsFrom(WIFI_LIST);
  assert.equal(aps.length, 1, 'three access points for one SSID must collapse to one row');
  assert.equal(aps[0].ssid, 'Noor The Cat');
  assert.equal(aps[0].signal, 100, 'the strongest of the three');
  assert.equal(aps[0].secured, true);
  // The association was on the WEAKEST of the three rows. Keeping the strongest signal must not
  // lose the fact that we are connected, or the panel offers to join a network it is already on.
  assert.equal(aps[0].active, true);
});

test('being connected survives whichever order the rows arrive in', () => {
  const activeFirst = ['*:home:40:WPA2', ' :home:90:WPA2'].join('\n');
  const activeLast = [' :home:90:WPA2', '*:home:40:WPA2'].join('\n');
  for (const [name, input] of [['active first', activeFirst], ['active last', activeLast]] as const) {
    const aps = accessPointsFrom(input);
    assert.equal(aps.length, 1, name);
    assert.equal(aps[0].active, true, `${name}: connection lost while merging bands`);
    assert.equal(aps[0].signal, 90, `${name}: should keep the strongest signal`);
  }
});

test('open networks are distinguishable from secured ones, and hidden ones are dropped', () => {
  const aps = accessPointsFrom([' :Guest:60:--', ' ::55:WPA2', ' :Office:70:WPA2'].join('\n'));
  assert.deepEqual(aps.map((a) => a.ssid), ['Office', 'Guest'], 'strongest first; the hidden row is gone');
  assert.equal(aps.find((a) => a.ssid === 'Guest')?.secured, false);
  assert.equal(aps.find((a) => a.ssid === 'Office')?.secured, true);
});

test('the connected network sorts to the top even when it is the weakest', () => {
  const aps = accessPointsFrom([' :Strong:95:WPA2', '*:Mine:20:WPA2'].join('\n'));
  assert.deepEqual(aps.map((a) => a.ssid), ['Mine', 'Strong']);
});

test('a colon in an SSID survives terse parsing', () => {
  // nmcli escapes a literal colon as \: — split(':') would turn one network into two fields and
  // show somebody a mangled version of their own network name.
  assert.deepEqual(splitTerse('a\\:b:2:c'), ['a:b', '2', 'c']);
  assert.deepEqual(splitTerse('back\\\\slash:1'), ['back\\slash', '1']);
  const aps = accessPointsFrom(' :Masjid\\: Main:80:WPA2');
  assert.equal(aps[0].ssid, 'Masjid: Main');
  assert.equal(aps[0].signal, 80);
});

test('a malformed or empty list is empty, not a crash', () => {
  assert.deepEqual(accessPointsFrom(''), []);
  assert.deepEqual(accessPointsFrom('\n\n'), []);
  // A signal that is not a number must not become NaN in a sort.
  const aps = accessPointsFrom(' :odd:notanumber:WPA2');
  assert.equal(aps[0].signal, 0);
});

test('the radio is only on when nmcli plainly says so', () => {
  assert.equal(radioFrom('enabled'), true);
  assert.equal(radioFrom('enabled\n'), true);
  assert.equal(radioFrom('disabled'), false);
  // "missing" is what nmcli reports for hardware that is not there.
  assert.equal(radioFrom('missing'), false);
  assert.equal(radioFrom(''), false);
});
