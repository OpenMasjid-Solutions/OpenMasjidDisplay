// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Pairing a Raspberry Pi.
 *
 * Enrolment is necessarily UNAUTHENTICATED — a fresh Pi holds no credentials — so most of what
 * follows is about what a device can do before an admin has adopted it, which is meant to be
 * almost nothing. The other half is the reason the device exists at all: it is handed the
 * camera's own address so the server never carries the video.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normTv, normSettings, normSource, normTimetable } from './validate';
import {
  enrolDevice,
  prunePending,
  findDeviceByToken,
  findPendingByCode,
  makePairingCode,
  makeDeviceToken,
  piState,
  markDeviceSeen,
  deviceOnline,
  MAX_PENDING_DEVICES,
  PENDING_TTL_MS,
  PI_SEEN_TIMEOUT_MS,
  __resetDevicesForTests,
} from './piAgent';
import type { DB, Settings, Tv } from './types';

const NOW = new Date('2026-08-19T12:00:00Z').getTime();

function settings(): Settings {
  return normSettings({}, {
    defaultQuality: '1080p',
    scheduleTimezone: '',
    volunteerEnabled: false,
    volunteerRemote: true,
    whatsapp: { iqamahChange: false, groupId: '', groupLabel: '', timetableId: '', daysBefore: 1 },
    webScreensBeta: false,
  } as Settings);
}

function db(tvs: Tv[] = []): DB {
  return { version: 1, admin: null, volunteerAuth: null, settings: settings(), timetables: [], sources: [], tvs, schedules: [] };
}

// ── the pairing code ─────────────────────────────────────────────────────────

test('a pairing code cannot be misread off a television', () => {
  // It is read across a room and then typed. 0/O, 1/I and 5/S are the pairs that cause
  // support calls, so the alphabet simply does not contain them.
  for (let i = 0; i < 500; i++) {
    const c = makePairingCode();
    assert.equal(c.length, 6);
    assert.doesNotMatch(c, /[0O1I5S]/, `ambiguous character in ${c}`);
    assert.match(c, /^[A-Z0-9]+$/);
  }
});

test('codes and tokens do not repeat', () => {
  assert.equal(new Set(Array.from({ length: 500 }, makePairingCode)).size > 490, true);
  assert.equal(new Set(Array.from({ length: 200 }, makeDeviceToken)).size, 200);
});

// ── enrolment ────────────────────────────────────────────────────────────────

test('a device that enrols is PENDING and gets no token', () => {
  const d = db();
  const { device, result } = enrolDevice(d, { hostname: 'masjid-pi', ip: '192.168.1.50', model: 'Pi 3 B+', agentVersion: '1.0' }, NOW);
  assert.equal(device.token, undefined, 'a pending device must hold no credential');
  assert.equal(result.adopted, false);
  assert.equal(result.code, device.code);
  assert.equal(d.piDevices?.length, 1);
});

test('a reboot comes back as the SAME device with the SAME code', () => {
  // Otherwise every power cut papers the dashboard with duplicates of one screen, and the code
  // on the wall stops matching the one an admin is looking at. The agent keeps its id AND its
  // secret across reboots, which is what lets the row be reused safely.
  const d = db();
  const id = { deviceId: 'pi_abc123', deviceSecret: 'kept-across-reboots', hostname: 'masjid-pi' };
  const first = enrolDevice(d, id, NOW);
  const second = enrolDevice(d, id, NOW + 60_000);
  assert.equal(d.piDevices?.length, 1);
  assert.equal(second.device.id, first.device.id);
  assert.equal(second.result.code, first.result.code);
});

test('without a secret, a device cannot claim an existing row at all', () => {
  // The consequence of the rule above, stated plainly: an agent that lost its secret is a new
  // device and shows a new code. That is recoverable and visible; silently adopting someone
  // else's row would not be.
  const d = db();
  enrolDevice(d, { deviceId: 'pi_x', deviceSecret: 's' }, NOW);
  const bare = enrolDevice(d, { deviceId: 'pi_x' }, NOW + 1000);
  assert.notEqual(bare.device.id, 'pi_x');
  assert.equal(d.piDevices!.length, 2);
});

