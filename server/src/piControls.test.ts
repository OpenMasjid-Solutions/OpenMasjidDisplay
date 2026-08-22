// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The controls that reach past the app and into the board itself.
 *
 * Everything here shares one shape: a string or a number chosen in a browser ends up in the boot
 * partition, on a command line root runs, or as the size of a buffer this process allocates. So the
 * tests are about REFUSAL, not about the happy path — and about one property in particular, which
 * is easy to lose and expensive to lose quietly: **this side's check is not the one that protects
 * the device.** Root re-checks every payload on the Pi, because a check on the far side of a network
 * from the thing running the command is a courtesy to whoever is typing, not a boundary.
 *
 * The turn-the-picture functions are tested differently — they are pure arithmetic on pixel buffers,
 * and the reason they exist at all is that the documented firmware alternatives do nothing on this
 * hardware. So they are checked against actual pixels, at actual corners, in every orientation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normTimezone, normHostname, normTimeOfDay, normVideoMode, normDisplayTransform, PI_COMMANDS } from './piAgent';
import { rotateRgba, overscanBox, blitCentered, fitMode } from './pi/raster';
import { looksLikePng, SCREENSHOT_MAX_BYTES } from './piScreenshot';

// ── timezone ────────────────────────────────────────────────────────────────

test('a timezone has to look like an IANA name', () => {
  for (const ok of ['UTC', 'Europe/London', 'America/New_York', 'America/Argentina/Salta', 'Etc/GMT+3']) {
    assert.deepEqual(normTimezone(ok), { text: ok }, `${ok} should be accepted`);
  }
  for (const bad of [
    // The shapes that matter: anything that could climb out of /usr/share/zoneinfo, and anything
    // that could mean something else to a shell. This string reaches a command line on the device.
    '../../etc/passwd',
    'Europe/London; reboot',
    'Europe/London && rm -rf /',
    '$(id)',
    'Europe/London\nUTC',
    'Europe/../../root',
    '/etc/shadow',
    'a'.repeat(65),
    '',
    '   ',
    42,
    null,
    { toString: () => 'UTC' },
  ]) {
    assert.ok('error' in normTimezone(bad), `${JSON.stringify(String(bad))} should be refused`);
  }
});

