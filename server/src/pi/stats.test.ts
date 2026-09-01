// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The fixtures are verbatim from the test Pi 4, because the one thing worth getting right here is
 * which memory figure to use — and that is not obvious from the file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLoadAvg, parseMeminfo, parseTemp, buildStats, piStats } from './stats';

const MEMINFO = [
  'MemTotal:        3885748 kB',
  'MemFree:          204112 kB',
  'MemAvailable:    3286132 kB',
  'Buffers:           41232 kB',
  'Cached:          3120044 kB',
].join('\n');

test('memory used comes from MemAvailable, not MemFree', () => {
  // The whole reason this is a named function. MemFree on that Pi is 204MB of 3885MB, which would
  // report a healthy idle board as 95% full — because the kernel has correctly filled the rest with
  // page cache it will hand back the instant anything wants it. MemAvailable is the kernel's own
  // estimate of what a new process could get, which is the question being asked.
  const { usedMb, totalMb } = parseMeminfo(MEMINFO);
  assert.equal(totalMb, 3795);
  assert.equal(usedMb, 586, 'total minus available, not total minus free');
  const free = Math.round((3885748 - 204112) / 1024);
  assert.notEqual(usedMb, free, 'using MemFree would report 3595MB used on an idle board');
});

test('load is reported against the core count, so the number means something', () => {
  const s = buildStats({ loadavg: '2.00 1.80 1.60 2/180 900', meminfo: MEMINFO, temp: '58312', uptimeSec: 3600, cores: 4 });
  assert.equal(s.load1, 2);
  assert.equal(s.cores, 4);
  assert.equal(s.cpuPercent, 50, 'load 2 on 4 cores is half the board');
  // Over capacity is allowed and is the interesting case — it is what "falling behind" looks like.
  assert.equal(buildStats({ loadavg: '6.0 0 0', meminfo: MEMINFO, temp: '0', uptimeSec: 0, cores: 4 }).cpuPercent, 150);
});

test('temperature handles millidegrees and degrees, and refuses nonsense', () => {
  assert.equal(parseTemp('58312'), 58.3);
  assert.equal(parseTemp('58'), 58);
  assert.equal(parseTemp(''), 0);
  assert.equal(parseTemp('0'), 0);
  assert.equal(parseTemp('-40000'), 0);
  assert.equal(parseTemp('999999999'), 0, 'a temperature no board reaches is a bad read');
});

test('a load average that is not a number reads as zero, never NaN', () => {
  // NaN sails through a numeric comparison and ends up as a CSS width.
  assert.equal(parseLoadAvg(''), 0);
  assert.equal(parseLoadAvg('rubbish'), 0);
  assert.equal(parseLoadAvg('-1 0 0'), 0);
  const s = buildStats({ loadavg: 'x', meminfo: '', temp: 'x', uptimeSec: 0, cores: 0 });
  for (const [k, v] of Object.entries(s)) assert.ok(Number.isFinite(v), `${k} is not finite: ${v}`);
  assert.equal(s.cores, 1, 'a zero core count must not divide by zero');
});

test('missing files produce zeros rather than throwing', () => {
  assert.deepEqual(parseMeminfo(''), { usedMb: 0, totalMb: 0 });
  const s = buildStats({ loadavg: '', meminfo: '', temp: '', uptimeSec: 0, cores: 4 });
  assert.equal(s.memPercent, 0, 'no total means no percentage, not a division by zero');
});

test('reading the real machine never throws', () => {
  // Runs on a developer machine too, where none of these files exist.
  const s = piStats();
  for (const [k, v] of Object.entries(s)) assert.ok(Number.isFinite(v), `${k} is not finite`);
});