test('what a device says about itself is treated as display text, nothing more', () => {
  const d = db();
  const esc = String.fromCharCode(27);
  const nul = String.fromCharCode(0);
  const { device } = enrolDevice(
    d,
    { hostname: `pi${nul}${esc}[2Jevil`, ip: 'x'.repeat(500), model: `m${esc}m` },
    NOW,
  );
  // Control characters matter here beyond tidiness: this text is printed to a screen and shown
  // in the panel, and an escape sequence in a hostname should not be able to drive either.
  assert.doesNotMatch(device.hostname, /[\u0000-\u001F\u007F-\u009F]/);
  assert.doesNotMatch(device.model, /[\u0000-\u001F\u007F-\u009F]/);
  assert.ok(device.ip.length <= 64, 'self-reported fields are clamped');
});

test('a device id from the agent is only a lookup key — it grants nothing', () => {
  // The agent chooses its own id so a reboot is not a new device. That is safe precisely
  // because a pending device has no token, so claiming any id still reaches nothing.
  const d = db();
  const { device } = enrolDevice(d, { deviceId: 'pi_someone_elses' }, NOW);
  assert.equal(device.token, undefined);
  assert.equal(findDeviceByToken(d, 'pi_someone_elses'), null);
});

// ── the unauthenticated surface is bounded ───────────────────────────────────

test('pending devices are capped, and the OLDEST is evicted', () => {
  // Enrolment cannot be authenticated, so without a cap anyone who can reach the port grows
  // the store without bound. Evicting the oldest rather than refusing the newest matters: a
  // flood must not lock out the device someone is standing in front of.
  const d = db();
  for (let i = 0; i < MAX_PENDING_DEVICES + 15; i++) {
    enrolDevice(d, { deviceId: `pi_${i}`, hostname: `h${i}` }, NOW + i * 1000);
  }
  assert.equal(d.piDevices!.length, MAX_PENDING_DEVICES);
  // The most recent survivors are the ones kept.
  assert.ok(d.piDevices!.some((x) => x.id === `pi_${MAX_PENDING_DEVICES + 14}`), 'the newest must survive');
  assert.ok(!d.piDevices!.some((x) => x.id === 'pi_0'), 'the oldest is the one dropped');
});

test('an ADOPTED device is never evicted by that cap', () => {
  // It belongs to the masjid, not to a bound on abuse.
  const d = db();
  const { device } = enrolDevice(d, { deviceId: 'pi_real' }, NOW);
  device.token = makeDeviceToken();
  for (let i = 0; i < MAX_PENDING_DEVICES + 15; i++) enrolDevice(d, { deviceId: `pi_junk_${i}` }, NOW + i * 1000);
  assert.ok(d.piDevices!.some((x) => x.id === 'pi_real'), 'an adopted device must survive a flood');
});

test('a pending device is forgotten once it stops checking in', () => {
  const d = db();
  enrolDevice(d, { deviceId: 'pi_gone' }, NOW);
  prunePending(d, NOW + PENDING_TTL_MS + 1000);
  assert.equal(d.piDevices!.length, 0);
});

// ── adoption ─────────────────────────────────────────────────────────────────

test('a code is matched however it was typed, and only while pending', () => {
  const d = db();
  const { device } = enrolDevice(d, { deviceId: 'pi_1' }, NOW);
  const code = device.code;
  assert.equal(findPendingByCode(d, code)?.id, 'pi_1');
  assert.equal(findPendingByCode(d, code.toLowerCase())?.id, 'pi_1', 'typed in lower case');
  assert.equal(findPendingByCode(d, ` ${code.slice(0, 3)}-${code.slice(3)} `)?.id, 'pi_1', 'with spaces and a dash');
  assert.equal(findPendingByCode(d, 'ZZZZZZ'), null);
  assert.equal(findPendingByCode(d, ''), null, 'an empty code must never match anything');

  // Once adopted the code is spent: it cannot be used to adopt the device a second time.
  device.token = makeDeviceToken();
  assert.equal(findPendingByCode(d, code), null);
});

