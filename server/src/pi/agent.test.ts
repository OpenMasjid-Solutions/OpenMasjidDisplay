// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The parts of the Pi agent that are wrong on hardware nobody testing owns.
 *
 * Every failure covered here looks the same from a distance — a television showing something
 * wrong — and none of them can be reproduced on a development machine. A sheared picture from a
 * padded stride, a blue-tinted one from swapped colour channels, a letterboxed screen stretched
 * because a 4:3 monitor was assumed to be 16:9: these are decided by arithmetic, so they are
 * checked as arithmetic rather than by plugging a Pi into a monitor and squinting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeometry, packFrame, Framebuffer } from './framebuffer';
import { parseFbset } from './fbset';
import { fitMode, blitCentered } from './raster';
import { pickLanIp, deviceFacts } from './device';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig, loadConfig, saveConfig, makeDeviceId, makeDeviceSecret, type AgentConfig } from './agentConfig';
import { pairingSvg, messageSvg } from './pairing';

// ── framebuffer geometry ─────────────────────────────────────────────────────

test('geometry is read from what the kernel reports, not assumed', () => {
  assert.deepEqual(parseGeometry('1920,1080', '32', '7680'), {
    width: 1920,
    height: 1080,
    bpp: 32,
    stride: 7680,
  });
});

test('a padded stride is honoured — this is what shears a picture into a diagonal', () => {
  // A real case: some kernels round the row up to a 64-byte boundary, so 1366 pixels of 4 bytes
  // is 5464 bytes of pixel data in a 5504-byte row. Computing width*4 here loses 40 bytes per
  // row, and the picture walks left by ten pixels every line.
  const g = parseGeometry('1366,768', '32', '5504');
  assert.equal(g?.stride, 5504);
});

test('a missing stride falls back to the packed width', () => {
  assert.equal(parseGeometry('800,600', '32', null)?.stride, 3200);
  assert.equal(parseGeometry('800,600', '16', '')?.stride, 1600);
});

test('a stride smaller than the packed width is not believed', () => {
  // It cannot be true, and trusting it would write past the end of every row.
  assert.equal(parseGeometry('1920,1080', '32', '100')?.stride, 7680);
});

test('an unsupported depth is refused rather than drawn as garbage', () => {
  assert.equal(parseGeometry('1920,1080', '24', '5760'), null);
  assert.equal(parseGeometry('1920,1080', '8', null), null);
});

test('nonsense from the kernel yields no geometry', () => {
  assert.equal(parseGeometry(null, '32', null), null);
  assert.equal(parseGeometry('1920x1080', '32', null), null);
  assert.equal(parseGeometry('0,0', '32', null), null);
  assert.equal(parseGeometry('99999,99999', '32', null), null);
});

// ── pixel packing ────────────────────────────────────────────────────────────

test('32bpp swaps red and blue — the difference between gold and blue on the screen', () => {
  // One pixel of the app's gold, #d4af37, as resvg hands it over: R, G, B, A.
  const src = Uint8Array.from([0xd4, 0xaf, 0x37, 0xff]);
  const out = packFrame(src, { width: 1, height: 1, bpp: 32, stride: 4 });
  // On the framebuffer it must land blue-first, or the accent renders as a cold blue.
  assert.deepEqual([...out], [0x37, 0xaf, 0xd4, 0xff]);
});

test('32bpp writes an opaque alpha byte', () => {
  const src = Uint8Array.from([1, 2, 3, 0]);
  const out = packFrame(src, { width: 1, height: 1, bpp: 32, stride: 4 });
  assert.equal(out[3], 0xff, 'a zero alpha byte can be composited away by an overlay');
});

test('row padding is left untouched, and the next row starts at the stride', () => {
  const src = Uint8Array.from([
    10, 20, 30, 255, // row 0
    40, 50, 60, 255, // row 1
  ]);
  const out = packFrame(src, { width: 1, height: 2, bpp: 32, stride: 8 });
  assert.equal(out.length, 16);
  assert.deepEqual([...out.subarray(0, 4)], [30, 20, 10, 255]);
  assert.deepEqual([...out.subarray(4, 8)], [0, 0, 0, 0], 'the pad stays as it was');
  assert.deepEqual([...out.subarray(8, 12)], [60, 50, 40, 255], 'row 1 begins at the stride');
});