test('the device checks the timezone again, and against something this side cannot know', () => {
  // The point of the note in normTimezone: a character filter cannot tell whether a zone EXISTS.
  // Root's arm does, by looking in /usr/share/zoneinfo, and that is what makes the pair sufficient.
  const install = fs.readFileSync(path.resolve(__dirname, '..', 'assets', 'pi', 'install.sh'), 'utf8');
  const arm = install.slice(install.indexOf('    set-timezone)'), install.indexOf('    set-hostname)'));
  assert.ok(/\/usr\/share\/zoneinfo\//.test(arm), 'root must require the zone to exist on the device');
  // The `+` needs escaping: unescaped it is a quantifier on the `/` before it, so this asserted
  // "an underscore followed by one or more slashes" and quietly did not check the filter at all.
  assert.ok(/\[!A-Za-z0-9_\/\+-\]/.test(arm), 'and re-filter the characters itself');
});

// ── hostname ────────────────────────────────────────────────────────────────

test('a hostname is one lower-case DNS label', () => {
  assert.deepEqual(normHostname('main-hall'), { text: 'main-hall' });
  // Lower-cased rather than refused: Linux accepts mixed case and then everything that compares
  // hostnames disagrees about it.
  assert.deepEqual(normHostname('MainHall'), { text: 'mainhall' });
  for (const bad of ['-leading', 'trailing-', 'has space', 'has_underscore', 'a.b', 'x'.repeat(64), '', '..']) {
    assert.ok('error' in normHostname(bad), `${JSON.stringify(bad)} should be refused`);
  }
});

test('setting a hostname fixes /etc/hosts too', () => {
  // Without this the box resolves its own name by asking DNS, and every sudo waits for that to time
  // out. It looks like a slow machine rather than a missing line in a file.
  const install = fs.readFileSync(path.resolve(__dirname, '..', 'assets', 'pi', 'install.sh'), 'utf8');
  const arm = install.slice(install.indexOf('    set-hostname)'), install.indexOf('    os-update)'));
  assert.ok(/\/etc\/hosts/.test(arm), 'root must update /etc/hosts alongside the hostname');
  assert.ok(/127\\?\.0\\?\.1\\?\.1/.test(arm), 'specifically the 127.0.1.1 line');
});

// ── times of day ────────────────────────────────────────────────────────────

test('a schedule time is HH:MM in 24-hour form, or nothing at all', () => {
  for (const ok of ['00:00', '23:59', '05:30', '12:00']) assert.equal(normTimeOfDay(ok), ok);
  // Everything else falls back rather than throwing: the caller decides whether an empty time is an
  // error, and for the nightly schedule it is only an error when the schedule is being turned ON.
  for (const bad of ['24:00', '7:30', '19:60', '19:5', 'midnight', '', '19:30:00', 1930, null]) {
    assert.equal(normTimeOfDay(bad), '', `${JSON.stringify(bad)} should not be accepted`);
  }
  assert.equal(normTimeOfDay('nonsense', '03:00'), '03:00', 'and the fallback is honoured');
});

// ── the display mode: the one that can leave a screen black ─────────────────

test('a forced display mode is auto, or WIDTHxHEIGHT, or WIDTHxHEIGHT@RATE', () => {
  for (const ok of ['auto', '1920x1080', '1920x1080@60', '1280x720', '800x600', '3840x2160@30']) {
    assert.deepEqual(normVideoMode(ok), { text: ok });
  }
  assert.deepEqual(normVideoMode('1920X1080@60'), { text: '1920x1080@60' }, 'case-folded, not refused');
  for (const bad of [
    '1920x1080 video=HDMI-A-1:640x480',
    '1920x1080 init=/bin/sh',
    '1920x1080@60 rw',
    'auto rootwait',
    '19200x1080',
    '1920x1080@6',
    '1920*1080',
    '',
    null,
  ]) {
    assert.ok('error' in normVideoMode(bad), `${JSON.stringify(bad)} should be refused`);
  }
});

test('the mode change is reversible without anybody visiting the masjid', () => {
  // This is the ONE setting that can leave a television black, and a black television cannot be
  // used to undo it. Four things have to hold, and all four are load-bearing.
  const install = fs.readFileSync(path.resolve(__dirname, '..', 'assets', 'pi', 'install.sh'), 'utf8');
  const arm = install.slice(install.indexOf('    set-video-mode)'), install.indexOf('    keep-video-mode)'));

  assert.ok(/omd-bak/.test(arm), 'the old command line is kept');
  assert.ok(/video-mode-pending/.test(arm), 'a marker says the change is provisional');
  assert.ok(/systemctl enable omd-video-revert\.timer/.test(arm), 'and the boot-time revert is armed');
  // A second change while the first is unconfirmed would back up the ALREADY-CHANGED command line,
  // so the revert would then restore a mode nobody asked for. Refused, not queued.
  assert.ok(/already waiting to be confirmed/.test(arm), 'a second change is refused while one is pending');

  const rev = install.slice(install.indexOf('cat > "$PREFIX/video-revert.sh"'), install.indexOf('chmod 700 "$PREFIX/video-revert.sh"'));
  assert.ok(/OnBootSec/.test(install), 'the revert runs on a boot timer');
  assert.ok(/systemctl disable omd-video-revert\.timer/.test(rev), 'and stands itself down either way');
  assert.ok(/reboot/.test(rev), 'a reverted command line needs another boot to take effect');
  // Persistent=true would replay a missed run from a boot that happened while the board was off,
  // reverting a mode somebody confirmed weeks earlier.
  assert.ok(/Persistent=false/.test(install), 'the revert timer must not be persistent');
});

test('confirming a mode is a separate verb, and it is the only thing that stops the revert', () => {
  assert.ok(PI_COMMANDS.includes('keep-video-mode'));
  assert.ok(PI_COMMANDS.includes('set-video-mode'));
  const install = fs.readFileSync(path.resolve(__dirname, '..', 'assets', 'pi', 'install.sh'), 'utf8');
  const keep = install.slice(install.indexOf('    keep-video-mode)'), install.indexOf('    set-timezone)'));
  assert.ok(/rm -f "\$STATEDIR\/video-mode-pending"/.test(keep), 'it drops the marker');
  assert.ok(/systemctl disable omd-video-revert\.timer/.test(keep), 'and disarms the timer');
});

test('rotation and overscan are NOT privileged verbs', () => {
  // The whole reason they are done in the frame: they need no root, no reboot, and cannot leave a
  // screen black. A verb for either would be a boot-partition edit for something free.
  for (const v of PI_COMMANDS) {
    assert.ok(!/rotate|rotation|overscan/.test(v), `${v} should not exist — see pi/raster.ts`);
  }
});

// ── how a screen is mounted ─────────────────────────────────────────────────

test('a rotation is one of exactly four values', () => {
  for (const r of [90, 180, 270]) assert.equal(normDisplayTransform({ rotate: r }).rotate, r);
  // Anything else becomes 0 rather than an error: the index arithmetic in rotateRgba only holds for
  // those four, and a screen drawn upright is the right failure.
  for (const bad of [45, 91, -90, 360, '90deg', null, undefined, NaN, Infinity]) {
    assert.equal(normDisplayTransform({ rotate: bad }).rotate, 0, `rotate ${String(bad)} should fall back`);
  }
  assert.equal(normDisplayTransform(null).rotate, 0, 'and a missing object is not a crash');
});

test('overscan is bounded, because it becomes a render size', () => {
  assert.equal(normDisplayTransform({ overscan: 5 }).overscan, 5);
  assert.equal(normDisplayTransform({ overscan: 99 }).overscan, 15, 'clamped, not honoured');
  for (const bad of [-5, 0, 'lots', null, NaN]) {
    assert.equal(normDisplayTransform({ overscan: bad }).overscan, 0);
  }
});

test('an overscan box is smaller than the screen and never degenerate', () => {
  assert.deepEqual(overscanBox(1920, 1080, 0), { width: 1920, height: 1080 }, 'off means untouched');
  const five = overscanBox(1920, 1080, 5);
  assert.equal(five.width, 1728, '5% per edge leaves 90%');
  assert.equal(five.height, 972);
  // A value out of range must not produce a zero-sized render target, which resvg would refuse.
  for (const p of [15, 99, -1, NaN]) {
    const b = overscanBox(1920, 1080, p);
    assert.ok(b.width >= 16 && b.height >= 16, `${p} produced ${b.width}x${b.height}`);
    assert.ok(b.width <= 1920 && b.height <= 1080, `${p} produced something larger than the screen`);
  }
});

// ── turning the picture ─────────────────────────────────────────────────────

/** A 2x3 frame whose every pixel is identifiable: red channel = x, green = y. */
function grid(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      px[i] = x + 1;
      px[i + 1] = y + 1;
      px[i + 2] = 0;
      px[i + 3] = 255;
    }
  }
  return px;
}