test('only an adopted device can be found by token', () => {
  const d = db();
  const { device } = enrolDevice(d, { deviceId: 'pi_1' }, NOW);
  assert.equal(findDeviceByToken(d, ''), null);
  device.token = 'tok_abc';
  assert.equal(findDeviceByToken(d, 'tok_abc')?.id, 'pi_1');
  // Forgetting drops the token, and the device becomes unreachable again.
  delete device.token;
  assert.equal(findDeviceByToken(d, 'tok_abc'), null);
});

// ── the state, and the reason the device exists ──────────────────────────────

test('a Pi showing a camera is handed the CAMERA\'S OWN address', () => {
  // This one field is the whole point. A browser screen has to be fed video by the server —
  // which, with the server in the cloud, sends the picture across the internet twice. The Pi
  // is on the same network as the camera, so it is told where to look and pulls it itself.
  const cam = normSource({ name: 'Imam', url: 'rtsp://192.168.1.90:554/live', mode: 'direct', enabled: true });
  const tv = normTv({ name: 'Hall', kind: 'pi', defaultContent: { kind: 'source', id: cam.id } });
  const d = db([tv]);
  d.sources = [cam];
  const { device } = enrolDevice(d, { deviceId: 'pi_1' }, NOW);
  device.token = makeDeviceToken();

  const st = piState(d, device, tv, NOW, { basePrefix: '', clockSuspect: false, bgLight: false, autoAccent: null, fontNames: [] });
  assert.equal(st.content.kind, 'source');
  assert.deepEqual(st.stream, { url: 'rtsp://192.168.1.90:554/live', mode: 'direct' });
  assert.equal(st.timetable, null);
});

test('a disabled camera is not handed over at all', () => {
  const cam = normSource({ name: 'Imam', url: 'rtsp://192.168.1.90/live', enabled: false });
  const tv = normTv({ name: 'Hall', kind: 'pi', defaultContent: { kind: 'source', id: cam.id } });
  const d = db([tv]);
  d.sources = [cam];
  const { device } = enrolDevice(d, { deviceId: 'pi_1' }, NOW);
  device.token = makeDeviceToken();
  assert.equal(piState(d, device, tv, NOW, { basePrefix: '', clockSuspect: false, bgLight: false, autoAccent: null, fontNames: [] }).stream, null);
});

test('a Pi showing a timetable gets the timetable, and no stream', () => {
  const tt = normTimetable({ masjidName: 'Madani Academy Masjid', latitude: 40.2415, longitude: -75.2838, timezone: 'America/New_York' });
  const tv = normTv({ name: 'Hall', kind: 'pi', defaultContent: { kind: 'timetable', id: tt.id } });
  const d = db([tv]);
  d.timetables = [tt];
  const { device } = enrolDevice(d, { deviceId: 'pi_1' }, NOW);
  device.token = makeDeviceToken();

  const st = piState(d, device, tv, NOW, { basePrefix: '/display', clockSuspect: false, bgLight: false, autoAccent: null, fontNames: [] });
  assert.equal(st.timetable?.id, tt.id);
  assert.equal(st.stream, null);
  assert.equal(st.serverNow, NOW, 'the Pi renders against the SERVER clock, not its own');
  // Small, because it is data rather than a picture.
  assert.ok(Buffer.byteLength(JSON.stringify(st)) < 4096);
});

test('an adopted device with no screen yet is simply off', () => {
  const d = db();
  const { device } = enrolDevice(d, { deviceId: 'pi_1' }, NOW);
  device.token = makeDeviceToken();
  const st = piState(d, device, null, NOW, { basePrefix: '', clockSuspect: false, bgLight: false, autoAccent: null, fontNames: [] });
  assert.equal(st.content.kind, 'off');
  assert.equal(st.timetable, null);
  assert.equal(st.stream, null);
});

// ── liveness ─────────────────────────────────────────────────────────────────

