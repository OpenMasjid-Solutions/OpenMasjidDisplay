// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Display, sameTarget, type Target } from './display';
import type { Platform, Proc } from './platform';
import type { NodeCapsMsg, NodeHealthMsg } from '../../../packages/protocol/src/index';

class P implements Proc {
  running = true;
  stops = 0;
  private cbs: Array<(i: { code: number | null; signal: string | null }) => void> = [];
  onExit(cb: (i: { code: number | null; signal: string | null }) => void): void {
    this.cbs.push(cb);
  }
  async stop(): Promise<void> {
    this.stops += 1;
    this.running = false;
  }
  crash(): void {
    this.running = false;
    for (const cb of this.cbs) cb({ code: 1, signal: null });
  }
}

class Plat implements Platform {
  procs: P[] = [];
  kiosks = 0;
  players = 0;
  blanks = 0;
  serial(): string { return 's'; }
  model(): string { return 'm'; }
  caps(): NodeCapsMsg { return { codecs: ['h264'], maxHeight: 1080, maxFps: 30 }; }
  health(): NodeHealthMsg { return {}; }
  clockSynced(): boolean { return true; }
  startKiosk(): Proc { this.kiosks += 1; const p = new P(); this.procs.push(p); return p; }
  startPlayer(): Proc { this.players += 1; const p = new P(); this.procs.push(p); return p; }
  blank(): void { this.blanks += 1; }
  reboot(): void {}
  wipeData(): void {}
  get live(): P | undefined { return this.procs.filter((p) => p.running).slice(-1)[0]; }
}

const events = () => {
  const restarts: number[] = [];
  const gaveUp: string[] = [];
  return { restarts, gaveUp, onRestart: (_m: string, n: number) => restarts.push(n), onGaveUp: (_m: string, d: string) => gaveUp.push(d) };
};

const TT: Target = { mode: 'timetable', url: 'http://127.0.0.1/' };
const CAM: Target = { mode: 'stream', url: 'rtsp://cam/1', transport: 'tcp' };

test('only ONE process runs at a time (512 MB is the whole design constraint)', async () => {
  const plat = new Plat();
  const d = new Display(plat, events(), (fn) => setTimeout(fn, 1));
  await d.show(TT);
  const first = plat.live!;
  await d.show(CAM);
  assert.equal(first.running, false, 'the kiosk must be stopped before the player starts');
  assert.equal(first.stops, 1);
  assert.equal(plat.procs.filter((p) => p.running).length, 1);
  await d.stop();
});

test('showing the same thing again is a no-op (the 15s reconcile must not relaunch)', async () => {
  const plat = new Plat();
  const d = new Display(plat, events(), (fn) => setTimeout(fn, 1));
  await d.show(TT);
  await d.show({ mode: 'timetable', url: 'http://127.0.0.1/' });
  await d.show({ ...TT });
  assert.equal(plat.kiosks, 1, 'the browser must be launched exactly once');
  await d.stop();
});

test('a crash is restarted, and repeated crashes give up rather than loop forever', async () => {
  const plat = new Plat();
  const ev = events();
  const d = new Display(plat, ev, (fn) => setTimeout(fn, 1));
  await d.show(CAM);
  for (let i = 0; i < 8; i++) {
    plat.live?.crash();
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(ev.restarts.length >= 3, `expected restarts, got ${ev.restarts.length}`);
  assert.equal(ev.gaveUp.length, 1, 'it must stop retrying eventually');
  assert.match(ev.gaveUp[0], /code 1/, 'and report why');
  await d.stop();
});

test("'off' blanks the output and runs no process", async () => {
  const plat = new Plat();
  const d = new Display(plat, events(), (fn) => setTimeout(fn, 1));
  await d.show(TT);
  await d.show({ mode: 'off' });
  assert.equal(plat.blanks, 1);
  assert.equal(d.running, false);
  // A crash callback from the stopped kiosk must not resurrect anything.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(d.mode, 'off');
  await d.stop();
});

test('stop() ends supervision — a crash afterwards does not relaunch', async () => {
  const plat = new Plat();
  const ev = events();
  const d = new Display(plat, ev, (fn) => setTimeout(fn, 1));
  await d.show(CAM);
  await d.stop();
  const players = plat.players;
  plat.procs.forEach((p) => p.crash());
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(plat.players, players, 'nothing may be launched after shutdown');
  assert.equal(ev.gaveUp.length, 0);
});

test('sameTarget compares by value, including the transport', () => {
  assert.equal(sameTarget(TT, { mode: 'timetable', url: 'http://127.0.0.1/' }), true);
  assert.equal(sameTarget(TT, { mode: 'timetable', url: 'http://127.0.0.1/other' }), false);
  assert.equal(sameTarget(CAM, { mode: 'stream', url: 'rtsp://cam/1', transport: 'tcp' }), true);
  assert.equal(sameTarget(CAM, { mode: 'stream', url: 'rtsp://cam/1', transport: 'udp' }), false);
  assert.equal(sameTarget({ mode: 'off' }, { mode: 'off' }), true);
  assert.equal(sameTarget({ mode: 'off' }, TT), false);
  assert.equal(sameTarget(TT, { mode: 'status_screen', url: 'http://127.0.0.1/' }), false);
});
