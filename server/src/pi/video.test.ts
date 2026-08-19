// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The camera the Pi opens for itself.
 *
 * The arguments are the whole of the security posture here and half of the behaviour, and there
 * is no way to check them on a machine without a framebuffer other than by reading them — so they
 * are asserted instead. What is being defended against is a crafted camera address: one that
 * becomes an extra ffmpeg flag, or that talks ffmpeg into reading a local file and putting it on
 * a screen in a prayer hall.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { videoArgs, redactCreds, shouldDropHardware, ranHealthily, pickTimeoutFlag, retryDelayMs, FF_PROTOCOLS } from './video';
import type { FbGeometry } from './framebuffer';

const HD: FbGeometry = { width: 1920, height: 1080, bpp: 32, stride: 7680 };
const args = (url: string, geo = HD, hw = false) => videoArgs(url, geo, { hw, device: '/dev/fb0' });

test('the camera address is one argument, never part of a command string', () => {
  // The whole reason spawn is called in array form. If this were a shell string, the URL below
  // would run `id` on every masjid screen showing that camera.
  const nasty = 'rtsp://cam/live; id #';
  const a = args(nasty);
  assert.equal(a.filter((x) => x === nasty).length, 1, 'it must appear whole, exactly once');
  assert.equal(a[a.indexOf(nasty) - 1], '-i', 'and only ever as the input');
});

test('only stream protocols are allowed, and the list matches the server exactly', () => {
  const a = args('rtsp://cam/live');
  const i = a.indexOf('-protocol_whitelist');
  assert.ok(i >= 0, 'without this, a crafted source can read local files');
  assert.equal(a[i + 1], FF_PROTOCOLS);
  // The two lists disagreeing is its own bug: a camera that saves fine and then shows nothing.
  for (const p of ['rtsp', 'rtsps', 'rtp', 'udp', 'tcp', 'tls', 'srtp', 'rtmp', 'rtmps', 'crypto', 'rtcp']) {
    assert.ok(FF_PROTOCOLS.split(',').includes(p), `missing ${p}`);
  }
  for (const never of ['file', 'http', 'https', 'concat', 'data', 'pipe', 'ftp']) {
    assert.ok(!FF_PROTOCOLS.split(',').includes(never), `${never} must never be whitelisted`);
  }
});

test('the picture is fitted and padded, never stretched', () => {
  // The framebuffer refuses a size that is not exactly its own, and stretching makes a room look
  // the wrong shape — which people notice without being able to say why.
  const vf = args('rtsp://cam')[args('rtsp://cam').indexOf('-vf') + 1];
  assert.ok(vf.includes('scale=1920:1080:force_original_aspect_ratio=decrease'));
  assert.ok(vf.includes('pad=1920:1080'));
});

test('the pixel format follows the screen depth', () => {
  const at32 = args('rtsp://c', HD)[args('rtsp://c', HD).indexOf('-vf') + 1];
  assert.ok(at32.includes('format=bgra'));
  const g16: FbGeometry = { width: 1280, height: 720, bpp: 16, stride: 2560 };
  const at16 = args('rtsp://c', g16)[args('rtsp://c', g16).indexOf('-vf') + 1];
  assert.ok(at16.includes('format=rgb565le'), 'a 16bpp framebuffer fed bgra shows noise');
  assert.ok(at16.includes('scale=1280:720'));
});

test('audio is dropped — a camera microphone has nowhere to go in a prayer hall', () => {
  assert.ok(args('rtsp://cam').includes('-an'));
});

test('RTSP runs over TCP, because a dropped packet reads as a broken camera', () => {
  const a = args('rtsp://cam');
  assert.equal(a[a.indexOf('-rtsp_transport') + 1], 'tcp');
});

test('the output goes to the framebuffer device it was given', () => {
  const a = videoArgs('rtsp://cam', HD, { hw: false, device: '/dev/fb1' });
  assert.equal(a[a.indexOf('-f') + 1], 'fbdev');
  assert.equal(a[a.length - 1], '/dev/fb1');
});

test('hardware decoding is selected before the input, or it selects nothing', () => {
  const a = args('rtsp://cam', HD, true);
  const dec = a.indexOf('h264_v4l2m2m');
  assert.ok(dec > 0, 'a Pi 3 needs this to manage 1080p at all');
  assert.ok(dec < a.indexOf('-i'), 'a decoder chosen after -i applies to nothing');
  assert.ok(!args('rtsp://cam', HD, false).includes('h264_v4l2m2m'));
});

// ── recovering without anyone attending to it ────────────────────────────────

test('a fast failure while hardware decoding means try software instead', () => {
  // A board or ffmpeg build with no working V4L2 decoder fails immediately, every time.
  assert.equal(shouldDropHardware(300, true, false), true);
});

