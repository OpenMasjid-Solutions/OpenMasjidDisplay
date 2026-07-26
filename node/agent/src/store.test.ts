// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentStore } from './store';

const TOKEN = 'a'.repeat(64);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'omd-store-'));
const ADOPTION = { controllerName: 'Test Masjid', wsUrl: 'ws://192.168.1.10:7860/ws/node', nodeToken: TOKEN, adoptedAt: '2026-07-26T00:00:00.000Z' };

test('an adoption survives a restart', () => {
  const dir = tmp();
  try {
    const a = new AgentStore(dir);
    assert.equal(a.adopted, false);
    a.adopt(ADOPTION);
    assert.equal(a.adopted, true);
    // A fresh instance = the agent restarting or the Pi rebooting.
    const b = new AgentStore(dir);
    assert.equal(b.adopted, true);
    assert.deepEqual(b.adoption, ADOPTION);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('adoption is one-shot', () => {
  const dir = tmp();
  try {
    const s = new AgentStore(dir);
    s.adopt(ADOPTION);
    assert.throws(() => s.adopt({ ...ADOPTION, controllerName: 'Attacker' }), /already adopted/);
    assert.equal(s.adoption?.controllerName, 'Test Masjid');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clear() returns the node to unadopted, on disk too', () => {
  const dir = tmp();
  try {
    const s = new AgentStore(dir);
    s.adopt(ADOPTION);
    s.clear();
    assert.equal(s.adopted, false);
    assert.equal(new AgentStore(dir).adopted, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt or hand-edited file reads as UNADOPTED, never crashes', () => {
  // On a read-only rootfs a crash-loop needs a card reader to fix, so the only acceptable
  // failure mode is "adoptable again".
  for (const body of [
    'not json',
    '{}',
    '{"adoption":null}',
    '{"adoption":{"wsUrl":"ws://x/ws/node"}}',
    `{"adoption":{"wsUrl":"http://x","nodeToken":"${TOKEN}"}}`,
    '{"adoption":{"wsUrl":"ws://x","nodeToken":"short"}}',
    `{"adoption":{"wsUrl":"ws://x","nodeToken":"${'A'.repeat(64)}"}}`,
    '{"adoption":{"wsUrl":"ws://x","nodeToken":123}}',
    '',
  ]) {
    const dir = tmp();
    try {
      fs.writeFileSync(path.join(dir, 'agent.json'), body);
      const s = new AgentStore(dir);
      assert.equal(s.adopted, false, `should be unadopted for: ${body.slice(0, 40)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('the token file is not world-readable', () => {
  const dir = tmp();
  try {
    new AgentStore(dir).adopt(ADOPTION);
    const mode = fs.statSync(path.join(dir, 'agent.json')).mode & 0o777;
    // Windows does not implement POSIX modes, so only assert where it means something.
    if (process.platform !== 'win32') {
      assert.equal(mode & 0o077, 0, `group/other bits set: ${mode.toString(8)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the controller name is length-capped (it comes off the wire)', () => {
  const dir = tmp();
  try {
    new AgentStore(dir).adopt({ ...ADOPTION, controllerName: 'x'.repeat(500) });
    assert.equal(new AgentStore(dir).adoption?.controllerName.length, 64);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