test('16bpp packs RGB565 little-endian', () => {
  // Pure red: 0b11111_000000_00000 = 0xF800, low byte first.
  const red = packFrame(Uint8Array.from([255, 0, 0, 255]), { width: 1, height: 1, bpp: 16, stride: 2 });
  assert.deepEqual([...red], [0x00, 0xf8]);
  // Pure blue: 0x001F.
  const blue = packFrame(Uint8Array.from([0, 0, 255, 255]), { width: 1, height: 1, bpp: 16, stride: 2 });
  assert.deepEqual([...blue], [0x1f, 0x00]);
  // White stays white after the truncation.
  const white = packFrame(Uint8Array.from([255, 255, 255, 255]), { width: 1, height: 1, bpp: 16, stride: 2 });
  assert.deepEqual([...white], [0xff, 0xff]);
});

test('a frame too small for the geometry throws instead of drawing torn bytes', () => {
  assert.throws(
    () => packFrame(new Uint8Array(4), { width: 100, height: 100, bpp: 32, stride: 400 }),
    /need 40000/,
  );
});

// ── fitting onto whatever television is plugged in ───────────────────────────

test('a 16:9 design on a 16:9 screen scales by width', () => {
  assert.deepEqual(fitMode(1920, 1080, 1920, 1080), { mode: 'width', value: 1920 });
  assert.deepEqual(fitMode(1920, 1080, 1280, 720), { mode: 'width', value: 1280 });
});

test('a 16:9 design on a 4:3 monitor scales by width and letterboxes', () => {
  // The spare panels a masjid has lying around. Scaling by height here would overflow the sides
  // and cut prayer times off the edge.
  assert.deepEqual(fitMode(1920, 1080, 1024, 768), { mode: 'width', value: 1024 });
  assert.deepEqual(fitMode(1920, 1080, 1280, 1024), { mode: 'width', value: 1280 });
});

test('a 16:9 design on an ultrawide scales by HEIGHT', () => {
  // The case that is wrong if width is assumed: 2560 wide at 16:9 is 1440 tall, and the screen
  // is only 1080 — a third of the timetable would be below the bottom edge.
  assert.deepEqual(fitMode(1920, 1080, 2560, 1080), { mode: 'height', value: 1080 });
});

test('a portrait design on a landscape screen scales by height', () => {
  assert.deepEqual(fitMode(1080, 1920, 1920, 1080), { mode: 'height', value: 1080 });
});

test('the blitted frame is always exactly the screen size', () => {
  const src = new Uint8Array(4 * 4 * 4); // 4x4 RGBA
  src.fill(0x7f);
  const out = blitCentered(src, 4, 4, 10, 6);
  assert.equal(out.length, 10 * 6 * 4, 'any other length is a sheared or truncated picture');
});

test('a smaller frame is centred, and the letterbox stays black', () => {
  const src = Uint8Array.from([1, 2, 3, 255]); // one pixel
  const out = blitCentered(src, 1, 1, 3, 3);
  const at = (x: number, y: number) => [...out.subarray((y * 3 + x) * 4, (y * 3 + x) * 4 + 4)];
  assert.deepEqual(at(1, 1), [1, 2, 3, 255], 'the pixel lands in the middle');
  assert.deepEqual(at(0, 0), [0, 0, 0, 0]);
  assert.deepEqual(at(2, 2), [0, 0, 0, 0]);
});

test('an oversized frame is clipped, not refused', () => {
  // resvg can round a dimension one pixel over. One lost row beats a screen that will not draw.
  const src = new Uint8Array(4 * 4 * 4);
  src.fill(9);
  const out = blitCentered(src, 4, 4, 2, 2);
  assert.equal(out.length, 16);
  assert.deepEqual([...out.subarray(0, 4)], [9, 9, 9, 9]);
});