const at = (f: { pixels: Uint8Array; width: number }, x: number, y: number): [number, number] => {
  const i = (y * f.width + x) * 4;
  return [f.pixels[i], f.pixels[i + 1]];
};

test('a quarter turn moves the top-left corner to the top-right, and swaps the size', () => {
  const src = grid(2, 3); // 2 wide, 3 tall
  const out = rotateRgba(src, 2, 3, 90);
  assert.equal(out.width, 3, 'the axes swap');
  assert.equal(out.height, 2);
  // 90 is a clockwise rotation OF THE PICTURE: the pixel that was at the top-left is now at the
  // top-right. Which means it is the setting for a television mounted ANTIclockwise — the two are
  // opposite by definition, and the panel's labels name the mounting rather than this number.
  assert.deepEqual(at(out, 2, 0), [1, 1], 'the old (0,0) is now at the right-hand end of the top row');
  assert.deepEqual(at(out, 0, 0), [1, 3], 'and the old bottom-left is now the top-left');
});

test('the panel offers the rotation that CORRECTS each mounting, not the one that names it', () => {
  // The mistake this exists to catch is a screen that comes back upside down in the other
  // direction. It was made once: the picture was verified against a real frame off a real board and
  // the labels were the wrong way round, because "turned right" reads like it should be 90.
  const ui = fs.readFileSync(path.resolve(__dirname, '..', '..', 'web', 'src', 'routes', 'PiDisplayPanel.tsx'), 'utf8');
  const from = ui.indexOf('const ROTATIONS = [');
  const block = from < 0 ? '' : ui.slice(from, ui.indexOf('] as const;', from));
  assert.ok(block, 'could not find the rotation list in the panel');
  // Plain string matching, not a regex: every character here is a brace or a quote, and escaping
  // that into a pattern is how the assertion stops meaning anything.
  assert.ok(
    block.includes("{ v: 270, label: 'Turned clockwise' }"),
    'a set turned clockwise needs the picture turned back the other way',
  );
  assert.ok(block.includes("{ v: 90, label: 'Turned anticlockwise' }"), 'and vice versa');
});

test('270 is the other way, and 90 then 270 is the identity', () => {
  const src = grid(4, 3);
  const once = rotateRgba(src, 4, 3, 90);
  const back = rotateRgba(once.pixels, once.width, once.height, 270);
  assert.equal(back.width, 4);
  assert.equal(back.height, 3);
  assert.deepEqual([...back.pixels], [...src], 'a turn each way must land exactly where it started');
});

test('180 keeps the size and reverses the picture', () => {
  const src = grid(4, 3);
  const out = rotateRgba(src, 4, 3, 180);
  assert.equal(out.width, 4);
  assert.equal(out.height, 3);
  assert.deepEqual(at(out, 3, 2), [1, 1], 'the top-left is now the bottom-right');
  assert.deepEqual(at(out, 0, 0), [4, 3], 'and the bottom-right is now the top-left');
  // Twice is the identity, which is the cheapest check that no pixel was dropped or duplicated.
  const twice = rotateRgba(out.pixels, out.width, out.height, 180);
  assert.deepEqual([...twice.pixels], [...src]);
});

