// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * No single frame may be allowed to burst far above the stream's nominal bitrate.
 *
 * This is the setting that hung decoder boxes in the field. `bufsize` is the most bits the encoder
 * may spend between two points in the stream, which is also the ceiling on how big ONE frame can
 * be — and it was `bitrate * 2`. A frame that large is still "within bitrate" on average, but it
 * has to physically arrive inside one frame slot, and at 8 fps that slot is 125 ms.
 *
 * Measured against a real RTSP stream from the shipped 0.70.0 image with an announcement photo on
 * screen, pulled over TCP as a decoder box does:
 *
 *                      I-frames                    P-frames
 *     before      mean 472 KB  max 737 KB     mean 76 KB  max 449 KB
 *     after       mean 360 KB  max 451 KB     mean 93 KB  max 398 KB
 *
 * 737 KB inside 125 ms is a 47 Mbit/s burst out of a stream whose nominal rate is 8. MediaMTX
 * responded with `reader is too slow, discarding 458 frames`, dropped part of the GOP, and what
 * reached the decoder was a truncated I-frame: `Invalid level prefix`, `concealing 3966 DC errors
 * in I frame`, `corrupt decoded frame`. Feed that to a cheap decoder and it locks up until
 * somebody power-cycles it.
 *
 * With the ceiling halved, the same 45-second run produced zero decoder errors and zero discards,
 * and the timetable itself is visually unchanged — the flat content never came near the old
 * ceiling, which is exactly why this only ever showed when a picture was on screen.
 *
 * The check is on the ARGUMENTS rather than on a stream, because the fault is a number: no amount
 * of rendering proves anything a reading of `-bufsize` against `-maxrate` does not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { timetableArgs, STATIC_FPS } from './renderer';

const D1080 = { width: 1920, height: 1080 };
const D720 = { width: 1280, height: 720 };
const TICKER = {
  text: 'Jumu’ah at 1:30 PM',
  textfile: '/tmp/t.txt',
  fontfile: '/tmp/f.ttf',
  speed: 5,
  prohibited: false,
  color: '#ffffff',
};

/** Pull a numeric `-flag 1234k` value out of the argument list. */
function kbits(args: string[], flag: string): number {
  const i = args.indexOf(flag);
  assert.ok(i >= 0, `${flag} is not in the arguments at all`);
  const m = /^(\d+)k$/.exec(args[i + 1]);
  assert.ok(m, `${flag} is "${args[i + 1]}", which is not a kbit value`);
  return Number(m[1]);
}

/**
 * The most a single frame may burst, as a multiple of the nominal bitrate.
 *
 * A frame may be as large as `bufsize` and must leave inside one slot of `1/fps` seconds, so the
 * instantaneous rate is `bufsize * fps`. Expressed against the nominal rate that is
 * `bufsize / bitrate * fps`. At the old `bufsize = bitrate * 2` and 8 fps it was 16×; it is now 4×.
 *
 * 4 is not a law of nature — it is where the measured discards and decoder errors stopped. Lower
 * would be safer and would start to cost picture quality on a photo; the point of pinning it is
 * that raising it again should be a decision somebody takes on purpose.
 */
const MAX_BURST_MULTIPLE = 4;

for (const [label, dims] of [['1080p', D1080], ['720p', D720]] as const) {
  test(`a single frame cannot burst more than ${MAX_BURST_MULTIPLE}x the bitrate — ${label}, no ticker`, () => {
    const br = 8000;
    const args = timetableArgs(dims, 'rtsp://x/y', null, dims, br);
    const bufsize = kbits(args, '-bufsize');
    const maxrate = kbits(args, '-maxrate');
    assert.equal(maxrate, br, 'the stream should still be capped at its nominal rate');
    // Without a ticker the output runs at STATIC_FPS.
    const burst = (bufsize / br) * STATIC_FPS;
    assert.ok(
      burst <= MAX_BURST_MULTIPLE,
      `one frame may hold ${bufsize}k and must leave in 1/${STATIC_FPS}s, which is ${burst}x the ` +
        `${br}k nominal rate. That is what truncated an I-frame and hung a decoder box.`,
    );
  });
}

test('the ceiling holds whatever bitrate a masjid sets', () => {
  // The bitrate is configurable per timetable, so the relationship has to be proportional rather
  // than a number that happens to work at the default.
  for (const br of [1500, 2500, 4000, 6000, 8000, 12000, 20000]) {
    const args = timetableArgs(D1080, 'rtsp://x/y', null, D1080, br);
    const bufsize = kbits(args, '-bufsize');
    assert.ok(
      bufsize <= br / 2,
      `at ${br}k the buffer is ${bufsize}k; it must stay at or under half the bitrate`,
    );
  }
});

test('the stream is still constant bitrate, which is what cheap decoders want', () => {
  // The fix must not have quietly turned the stream into VBR: `-maxrate` equal to `-b:v`, plus
  // x264's own CBR mode, is what keeps a decoder's input predictable.
  const args = timetableArgs(D1080, 'rtsp://x/y', null, D1080, 8000);
  assert.equal(kbits(args, '-b:v'), kbits(args, '-maxrate'), 'maxrate must equal the target bitrate');
  assert.ok(
    args.some((a) => a.includes('nal-hrd=cbr')),
    'the timetable stream is CBR on purpose; that is the mode decoders handle best',
  );
  assert.ok(
    args.some((a) => a.includes('repeat-headers=1')),
    'SPS/PPS must repeat so a decoder joining mid-stream can start',
  );
});

test('a ticker does not loosen the ceiling', () => {
  // With a ticker the pipeline feeds genuine frames at TICKER_FPS instead of upsampling, so the
  // slot is SHORTER and the same buffer bursts harder. The buffer must not grow to compensate.
  const br = 8000;
  const plain = kbits(timetableArgs(D1080, 'rtsp://x/y', null, D1080, br), '-bufsize');
  const withTicker = kbits(timetableArgs(D1080, 'rtsp://x/y', TICKER, D1080, br), '-bufsize');
  assert.equal(withTicker, plain, 'the frame-size ceiling should not depend on whether a ticker is on');
});
