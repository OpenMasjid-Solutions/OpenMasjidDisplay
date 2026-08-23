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
 * The exception is the nightly reboot, which is tested for the opposite reason: what matters there is
 * not that a value is refused but that an ABSENT one still means something, because every screen is
 * meant to reboot overnight whether or not anybody ever opened this window.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normTimezone, normTimeOfDay, normVideoMode, effectiveRebootSchedule, DEFAULT_REBOOT_AT, PI_COMMANDS } from './piAgent';
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
  const start = install.indexOf('    set-timezone)');
  const end = install.indexOf('    logs)', start);
  assert.ok(start >= 0 && end > start, 'could not find the timezone arm — has the dispatcher been rewritten?');
  const arm = install.slice(start, end);
  assert.ok(/\/usr\/share\/zoneinfo\//.test(arm), 'root must require the zone to exist on the device');
  // The `+` needs escaping: unescaped it is a quantifier on the `/` before it, so this asserted
  // "an underscore followed by one or more slashes" and quietly did not check the filter at all.
  assert.ok(/\[!A-Za-z0-9_\/\+-\]/.test(arm), 'and re-filter the characters itself');
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
  const ks = install.indexOf('    keep-video-mode)');
  const ke = install.indexOf('    set-timezone)', ks);
  assert.ok(ks >= 0 && ke > ks, 'could not find the keep arm');
  const keep = install.slice(ks, ke);
  assert.ok(/rm -f "\$STATEDIR\/video-mode-pending"/.test(keep), 'it drops the marker');
  assert.ok(/systemctl disable omd-video-revert\.timer/.test(keep), 'and disarms the timer');
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

// ── the nightly reboot ──────────────────────────────────────────────────────

test('every screen reboots overnight, including one nobody has configured', () => {
  // The point of this default, and the reason it is a function rather than a fallback written at
  // three call sites: the boards that most need a nightly reboot are the ones in a masjid with
  // nobody technical, and a setting that has to be found and switched on is a setting that stays
  // off. An absent value has to mean "yes, at three", not "no".
  assert.deepEqual(effectiveRebootSchedule({} as never), { enabled: true, at: DEFAULT_REBOOT_AT });
  assert.equal(DEFAULT_REBOOT_AT, '03:00', 'nothing is happening in a prayer hall at three in the morning');

  // But a deliberate no is honoured. A masjid that wants a screen up around the clock has said so,
  // and a default that overrode that would be a screen that reboots itself every night for ever
  // with no way to stop it.
  assert.deepEqual(
    effectiveRebootSchedule({ rebootSchedule: { enabled: false, at: '' } } as never),
    { enabled: false, at: DEFAULT_REBOOT_AT },
  );
  assert.deepEqual(
    effectiveRebootSchedule({ rebootSchedule: { enabled: true, at: '04:15' } } as never),
    { enabled: true, at: '04:15' },
  );
  // An enabled schedule with no time is the one combination that could reboot at an hour nobody
  // chose. It falls back to the default rather than to midnight or to never.
  assert.deepEqual(
    effectiveRebootSchedule({ rebootSchedule: { enabled: true, at: '' } } as never),
    { enabled: true, at: DEFAULT_REBOOT_AT },
  );
});

test('the screen reboots from its OWN clock, so it happens with the internet down', () => {
  // The whole reason this is a schedule carried on the poll rather than a command sent at 3am. And
  // the reason it is evaluated BEFORE the state fetch in the agent's loop: everything after that
  // line is skipped when the server cannot be reached, which is exactly the night it matters.
  const agent = fs.readFileSync(path.resolve(__dirname, 'pi', 'index.ts'), 'utf8');
  const loop = agent.slice(agent.indexOf('const poll = async ()'), agent.indexOf('// ── the check-in ──'));
  const applyAt = loop.indexOf('applyDisplaySchedule(live)');
  const fetchAt = loop.indexOf('/state`');
  assert.ok(applyAt > 0, 'the poll loop must evaluate the schedules');
  assert.ok(applyAt < fetchAt, 'and it must do so before the state fetch, which can fail and skip the rest');
});

// ── the live preview ────────────────────────────────────────────────────────

test('a preview stops on its own when nobody is watching any more', () => {
  // There is no reliable "off": a closed tab, a shut lid and a dropped tunnel all send nothing. So
  // the panel pushes a DEADLINE and the device stops when it lapses. A flag would leave a Pi
  // uploading a picture a second for ever.
  const api = fs.readFileSync(path.resolve(__dirname, 'api.ts'), 'utf8');
  assert.ok(
    /markPreviewWanted\(device\.id, Date\.now\(\) \+ PREVIEW_WINDOW_MS\)/.test(api),
    'the route sets a deadline, not a flag',
  );
  const agent = fs.readFileSync(path.resolve(__dirname, 'pi', 'index.ts'), 'utf8');
  assert.ok(
    /st\.previewUntil && Date\.now\(\) < st\.previewUntil/.test(agent),
    'and the device checks it against its own clock every poll',
  );
});

test('a preview frame is shrunk before it is sent, and re-quantised after', () => {
  // A frame a second of full 1080p is about half a megabyte each, from a Pi, through a masjid's
  // tunnel. Shrinking is what makes the feature reasonable rather than rude.
  const agent = fs.readFileSync(path.resolve(__dirname, 'pi', 'index.ts'), 'utf8');
  assert.ok(/const PREVIEW_SHRINK = [2-4];/.test(agent), 'the preview must not send full-size frames');

  const fbsrc = fs.readFileSync(path.resolve(__dirname, 'pi', 'framebuffer.ts'), 'utf8');
  assert.ok(/const cells = step \* step;/.test(fbsrc), 'the shrink averages rather than samples');
  // And the measured half, which is the part that would be dropped as redundant by somebody reading
  // it fresh. This framebuffer is RGB565 written with an ordered dither; averaging blocks of a
  // dither invents colours that were never in it, and the averaged frame cost THREE TIMES the bytes
  // of a sampled one — 404 KB against 125. Snapping the average back onto the source's own 5/6/5
  // grid recovers that for 14 KB. Remove it and a live preview silently triples its bandwidth.
  assert.ok(/R5 = 255 \/ 31/.test(fbsrc), 'the averaged result must be re-quantised to the source grid');
  assert.ok(/Math\.round\(r \/ cells \/ R5\)/.test(fbsrc), 'and it has to be applied to the pixels');
});
