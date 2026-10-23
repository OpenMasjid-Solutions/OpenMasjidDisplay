// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A change MediaMTX refused is tried again, not recorded as done.
 *
 * The orchestrator remembers which path config it last applied so it only reloads MediaMTX when
 * something changed. It used to remember the config whether or not MediaMTX accepted it, so one
 * refused PATCH — a screen switched from its timetable to a camera — was never retried, and the
 * screen stayed on the timetable until something else about it changed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const patches: string[] = [];
let refuseNext = false;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = req.url ?? '';
    if (url.startsWith('/v3/config/paths/list')) return res.end(JSON.stringify({ items: [{ name: 'tv_1' }] }));
    if (url.startsWith('/v3/config/paths/patch/')) {
      patches.push(JSON.parse(body).source);
      if (refuseNext) {
        refuseNext = false;
        res.statusCode = 500;
      }
      return res.end('{}');
    }
    if (url.startsWith('/v3/paths/get/')) return res.end(JSON.stringify({ readers: [] }));
    res.end('{}');
  });
});

test('a path change MediaMTX refused is retried on the next reconcile', async (t) => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  t.after(() => fake.close());
  // config reads both at import time, so they are set before the orchestrator is loaded.
  process.env.MEDIAMTX_API_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-orch-'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Orchestrator } = require('./orchestrator') as typeof import('./orchestrator');

  const db = {
    settings: { scheduleTimezone: 'UTC' },
    schedules: [],
    timetables: [{ id: 'tt_a' }],
    sources: [{ id: 'src_cam', url: 'rtsp://cam/1', enabled: true, mode: 'direct' }],
    tvs: [{ id: 'tv_1', name: 'Hall', kind: 'rtsp', defaultContent: { kind: 'timetable', id: 'tt_a' }, override: null }],
  };
  const render = { reconcile() {}, staleReason: () => null, frameAgeMs: () => 0 };
  const o = new Orchestrator({ db } as never, render as never, () => {});

  await o.reconcile();
  patches.length = 0;
  db.tvs[0].defaultContent = { kind: 'source', id: 'src_cam' };
  refuseNext = true;
  await o.reconcile(); // MediaMTX answers this one with a 500
  assert.equal(patches.length, 1);
  await o.reconcile();
  assert.equal(patches.length, 2, 'the refused change was not tried again');
  assert.equal(patches[1], patches[0], 'and it is the same change');
  await o.reconcile();
  assert.equal(patches.length, 2, 'once accepted, it is not re-sent');
});