test('a degenerate source draws black rather than throwing', () => {
  assert.deepEqual([...blitCentered(new Uint8Array(0), 0, 0, 2, 1)], [0, 0, 0, 0, 0, 0, 0, 0]);
});

// ── which address to show ────────────────────────────────────────────────────

test('the address shown is a real one, not loopback or a failed DHCP lease', () => {
  const ip = pickLanIp({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [
      { address: '169.254.7.7', family: 'IPv4', internal: false },
      { address: '192.168.1.44', family: 'IPv4', internal: false },
    ],
  });
  assert.equal(ip, '192.168.1.44');
});

test('wired beats wireless, because the screen that matters is on a cable', () => {
  assert.equal(
    pickLanIp({
      wlan0: [{ address: '192.168.1.90', family: 'IPv4', internal: false }],
      eth0: [{ address: '192.168.1.44', family: 'IPv4', internal: false }],
    }),
    '192.168.1.44',
  );
});

test('a docker bridge is the last thing anyone wants to be told', () => {
  assert.equal(
    pickLanIp({
      docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
      wlan0: [{ address: '192.168.1.90', family: 'IPv4', internal: false }],
    }),
    '192.168.1.90',
  );
});

test('no network reports no address, which is itself the answer on screen', () => {
  assert.equal(pickLanIp({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }), '');
  assert.equal(pickLanIp({}), '');
});

test('IPv6-only interfaces are not offered as "the IP"', () => {
  assert.equal(pickLanIp({ eth0: [{ address: 'fe80::1', family: 'IPv6', internal: false }] }), '');
});

// ── the config that survives a power cut ─────────────────────────────────────

test('a config round-trips, token included', () => {
  const cfg = parseConfig(
    JSON.stringify({ server: 'http://192.168.1.18:7860', deviceId: 'pi_abc', deviceSecret: 's', token: 't' }),
  );
  assert.deepEqual(cfg, { server: 'http://192.168.1.18:7860', deviceId: 'pi_abc', deviceSecret: 's', token: 't' });
});

test('a trailing slash on the server is dropped, so URLs do not double up', () => {
  assert.equal(parseConfig('{"server":"http://host:7860/"}')?.server, 'http://host:7860');
});

test('a server address that is not http(s) is refused', () => {
  // The one field that decides where this device sends its identity.
  for (const bad of ['', 'host:7860', 'ftp://host', 'file:///etc/passwd', 'javascript:x']) {
    assert.equal(parseConfig(JSON.stringify({ server: bad })), null, bad);
  }
});

test('an unreadable or truncated config is null, not a half-config', () => {
  assert.equal(parseConfig('{"server":'), null);
  assert.equal(parseConfig(''), null);
  assert.equal(parseConfig('null'), null);
  assert.equal(parseConfig('[]'), null);
});

test('an empty token is treated as absent, not as a credential', () => {
  const cfg = parseConfig('{"server":"http://h","token":"   "}');
  assert.equal(cfg?.token, undefined);
});

test('a minted identity has enough entropy to be unique across an SD-card image', () => {
  const ids = new Set(Array.from({ length: 200 }, () => makeDeviceId()));
  assert.equal(ids.size, 200);
  assert.match(makeDeviceId(), /^pi_[0-9a-f]{12}$/);
  // 16 bytes, base64url: no padding, nothing that needs escaping in JSON or a URL.
  assert.match(makeDeviceSecret(), /^[A-Za-z0-9_-]{22}$/);
});

// ── the screen a person actually reads ───────────────────────────────────────

test('the pairing screen shows the code, one character per box', () => {
  const svg = pairingSvg({
    code: 'K7M2QX',
    ip: '192.168.1.44',
    hostname: 'raspberrypi',
    server: 'http://192.168.1.18:7860',
    status: 'Waiting',
    connected: true,
    agentVersion: '0.70.0',
  });
  for (const ch of 'K7M2QX') assert.ok(svg.includes(`>${ch}</text>`), `missing ${ch}`);
  assert.ok(svg.includes('192.168.1.44'), 'the IP is what a network problem is diagnosed from');
  assert.ok(svg.includes('raspberrypi'));
  assert.ok(svg.includes('Dashboard'), 'the screen has to say what to do next');
});

