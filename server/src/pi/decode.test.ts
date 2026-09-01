// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The decode decision, tested exhaustively — because it is the one part of the Pi 4 migration that
 * CAN be tested exhaustively without a Pi 4.
 *
 * The environment is probed at runtime; the DECISION taken given that environment is pure, and is
 * pinned here. So if a real board behaves unexpectedly, the fault is in a probed input or a stated
 * ceiling rather than in the logic — a much smaller thing to go looking for.
 *
 * These were first written with no Pi 4 available, and one of them asserted the exact opposite of
 * what the hardware turned out to do: H.264 through the board's own decoder is SLOWER than through
 * its processor. The numbers now sit beside the assertions they justify, because a test that pins a
 * behaviour without saying why is the thing that turns a wrong belief into a permanent one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseDecode,
  decodeArgs,
  parseHwaccels,
  parseDecoders,
  parseProbe,
  codecFrom,
  isSupportedBoard,
  unsupportedBoardMessage,
  hwCaps,
  __resetCapsForTests,
  HW_MAX,
  type HwCaps,
  type SourceInfo,
} from './decode';

/** A Pi 4 with everything working: the Raspberry Pi OS ffmpeg build and rpivid switched on. */
const PI4: HwCaps = { drmHwaccel: true, h264M2m: true, rpivid: true, model: 'Raspberry Pi 4 Model B Rev 1.4' };
const src = (codec: SourceInfo['codec'], width: number, height: number, fps = 30): SourceInfo => ({ codec, width, height, fps });

test('H.265 goes to the stateless decoder, and NOT to hevc_v4l2m2m', () => {
  // The whole reason this module exists. `ffmpeg -decoders` advertises hevc_v4l2m2m on a Pi, and it
  // does not work: that wrapper drives stateful m2m devices and the Pi's HEVC block is stateless.
  // A decoder that is advertised and broken is worse than one that is absent, because every naive
  // check passes.
  const plan = chooseDecode(src('hevc', 3840, 2160), PI4);
  assert.equal(plan.kind, 'hw-drm');
  assert.deepEqual(decodeArgs(plan), ['-hwaccel', 'drm']);
  assert.ok(!decodeArgs(plan).join(' ').includes('v4l2m2m'), 'hevc must never be sent to an m2m wrapper');
});

test('h264_v4l2m2m is never used, however available it looks', () => {
  // It is advertised by ffmpeg on a Pi, it opens successfully at 1080p, and it is still the wrong
  // choice: measured 15.46s of CPU against software's 12.95s for the same 10s of 1080p, and it
  // fails outright at 1440p. Availability is not a reason.
  for (const [w, h] of [[1280, 720], [1920, 1080], [2560, 1440]]) {
    const args = decodeArgs(chooseDecode(src('h264', w, h), PI4)).join(' ');
    assert.ok(!args.includes('v4l2m2m'), `${w}x${h} must not reach an m2m wrapper`);
  }
});

test('4K H.265 is hardware; 4K H.264 is not — the two ceilings are different', () => {
  // This asymmetry is the single most important fact about a Pi 4 for this app: the dedicated HEVC
  // block is worth using and the H.264 one is not — measured, see decode.ts. Treating "hardware
  // decode" as one capability is how a 4K camera ends up in software with nobody knowing why.
  assert.equal(chooseDecode(src('hevc', 3840, 2160), PI4).kind, 'hw-drm');
  assert.equal(chooseDecode(src('h264', 3840, 2160), PI4).kind, 'software');
});

test('the masjid\'s real 2688x1512 H.264 camera still falls to software, and is told to use a substream', () => {
  // The actual camera from the Pi 3 work. It is above the H.264 ceiling on a Pi 4 as well, so the
  // honest answer is software plus a sentence that tells somebody what to do about it.
  const plan = chooseDecode(src('h264', 2688, 1512), PI4);
  assert.equal(plan.kind, 'software');
  assert.match(plan.why, /2688x1512/, 'the message must contain the real numbers');
  assert.match(plan.why, /1080p or 720p/, 'and say what to do instead');
});

test('the same camera in H.265 at that size IS hardware — which is the point of the migration', () => {
  assert.equal(chooseDecode(src('hevc', 2688, 1512), PI4).kind, 'hw-drm');
});

