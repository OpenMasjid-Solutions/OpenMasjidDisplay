// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Linked timetables: one masjid's times on several screens, edited once.
 *
 * `applyLinks` runs inside `Store.update`, which every write goes through, so the rules it
 * enforces are the ones that keep a link from becoming a loop or a surprise. They are checked
 * here rather than trusted because the failure modes are a hang (a cycle copying forever) and
 * silent data loss (a screen's times replaced by another's).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config reads DATA_DIR at import time, so it must be set BEFORE store loads — the same dance
// store.test.ts does. Without it these tests write to the real install's db.json.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-link-test-'));
process.env.DATA_DIR = DIR;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Store } = require('./store') as typeof import('./store');

/**
 * One store, reset to three known timetables per test.
 *
 * A second `new Store()` would load the same file, so isolation has to come from resetting the
 * rows rather than from a fresh instance.
 */
const shared = new Store();
function seed(): [typeof shared, string, string, string] {
  const base = structuredClone(shared.db.timetables[0]);
  shared.update((db) => {
    db.timetables = [
      { ...structuredClone(base), id: 'a', name: 'A', linkedTo: '' },
      { ...structuredClone(base), id: 'b', name: 'B', linkedTo: '' },
      { ...structuredClone(base), id: 'c', name: 'C', linkedTo: '' },
    ];
  });
  return [shared, 'a', 'b', 'c'];
}

test('a linked timetable takes the main\'s times, and keeps its own look', () => {
  const [s, a, b] = seed();
  s.update((db) => {
    const main = db.timetables.find((t) => t.id === a)!;
    main.latitude = 21.4225;
    main.longitude = 39.8262;
    main.asrMadhab = 'Hanafi';
    main.jumuah = ['13:15', '14:15'];
    const child = db.timetables.find((t) => t.id === b)!;
    child.linkedTo = a;
    child.layout = 'simple';
    child.orientation = 'portrait';
  });
  const child = s.db.timetables.find((t) => t.id === b)!;
  assert.equal(child.latitude, 21.4225, 'times follow');
  assert.equal(child.asrMadhab, 'Hanafi');
  assert.deepEqual(child.jumuah, ['13:15', '14:15']);
  assert.equal(child.layout, 'simple', 'the look does not');
  assert.equal(child.orientation, 'portrait');
});

test('editing the main moves every screen linked to it', () => {
  const [s, a, b, c] = seed();
  s.update((db) => {
    for (const id of [b, c]) db.timetables.find((t) => t.id === id)!.linkedTo = a;
  });
  s.update((db) => void (db.timetables.find((t) => t.id === a)!.timezone = 'Asia/Riyadh'));
  for (const id of [b, c]) assert.equal(s.db.timetables.find((t) => t.id === id)!.timezone, 'Asia/Riyadh');
});

test('a copied object is a copy — editing one screen cannot rewrite another', () => {
  // The shape of the bug this prevents: `iqamah` is an object, and handing the same reference to
  // both would make a child's edit land on the main, and from there on every other child.
  const [s, a, b] = seed();
  s.update((db) => void (db.timetables.find((t) => t.id === b)!.linkedTo = a));
  const main = s.db.timetables.find((t) => t.id === a)!;
  const child = s.db.timetables.find((t) => t.id === b)!;
  assert.notEqual(child.iqamah, main.iqamah, 'not the same object');
  assert.deepEqual(child.iqamah, main.iqamah, 'but the same value');
});

test('a link that would chain, loop or point nowhere is dropped', () => {
  /**
   * One level only. A chain is a loop waiting to happen, and a loop here is two timetables
   * copying each other for ever — so the rule is checked on every write rather than at the point
   * the panel offers the choice, which is a list that can be stale.
   */
  const [s, a, b, c] = seed();
  s.update((db) => {
    db.timetables.find((t) => t.id === b)!.linkedTo = a;
    db.timetables.find((t) => t.id === c)!.linkedTo = b; // b is itself linked — a chain
  });
  assert.equal(s.db.timetables.find((t) => t.id === c)!.linkedTo, '', 'no chains');

  s.update((db) => void (db.timetables.find((t) => t.id === c)!.linkedTo = c));
  assert.equal(s.db.timetables.find((t) => t.id === c)!.linkedTo, '', 'nothing follows itself');

  s.update((db) => void (db.timetables.find((t) => t.id === c)!.linkedTo = 'gone'));
  assert.equal(s.db.timetables.find((t) => t.id === c)!.linkedTo, '', 'nothing follows a timetable that is not there');
});

test('deleting the main frees the screens that followed it', () => {
  // They keep the times they had — the last thing the masjid saw on them — and simply stop
  // following. Deleting a timetable must not blank the screens beside it.
  const [s, a, b] = seed();
  s.update((db) => {
    db.timetables.find((t) => t.id === a)!.timezone = 'Asia/Riyadh';
    db.timetables.find((t) => t.id === b)!.linkedTo = a;
  });
  s.update((db) => void (db.timetables = db.timetables.filter((t) => t.id !== a)));
  const child = s.db.timetables.find((t) => t.id === b)!;
  assert.equal(child.linkedTo, '');
  assert.equal(child.timezone, 'Asia/Riyadh');
});