test('a stream that ran and then dropped is a network problem, not a decoder one', () => {
  // Dropping to software here would not help; it would quietly double the processor use for the
  // rest of the device's life.
  assert.equal(shouldDropHardware(120_000, true, false), false);
  assert.equal(shouldDropHardware(300, false, false), false, 'already in software: nothing left to drop');
});

test('retries back off, but not so far that a camera coming back goes unnoticed', () => {
  assert.ok(retryDelayMs(1) <= 1000, 'the first retry should be quick');
  assert.ok(retryDelayMs(2) > retryDelayMs(1));
  assert.ok(retryDelayMs(20) <= 30_000, 'a camera switched off overnight must still be found by morning');
  // Monotonic, so a long outage never gets faster.
  for (let n = 1; n < 12; n++) assert.ok(retryDelayMs(n + 1) >= retryDelayMs(n));
});

// ── logs ─────────────────────────────────────────────────────────────────────

test('camera credentials never reach the journal', () => {
  // Cameras are very often configured with the password in the address, and the journal on a Pi
  // is readable by anyone who can get onto the box.
  assert.equal(redactCreds('rtsp://admin:hunter2@192.168.1.9/live'), 'rtsp://***@192.168.1.9/live');
  assert.ok(!redactCreds('rtsp://admin:hunter2@cam/live').includes('hunter2'));
  assert.equal(redactCreds('rtsp://192.168.1.9/live'), 'rtsp://192.168.1.9/live', 'nothing to redact');
});

test('the protocol list is literally the server\'s, not a copy that has drifted', () => {
  // The server's comment records being bitten by exactly this: the app accepted a source that
  // its own ffmpeg then refused, and the two lists disagreeing WAS the bug. A copy in this file
  // is only safe if something notices when the original moves.
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'render', 'renderer.ts'), 'utf8');
  const m = /const FF_PROTOCOLS = '([^']+)'/.exec(src);
  assert.ok(m, "could not find the server's FF_PROTOCOLS — has it been renamed?");
  assert.equal(FF_PROTOCOLS, m[1], 'the Pi and the server must allow exactly the same protocols');
});

// ── found by review, and confirmed against the real log from a Pi ────────────

test('hardware decoding is given up on at most once, not for the life of the device', () => {
  // The real log said "hardware decoding unavailable, falling back to software" four seconds after
  // a TLS handshake failure — nothing to do with the decoder. The board then software-decoded at
  // roughly double the cost for the life of the process, because the exit handler leaves the player
  // running so play() never reaches the line that re-arms it.
  assert.equal(shouldDropHardware(300, true, false), true, 'the first fast failure may try software');
  assert.equal(shouldDropHardware(300, true, true), false, 'but only once — after that it is not the decoder');
});

test('a run that lasted resets the backoff', () => {
  // Without this the failure count only rises, so a camera that drops every few minutes reaches the
  // 30s cap inside half an hour and every later recovery shows half a minute of an error card.
  assert.equal(ranHealthily(60_000), true);
  assert.equal(ranHealthily(31_000), true);
  assert.equal(ranHealthily(4_000), false, 'a fast failure is not a healthy run');
  assert.equal(ranHealthily(30_000), false, 'the boundary is exclusive, matching the server');
});

test('the socket timeout option name is probed, because it changed between ffmpeg versions', () => {
  // Guessing wrong is not harmless: ffmpeg rejects an unknown option and the camera never plays.
  // ffmpeg 5+ — -timeout is the socket timeout.
  assert.equal(pickTimeoutFlag('  -timeout            <int>  set timeout (in microseconds) of socket I/O\n'), 'timeout');
  // ffmpeg 4.x — -timeout is the LISTEN timeout, and -stimeout is the socket one.
  assert.equal(
    pickTimeoutFlag('  -timeout  <int>  set maximum timeout (in seconds) to wait for incoming connections\n  -stimeout <int>  set socket TCP I/O timeout in microseconds\n'),
    'stimeout',
  );
  // A build that offers neither gets no flag: unbounded is bad, no video at all is worse.
  assert.equal(pickTimeoutFlag(''), null);
});

test('the timeout is passed before the input, or it applies to nothing', () => {
  const a = videoArgs('rtsp://cam', HD, { hw: false, device: '/dev/fb0', timeoutFlag: 'timeout' });
  const t = a.indexOf('-timeout');
  assert.ok(t > 0, 'a camera that stalls must not freeze the last frame on the wall for ever');
  assert.ok(t < a.indexOf('-i'));
  assert.equal(a[t + 1], '10000000', 'ten seconds, in microseconds');
  // And a build with no such option must still produce a working command line.
  assert.ok(!videoArgs('rtsp://cam', HD, { hw: false, device: '/dev/fb0', timeoutFlag: null }).includes('-timeout'));
});