test('every fallback to software says why, in words a masjid can act on', () => {
  // On the Pi 3 the fallback was silent and a stuttering picture had no explanation for months.
  // H.265 losing its hardware path is the case that needs explaining, because there the hardware
  // was genuinely better and something is missing. Each of these has a DIFFERENT fix, so each has
  // to read differently.
  const hevcCases: [string, SourceInfo, HwCaps][] = [
    ['ffmpeg built without v4l2-request', src('hevc', 1920, 1080), { ...PI4, drmHwaccel: false }],
    ['rpivid overlay not enabled', src('hevc', 1920, 1080), { ...PI4, rpivid: false }],
    ['hevc above the 4K ceiling', src('hevc', 7680, 4320), PI4],
    ['a codec with no hardware path', src('other', 1920, 1080), PI4],
  ];
  for (const [label, s, c] of hevcCases) {
    const plan = chooseDecode(s, c);
    assert.equal(plan.kind, 'software', label);
    assert.ok(plan.why.length > 40, `${label}: the reason must be a sentence, not a token`);
    assert.match(plan.why, /software/i, `${label}: it must say it is in software`);
    assert.deepEqual(decodeArgs(plan), [], `${label}: software takes no decoder flag`);
  }

  // H.264 is software by choice rather than by shortfall, so its wording explains rather than
  // apologises — but it must still explain, and still name a size when the size is the problem.
  for (const [w, h] of [[1280, 720], [2688, 1512]]) {
    const plan = chooseDecode(src('h264', w, h), PI4);
    assert.ok(plan.why.length > 40, `${w}x${h}: the reason must be a sentence`);
    assert.match(plan.why, /processor|software/i, `${w}x${h}: it must say what is doing the work`);
    assert.deepEqual(decodeArgs(plan), []);
  }
});

test('the boot-config case is distinguishable from the ffmpeg-build case', () => {
  // Two different fixes — one is re-running setup, the other is a different ffmpeg — so they must
  // not collapse into one message.
  const noOverlay = chooseDecode(src('hevc', 1920, 1080), { ...PI4, rpivid: false }).why;
  const noBuild = chooseDecode(src('hevc', 1920, 1080), { ...PI4, drmHwaccel: false }).why;
  assert.notEqual(noOverlay, noBuild);
  assert.match(noOverlay, /boot settings|setup/i);
  assert.match(noBuild, /ffmpeg|built/i);
});

test('a source of unknown size is never claimed to fit the hardware', () => {
  // ffprobe returning nothing usable must not read as "small enough". Guessing generously here would
  // hand an oversized stream to a decoder that fails to open, which on the Pi 3 produced an error
  // naming a missing file and sent everyone looking at permissions.
  for (const codec of ['h264', 'hevc'] as const) {
    const plan = chooseDecode(src(codec, 0, 0), PI4);
    assert.equal(plan.kind, 'software', `${codec} with no known size`);
  }
});

test('exactly at the H.265 ceiling is hardware; one pixel over is not', () => {
  assert.equal(chooseDecode(src('hevc', HW_MAX.hevc.width, HW_MAX.hevc.height), PI4).kind, 'hw-drm');
  assert.equal(chooseDecode(src('hevc', HW_MAX.hevc.width, HW_MAX.hevc.height + 1), PI4).kind, 'software');
});

test('H.264 is decoded in software at every size, because that is measurably faster', () => {
  // Measured on a Pi 4 Model B Rev 1.4 at 1.8GHz through the real pipeline, in CPU seconds for 10s
  // of 1080p: software 12.95, `-c:v h264_v4l2m2m` 15.46, `-hwaccel drm` 13.20. The board's H.264
  // decoder is slower than its own processor, and it fails outright above about 1080p.
  //
  // This test asserts the OPPOSITE of what its first version did. That version was written from the
  // published specification — "the board has an H.264 decoder, therefore use it" — and a single
  // measurement reversed it. Keeping the reversal explicit here is the point: it is the same mistake
  // the Pi 3's "the encoder has ample headroom" comment made, caught faster.
  for (const [w, h] of [[640, 480], [1280, 720], [1920, 1080], [2560, 1440], [2688, 1512], [3840, 2160]]) {
    const plan = chooseDecode(src('h264', w, h), PI4);
    assert.equal(plan.kind, 'software', `${w}x${h} H.264 must be software`);
  }
  // Below the ceiling it is stated as the fast choice, not apologised for.
  assert.match(chooseDecode(src('h264', 1920, 1080), PI4).why, /fast way/);
  // Above it, the size is named and a smaller stream suggested — that is actionable.
  const big = chooseDecode(src('h264', 2688, 1512), PI4).why;
  assert.match(big, /2688x1512/);
  assert.match(big, /1080p or 720p/);
});

// ── the model gate ───────────────────────────────────────────────────────────

test('a Pi 3 is refused and a Pi 4 or newer is not', () => {
  assert.equal(isSupportedBoard('Raspberry Pi 4 Model B Rev 1.4'), true);
  assert.equal(isSupportedBoard('Raspberry Pi 5 Model B Rev 1.0'), true);
  assert.equal(isSupportedBoard('Raspberry Pi 3 Model B Plus Rev 1.3'), false);
  assert.equal(isSupportedBoard('Raspberry Pi 2 Model B Rev 1.1'), false);
  // A future board must not be refused by a list written today.
  assert.equal(isSupportedBoard('Raspberry Pi 6 Model B'), true);
});