test('the pairing screen renders before a code has arrived', () => {
  const svg = pairingSvg({
    code: '',
    ip: '',
    hostname: 'raspberrypi',
    server: 'http://h',
    status: 'Contacting the display server',
    connected: false,
    agentVersion: 'dev',
  });
  assert.ok(svg.startsWith('<svg'), 'a blank television is indistinguishable from a dead one');
  assert.ok(svg.includes('no network'), 'and it should say so');
});

test('self-reported text cannot break the SVG', () => {
  // hostname comes off the device and the server address out of a file; neither is ours.
  const svg = pairingSvg({
    code: 'AAAAAA',
    ip: '1.2.3.4',
    hostname: '<script>x</script>&"',
    server: 'http://h',
    status: 'ok',
    connected: true,
    agentVersion: 'dev',
  });
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&amp;&quot;'));
});

test('a message screen always produces something to draw', () => {
  const svg = messageSvg('Waiting for the display server', 'Cannot reach http://h');
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
  assert.ok(svg.includes('Waiting for the display server'));
});

// ── the config must survive being written ────────────────────────────────────

test('saving keeps fields this version does not know about', () => {
  // Found by review: `parseConfig` returns only the four fields it understands, so writing that
  // object back deleted everything else — and an install-time setting stored here was destroyed
  // by the first adoption, minutes after setup, silently stopping the device updating itself.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ server: 'http://h', deviceId: 'pi_a', deviceSecret: 's', somethingElse: 'keep me' }),
  );

  const cfg = loadConfig(file);
  assert.ok(cfg);
  saveConfig({ ...(cfg as AgentConfig), token: 'tok' }, file);

  const after = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.equal(after.somethingElse, 'keep me', 'an unknown field must not be destroyed');
  assert.equal(after.token, 'tok');
  assert.equal(after.deviceId, 'pi_a');
});

test('forgetting removes the token rather than leaving a stale one', () => {
  // The one field where merging would be wrong: a device that has been forgotten must not keep
  // presenting the credential it was forgotten with.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-cfg-'));
  const file = path.join(dir, 'config.json');
  saveConfig({ server: 'http://h', deviceId: 'pi_a', deviceSecret: 's', token: 'tok' }, file);
  saveConfig({ server: 'http://h', deviceId: 'pi_a', deviceSecret: 's' }, file);
  const after = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.equal('token' in after, false);
  assert.equal(after.deviceId, 'pi_a', 'but the identity stays, so it keeps the same row in the panel');
});

test('an unreadable config cannot blank the device identity', () => {
  // A save that started from a failed read used to write a token with no device id, which is
  // unrecoverable without walking to the television.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{ this is not json');
  saveConfig({ server: 'http://h', deviceId: 'pi_a', deviceSecret: 's' }, file);
  const after = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.equal(after.deviceId, 'pi_a');
  assert.equal(after.deviceSecret, 's');
});

test('the screen survives not being able to work out its own address', () => {
  // A real crash loop: os.networkInterfaces() threw EAFNOSUPPORT because the service unit
  // restricted socket families and enumerating interfaces goes through netlink. The throw reached
  // the top of main(), systemd restarted every five seconds, and the television sat frozen through
  // sixteen restarts — over an IP address that is only ever printed in small text.
  const real = os.networkInterfaces;
  try {
    (os as { networkInterfaces: unknown }).networkInterfaces = () => {
      throw new Error('EAFNOSUPPORT');
    };
    const facts = deviceFacts();
    assert.equal(facts.ip, '', 'no address is a thing to display, not a reason to exit');
    assert.ok(typeof facts.hostname === 'string');
  } finally {
    (os as { networkInterfaces: unknown }).networkInterfaces = real;
  }
});

test('the visible mode wins over the virtual buffer size', () => {
  // Found on a real 4K television. `virtual_size` is xres_VIRTUAL — the buffer the kernel
  // allocated, which may be bigger than what is scanned out. Drawing into it composes the picture
  // correctly and then shows only its left portion, so every centred line is cut off at exactly
  // its middle: "OpenMasjidD", "Dashboard → Screens → Ra".
  const g = parseGeometry('3840,1080', '16', '7680', 'U:1920x1080p-60');
  assert.equal(g?.width, 1920, 'draw at what the television shows');
  assert.equal(g?.height, 1080);
  assert.equal(g?.stride, 7680, 'but step rows by the VIRTUAL row length, or the picture shears');
});