test('a device is online only while it keeps checking in', () => {
  __resetDevicesForTests();
  assert.equal(deviceOnline('pi_1', NOW), false, 'never seen is offline, not "assume fine"');
  markDeviceSeen('pi_1', NOW);
  assert.equal(deviceOnline('pi_1', NOW + PI_SEEN_TIMEOUT_MS - 1000), true);
  assert.equal(deviceOnline('pi_1', NOW + PI_SEEN_TIMEOUT_MS + 1000), false);
});

// ── the screen kind ──────────────────────────────────────────────────────────

test('a pi screen is a real screen kind, and its device binding is not client-settable', () => {
  const tv = normTv({ name: 'Hall', kind: 'pi' });
  assert.equal(tv.kind, 'pi');
  // The binding between a screen and a physical device is set by the adoption handler. A form
  // that could choose it could steal someone else's screen.
  const forged = normTv({ name: 'Hall', kind: 'pi', piDeviceId: 'pi_someone_elses' });
  assert.equal(forged.piDeviceId, undefined);
});

// ── the device secret: why a device id is safe to accept from a client ───────

test('a device only gets its token back by proving it is that device', () => {
  // The agent has to learn its token somehow, and enrolment is the only channel it has. But
  // enrolment is unauthenticated, so handing the token to whoever presents a device id would
  // turn the id into a credential — and the id is not secret: it is logged, shown in the
  // panel, and chosen by the client.
  const d = db();
  const { device } = enrolDevice(d, { deviceId: 'pi_1', deviceSecret: 'real-secret-abc' }, NOW);
  device.token = makeDeviceToken();

  const proper = enrolDevice(d, { deviceId: 'pi_1', deviceSecret: 'real-secret-abc' }, NOW + 1000);
  assert.equal(proper.result.adopted, true);
  assert.equal(proper.result.token, device.token, 'the real device gets its token');
});

test('an impostor claiming a known device id gets nothing, and does not disturb it', () => {
  const d = db();
  const { device } = enrolDevice(d, { deviceId: 'pi_1', deviceSecret: 'real-secret-abc' }, NOW);
  device.token = makeDeviceToken();
  const realCode = device.code;

  const impostor = enrolDevice(d, { deviceId: 'pi_1', deviceSecret: 'guessed' }, NOW + 1000);
  assert.equal(impostor.result.token, undefined, 'no token without the secret');
  assert.equal(impostor.result.adopted, false);
  assert.notEqual(impostor.device.id, 'pi_1', 'it is enrolled as a NEW device, not given the existing one');

  // And the genuine device is untouched — same id, same code, same token.
  const real = d.piDevices!.find((x) => x.id === 'pi_1')!;
  assert.equal(real.code, realCode);
  assert.equal(real.token, device.token);
});

test('a claimed id is not refused outright, because refusing would confirm it exists', () => {
  // Enrolling the impostor as a fresh pending device tells them nothing at all.
  const d = db();
  enrolDevice(d, { deviceId: 'pi_1', deviceSecret: 's1' }, NOW);
  const out = enrolDevice(d, { deviceId: 'pi_1', deviceSecret: 'wrong' }, NOW + 1000);
  assert.equal(out.result.adopted, false);
  assert.ok(out.result.code, 'it gets an ordinary pending code, like any new device');
});

test('the secret is never stored in the clear', () => {
  const d = db();
  enrolDevice(d, { deviceId: 'pi_1', deviceSecret: 'real-secret-abc' }, NOW);
  const stored = JSON.stringify(d.piDevices);
  assert.ok(!stored.includes('real-secret-abc'), 'a stored secret must not be usable');
  assert.match(d.piDevices![0].secretHash!, /^[0-9a-f]{64}$/);
});

test('a device that sends no secret can never be adopted into a working state', () => {
  // It stays pending from its own point of view, which is visible and fixable (re-run the
  // installer) rather than a screen that silently never starts.
  const d = db();
  const { device } = enrolDevice(d, { deviceId: 'pi_nosecret' }, NOW);
  device.token = makeDeviceToken();
  const again = enrolDevice(d, { deviceId: 'pi_nosecret' }, NOW + 1000);
  assert.equal(again.result.token, undefined);
  assert.equal(again.result.adopted, false);
});