test('an unrecognised board is NOT refused, because refusing on a guess is worse', () => {
  // A Zero 2 W, a Compute Module, a name we have never seen, or a kernel that does not report a
  // model at all. Refusing here would brick a screen over a string comparison.
  for (const m of ['', 'Raspberry Pi Zero 2 W', 'Raspberry Pi Compute Module 4', 'Some Other SBC', 'unknown']) {
    assert.equal(isSupportedBoard(m), true, m || '(empty)');
  }
});

test('the refusal names the board it saw', () => {
  const msg = unsupportedBoardMessage('Raspberry Pi 3 Model B Plus Rev 1.3');
  assert.match(msg, /Raspberry Pi 4 or newer/);
  assert.match(msg, /Raspberry Pi 3 Model B Plus/, 'somebody has to be able to tell which board was refused');
  assert.match(unsupportedBoardMessage(''), /unknown/);
});

// ── parsing what the machine tells us ────────────────────────────────────────

test('the hwaccel list is read, not assumed', () => {
  const out = 'Hardware acceleration methods:\ndrm\nvaapi\nvulkan\n';
  assert.deepEqual(parseHwaccels(out), ['drm', 'vaapi', 'vulkan']);
  assert.ok(parseHwaccels(out).includes('drm'));
  // A generic Debian ffmpeg, which has no v4l2-request support at all.
  assert.ok(!parseHwaccels('Hardware acceleration methods:\nvaapi\n').includes('drm'));
  assert.deepEqual(parseHwaccels(''), []);
});

test('the h264 m2m wrapper is detected from the decoder list', () => {
  assert.equal(parseDecoders(' V..... h264_v4l2m2m  V4L2 mem2mem H.264 decoder wrapper').h264M2m, true);
  assert.equal(parseDecoders(' V..... h264  H.264 software decoder').h264M2m, false);
  assert.equal(parseDecoders('').h264M2m, false);
});

test('ffprobe output becomes a source description', () => {
  const out = 'codec_name=hevc\nwidth=3840\nheight=2160\navg_frame_rate=30/1\n';
  assert.deepEqual(parseProbe(out), { codec: 'hevc', width: 3840, height: 2160, fps: 30 });
});

test('a camera that answers oddly does not produce nonsense', () => {
  // 0/0 is what a source that will not commit to a frame rate reports, and it must not become NaN
  // or Infinity — both of which would sail through a numeric comparison later.
  assert.equal(parseProbe('codec_name=h264\nwidth=1920\nheight=1080\navg_frame_rate=0/0\n').fps, 0);
  assert.equal(parseProbe('').codec, 'other');
  assert.deepEqual(parseProbe('rubbish'), { codec: 'other', width: 0, height: 0, fps: 0 });
  const negative = parseProbe('codec_name=h264\nwidth=-1920\nheight=1080\n');
  assert.equal(negative.width, 0, 'a negative width must not read as a small one');
  // A frame rate that is absurd is dropped rather than trusted.
  assert.equal(parseProbe('codec_name=h264\nwidth=1\nheight=1\navg_frame_rate=90000/1\n').fps, 0);
});

test('codec aliases are recognised', () => {
  for (const n of ['h264', 'H264', 'avc1']) assert.equal(codecFrom(n), 'h264', n);
  for (const n of ['hevc', 'HEVC', 'h265', 'hvc1']) assert.equal(codecFrom(n), 'hevc', n);
  for (const n of ['mjpeg', 'vp9', 'av1', '']) assert.equal(codecFrom(n), 'other', n);
});

test('probing never throws, however badly ffmpeg behaves', () => {
  __resetCapsForTests();
  const c = hwCaps('ffmpeg', () => {
    throw new Error('no such binary');
  });
  assert.equal(c.drmHwaccel, false);
  assert.equal(c.h264M2m, false);
  // And the result is cached, so a broken ffmpeg is not re-probed on every camera open.
  const again = hwCaps('ffmpeg', () => 'Hardware acceleration methods:\ndrm\n');
  assert.equal(again.drmHwaccel, false, 'the cached answer must win');
  __resetCapsForTests();
});

test('a working probe is read correctly', () => {
  __resetCapsForTests();
  const c = hwCaps('ffmpeg', (args) =>
    args.includes('-hwaccels')
      ? 'Hardware acceleration methods:\ndrm\n'
      : ' V..... h264_v4l2m2m  V4L2 mem2mem H.264 decoder wrapper\n',
  );
  assert.equal(c.drmHwaccel, true);
  assert.equal(c.h264M2m, true);
  __resetCapsForTests();
});