test('no rotation copies nothing at all', () => {
  const src = grid(4, 3);
  const out = rotateRgba(src, 4, 3, 0);
  assert.equal(out.pixels, src, 'the common case must not allocate a second frame every second');
});

test('a rotated frame still lands letterboxed in the framebuffer it is drawn to', () => {
  // The whole chain, as Screen.show runs it: a portrait design, fitted to a sideways screen, turned,
  // then centred in a LANDSCAPE framebuffer. What comes out has to be exactly the framebuffer's
  // size, or the write is sheared.
  // A LANDSCAPE design on a screen turned on its side, which is the case somebody actually hits:
  // they mount the television in a corridor and keep the timetable they already had.
  const fb = { w: 1920, h: 1080 };
  const box = overscanBox(fb.w, fb.h, 0);
  const fit = fitMode(1920, 1080, box.height, box.width); // swapped, as a quarter turn requires
  assert.deepEqual(fit, { mode: 'width', value: 1080 }, 'a 16:9 design in a 9:16 space is limited by width');
  const rendered = grid(1080, 607); // what resvg returns for that fit
  const turned = rotateRgba(rendered, 1080, 607, 90);
  assert.equal(turned.width, 607, 'a wide design becomes a narrow one');
  assert.equal(turned.height, 1080);
  const frame = blitCentered(turned.pixels, turned.width, turned.height, fb.w, fb.h);
  assert.equal(frame.length, fb.w * fb.h * 4, 'exactly the framebuffer, whatever the design was');
  // And the margin is black — that is what makes a sideways television look deliberate.
  assert.deepEqual([...frame.subarray(0, 4)], [0, 0, 0, 0], 'the corner outside the picture stays black');
});

// ── the picture of the screen ───────────────────────────────────────────────

test('a screenshot has to actually be a PNG', () => {
  // This is the one file in the app whose bytes come from a device and are served back to a browser
  // as an image. Serving something else as image/png is how a stored-XSS gets in — and Node's base64
  // decoder ignores junk rather than failing, so the signature check is the only gate there is.
  assert.ok(looksLikePng(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])));
  assert.ok(!looksLikePng(Buffer.from('<svg onload=alert(1)>')));
  assert.ok(!looksLikePng(Buffer.from([137, 80, 78, 71])), 'a truncated signature is not one');
  assert.ok(!looksLikePng(Buffer.alloc(0)));
});

test('the upload cap and the route cap are derived from each other', () => {
  // The same shape of bug as the check-in cap that silently discarded every check-in for weeks: two
  // limits in different files that have to agree, with nothing checking that they do. Base64 inflates
  // by a third, so the route has to accept meaningfully more than the file is allowed to be.
  const api = fs.readFileSync(path.resolve(__dirname, 'api.ts'), 'utf8');
  const m = /readBody\(req, Math\.round\(SCREENSHOT_MAX_BYTES \* ([\d.]+)\) \+ ([\d_]+)\)/.exec(api);
  assert.ok(m, 'the screenshot route must size its body cap from SCREENSHOT_MAX_BYTES');
  const routeCap = Math.round(SCREENSHOT_MAX_BYTES * Number(m[1])) + Number(m[2].replace(/_/g, ''));
  const encoded = Math.ceil(SCREENSHOT_MAX_BYTES / 3) * 4;
  assert.ok(
    routeCap >= encoded,
    `the biggest allowed PNG encodes to ${encoded} bytes and the route only accepts ${routeCap}`,
  );
});

test('the agent builds the PNG itself rather than adding a package to every screen', () => {
  // In pi/framebuffer.ts, next to the geometry it reads and the pack it is the inverse of, rather
  // than in the agent — which also means it can be run against a captured framebuffer through
  // OMD_SCREEN_FB, the way everything else in that file can.
  const agent = fs.readFileSync(path.resolve(__dirname, 'pi', 'framebuffer.ts'), 'utf8');
  assert.ok(/zlib/.test(agent), 'zlib is in node; fbgrab and raspi2png are not on the image');
  // Comments stripped before scanning. Naming the tools we chose NOT to use is exactly what the
  // comment above framebufferPng does, and a scan that cannot tell code from prose has now been
  // defeated by its own documentation five times in this repository.
  const code = agent.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/fbgrab|raspi2png|scrot/.test(code), 'no external screenshot tool may be relied on');
  // 16bpp is the REAL case on this hardware — measured, and config.txt's framebuffer_depth=32 does
  // not change it under KMS. A 32bpp path that assumed itself would produce a blue-tinted smear.
  assert.ok(/RGB565|565/.test(agent), 'the 16bpp framebuffer has to be unpacked, not copied');
});