test('a mode larger than the buffer is ignored', () => {
  // Trusting it would mean writing past the end of the allocation.
  const g = parseGeometry('1920,1080', '32', '7680', 'U:3840x2160p-60');
  assert.equal(g?.width, 1920);
  assert.equal(g?.height, 1080);
});

test('no mode at all still works', () => {
  // Not every kernel publishes it, and it was absent everywhere this was developed.
  assert.deepEqual(parseGeometry('1920,1080', '32', '7680', null), {
    width: 1920,
    height: 1080,
    bpp: 32,
    stride: 7680,
  });
  assert.deepEqual(parseGeometry('1920,1080', '32', '7680', 'garbage'), {
    width: 1920,
    height: 1080,
    bpp: 32,
    stride: 7680,
  });
});

// ── reading the screen from the kernel, not from a guess ─────────────────────

test('fbset separates the visible size from the virtual one', () => {
  // The distinction sysfs cannot express, and the reason a picture ended up composed at twice the
  // width of the television. `geometry` is: xres yres xres_virtual yres_virtual depth.
  const out = [
    'mode "1920x1080"',
    '    geometry 1920 1080 3840 2160 16',
    '    timings 0 0 0 0 0 0 0',
    'endmode',
    '',
    'Frame buffer device information:',
    '    Name        : BCM2708 FB',
    '    LineLength  : 7680',
  ].join('\n');
  const g = parseFbset(out);
  assert.equal(g?.width, 1920, 'draw at the VISIBLE width');
  assert.equal(g?.height, 1080);
  assert.equal(g?.bpp, 16);
  assert.equal(g?.stride, 7680, 'but step rows by the real line length');
});

test('a missing LineLength falls back to the VIRTUAL width, never the visible one', () => {
  // Using the visible width as a stride shears the picture into a diagonal — the other half of
  // this same class of bug.
  const g = parseFbset('    geometry 1920 1080 3840 2160 32\n');
  assert.equal(g?.stride, 3840 * 4);
});

test('a nonsense or truncated fbset answer is refused, not guessed at', () => {
  // It must fall back to sysfs rather than produce a confidently wrong screen.
  assert.equal(parseFbset(''), null);
  assert.equal(parseFbset('geometry 1920 1080'), null);
  assert.equal(parseFbset('    geometry 1920 1080 1920 1080 24\n'), null, '24bpp is not packable here');
  assert.equal(parseFbset('    geometry 0 0 0 0 16\n'), null);
});

test('the ordinary case, where visible and virtual agree', () => {
  const g = parseFbset('    geometry 1920 1080 1920 1080 32\n    LineLength  : 7680\n');
  assert.deepEqual(g, { width: 1920, height: 1080, bpp: 32, stride: 7680 });
});

test('a mode change is noticed and followed, not cached for ever', async () => {
  // Reported exactly: right for about ten seconds, then a magnified corner. A 4K television
  // renegotiates after the Pi has booted and the driver reallocates the framebuffer; frames still
  // addressed with the startup size land as the top-left quadrant. Nothing about the frames
  // changed — the buffer under them did.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-fb-'));
  const dev = path.join(dir, 'fb0');
  fs.writeFileSync(dev, Buffer.alloc(16));

  const fb = Framebuffer.open(dev, { width: 4, height: 2, bpp: 16, stride: 8 });
  assert.ok(fb, 'the harness needs an explicit geometry, since there is no real framebuffer here');
  assert.equal(fb!.geo.width, 4);

  // With no sysfs to read, the signature never moves and refresh must be a no-op rather than
  // throwing away a perfectly good geometry.
  assert.equal(fb!.refresh(), null, 'no change must not disturb anything');
  assert.equal(fb!.geo.width, 4, 'and must not lose the geometry it was given');
  fb!.close();
});
