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
import { videoArgs, redactCreds, shouldDropHardware, ranHealthily, pickTimeoutFlag, cameraFailureText, stripFfmpegTag, retryDelayMs, FF_PROTOCOLS } from './video';
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
  // The case that mattered on real hardware: a UniFi stream playing about thirty seconds and then
  // dropping. At the old 30s threshold that scored as unhealthy EVERY time, so the gap between
  // attempts grew 1s, 2s, 4s … 30s while the drop itself never changed.
  assert.equal(ranHealthily(28_000), true, 'a stream that played for 28s plainly worked');
  assert.equal(ranHealthily(12_000), true);
  // A failure to START is still counted, so a camera switched off overnight still backs off.
  assert.equal(ranHealthily(4_000), false, 'a fast failure is not a healthy run');
  assert.equal(ranHealthily(10_000), false, 'the boundary is exclusive');
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

test('a performance warning is not reported as the reason a camera failed', () => {
  // Shown on a real screen as "Camera unavailable — [swscaler] No accelerated colorspace
  // conversion found from yuv420p to rgb565le". That is swscale saying the conversion has no fast
  // path, which is a performance note; it is not why anything stopped.
  const noise = [
    '[swscaler @ 0x7f90249690] No accelerated colorspace conversion found from yuv420p to rgb565le.',
    'frame=  102 fps= 25 q=-0.0 size=N/A time=00:00:04.08',
    'Input #0, rtsp, from ...',
    '  libavcodec 60. 31.102 / 60. 31.102',
    'deprecated pixel format used, make sure you did set range correctly',
  ];
  const real = [
    '[rtsp @ 0x1234] method DESCRIBE failed: 401 Unauthorized',
    'Connection to tcp://192.168.1.100:7441 failed: Connection refused',
    'Server returned 404 Not Found',
  ];
  // Mirrors the filter in video.ts — kept here so the classification is asserted, not assumed.
  const NOISE =
    /^\s*(Input #|Stream #|Metadata:|Duration:|encoder|frame=|Press \[q\]|built with|configuration:|lib[a-z]+ +[0-9]|\[swscaler|deprecated|Last message repeated|Guessed Channel)/i;
  for (const l of noise) assert.ok(NOISE.test(l), `should be ignored: ${l.slice(0, 60)}`);
  for (const l of real) assert.ok(!NOISE.test(l), `should be reported: ${l.slice(0, 60)}`);
});

test('hardware decoding is not retried on a board that does not have it', () => {
  // From the real log, every 35 seconds for as long as it ran:
  //   camera: opening rtsps://... (hardware decoding)
  //   camera: failed in 2s with hardware decoding; trying software once:
  //     [h264_v4l2m2m @ ...] Could not find a valid device
  // Two seconds of black screen on every reconnect, for a decoder this board does not have. The
  // healthy run that triggered the re-arm was in SOFTWARE, so it said nothing about the hardware.
  //
  // shouldDropHardware already refuses a second attempt within one camera; the missing half was
  // not re-arming across reconnects unless hardware had genuinely worked.
  assert.equal(shouldDropHardware(2_000, true, false), true, 'try software after the first fast failure');
  assert.equal(shouldDropHardware(2_000, true, true), false, 'and never again for this camera');
});

test('a clean exit is a stream ending, not a failure', () => {
  // The other half of the same log: "ffmpeg exited (0) after 33s". Exit ZERO — UniFi tore the RTSP
  // session down and ffmpeg reported a clean end of stream. Counting that as a failure grew the
  // backoff for something that had just worked perfectly for half a minute.
  //
  // ranHealthily covers the 33s; the exit code is what distinguishes "ended" from "broke".
  assert.equal(ranHealthily(33_000), true);
  // And the guard is on the code itself, so even a SHORT clean exit does not accumulate.
  const src = fs.readFileSync(path.resolve(__dirname, 'video.ts'), 'utf8');
  assert.ok(/if \(code === 0\) \{/.test(src), 'a clean exit must be handled before the failure path');
  // Scoped to the EXIT handler. There is another `failures++` in the spawn-failure path, which
  // legitimately comes earlier in the file — comparing against that one proves nothing.
  const handler = src.slice(src.indexOf("proc.on('exit'"));
  const zero = handler.indexOf('if (code === 0) {');
  const bump = handler.indexOf('this.failures++');
  assert.ok(zero >= 0 && bump >= 0, 'both branches must exist in the exit handler');
  assert.ok(zero < bump, 'a clean exit must be handled BEFORE the failure count is raised');
});

test('the frame rate is capped, and capped BEFORE the expensive stages', () => {
  // A masjid measured "Consumed 12min CPU" over twelve minutes of wall clock — a pegged core — and
  // the timetable renderer was starved down to a frame every seven seconds. Dropping frames first
  // means the scale and the colour conversion run on fewer of them.
  const vf = args('rtsp://cam')[args('rtsp://cam').indexOf('-vf') + 1];
  assert.ok(vf.startsWith('fps='), `fps must come first: ${vf}`);
  assert.ok(vf.indexOf('fps=') < vf.indexOf('scale='));
  assert.ok(vf.indexOf('fps=') < vf.indexOf('format='));
});

test('a 16bpp screen converts via bgra, avoiding the unaccelerated path', () => {
  // ffmpeg says so itself, in the log from a real Pi:
  //   [swscaler] No accelerated colorspace conversion found from yuv420p to rgb565le
  // …and then does it one pixel at a time. The routes into and out of bgra are SIMD, so going the
  // long way round is faster than the short one.
  const g16: FbGeometry = { width: 1920, height: 1080, bpp: 16, stride: 3840 };
  const vf16 = videoArgs('rtsp://c', g16, { hw: false, device: '/dev/fb0' })[
    videoArgs('rtsp://c', g16, { hw: false, device: '/dev/fb0' }).indexOf('-vf') + 1
  ];
  assert.ok(vf16.includes('format=bgra,format=rgb565le'), `expected a two-step conversion: ${vf16}`);

  // A 32bpp screen needs no second step — bgra IS what the framebuffer wants.
  const vf32 = args('rtsp://c', HD)[args('rtsp://c', HD).indexOf('-vf') + 1];
  assert.ok(vf32.endsWith('format=bgra'), vf32);
  assert.ok(!vf32.includes('rgb565'), 'and must not convert twice for nothing');
});


test('only a line that states a FAILURE is put on the television', () => {
  // Four separate times a swscaler performance note was shown to a congregation as the reason their
  // camera was unavailable, the last one truncated to "terpolation for destination format
  // 'rgb565le' not yet implemented". Blocklisting warnings kept losing to the truncation, because
  // the tail is sliced to a fixed size and a fragment matches nothing.
  //
  // So the test is inverted: quote a line only if it STATES a failure. A truncated warning can be
  // mistaken for an unknown line; it cannot be mistaken for one that says a connection was refused.
  const generic = 'Could not play this camera. Its address or network may be wrong.';

  for (const warning of [
    "terpolation for destination format 'rgb565le' not yet implemented",
    "[swscaler @ 0x1] full chroma interpolation for destination format 'rgb565le' not yet implemented",
    '[swscaler @ 0x1] No accelerated colorspace conversion found from yuv420p to rgb565le.',
  ]) {
    assert.equal(cameraFailureText(warning, false), generic, `quoted a warning: ${warning.slice(0, 50)}`);
  }

  for (const real of [
    '[rtsp @ 0x1] method DESCRIBE failed: 401 Unauthorized',
    'Connection to tcp://192.168.1.100:7441 failed: Connection refused',
    '[h264_v4l2m2m @ 0x1] Could not find a valid device',
    'Server returned 404 Not Found',
  ]) {
    // Still exact equality, but against the line with ffmpeg's `[component @ 0xADDRESS]` prefix
    // removed: the address is an eight-byte number in front of the only part anybody watching can
    // read. What has to survive is the part that says what went wrong, and it does.
    assert.equal(cameraFailureText(real, false), stripFfmpegTag(real), `lost a real error: ${real.slice(0, 50)}`);
    assert.ok(cameraFailureText(real, false).length > 8, `stripped away the whole message: ${real}`);
  }
});

test('the status-code pattern is word-bounded, or it matches rgb565le', () => {
  // Found while testing the above: an unbounded 4dd/5dd matched the "565" inside "rgb565le", so the
  // pattern meant to catch HTTP failures was quoting the exact warning the allowlist excludes.
  assert.notEqual(
    cameraFailureText("full chroma interpolation for destination format 'rgb565le' not yet implemented", false),
    "full chroma interpolation for destination format 'rgb565le' not yet implemented",
  );
  assert.match(cameraFailureText('Server returned 503 Service Unavailable', false), /503/);
});

test('a sliced first line is discarded rather than classified', () => {
  // It is a fragment; nothing true can be said about it.
  const tail = "wscaler @ 0x1] something cut off\nConnection to tcp://cam:554 failed: Connection refused";
  assert.match(cameraFailureText(tail, true), /Connection refused/);
});

test('the memory address ffmpeg prints is never shown on a wall', () => {
  assert.equal(stripFfmpegTag('[tls @ 0x557cc6a7e0] Error in the pull function.'), 'Error in the pull function.');
  assert.equal(stripFfmpegTag('[rtsp @ 0x5624ab] 401 Unauthorized'), '401 Unauthorized');
  // Nested tags, which ffmpeg emits for a decoder inside an input.
  assert.equal(
    stripFfmpegTag('[vist#0:2/h264 @ 0x55ae83a660] [dec:h264_v4l2m2m @ 0x55ae88c390] Error while opening decoder'),
    'Error while opening decoder',
  );
  // A line with no tag is left exactly as it is.
  assert.equal(stripFfmpegTag('Connection refused'), 'Connection refused');
});

test('a true error that means nothing to a masjid is translated, not quoted', () => {
  // Verbatim from a UniFi camera on a real screen. It states a failure, so the allowlist is right
  // to match it — and "Error in the pull function" under "Camera unavailable" still tells the
  // person standing there nothing they can do.
  const out = cameraFailureText('[tls @ 0x557cc6a7e0] Error in the pull function.', false);
  assert.doesNotMatch(out, /pull function/i, 'the internal phrasing is still being shown');
  assert.doesNotMatch(out, /0x[0-9a-f]+/i, 'a memory address is still being shown');
  assert.match(out, /secure connection/i);
  assert.match(out, /address and port/i, 'it should say what to check');
});

test('translating the opaque ones does not swallow the useful ones', () => {
  // The whole value of the allowlist is that a real, readable failure reaches the screen. These
  // must still be quoted, with only the tag removed.
  assert.equal(cameraFailureText('[rtsp @ 0x55f] 401 Unauthorized', false), '401 Unauthorized');
  assert.equal(cameraFailureText('Connection refused', false), 'Connection refused');
  assert.match(cameraFailureText('[tcp @ 0x1] Connection timed out', false), /^Connection timed out$/);
});

test('a line that was nothing but a tag falls back to the plain sentence', () => {
  // Possible once the tail is sliced: the readable half is gone and only the bracket survives.
  const out = cameraFailureText('[tls @ 0x557cc6a7e0] error', false);
  assert.equal(out, 'error', 'a one-word remainder is still the line');
  assert.match(cameraFailureText('[tls @ 0x557cc6a7e0] ', false), /Could not play this camera/);
});
