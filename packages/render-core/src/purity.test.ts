// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The platform-free, deterministic contract for render-core, enforced.
 *
 * render-core runs in three very different places — the controller container
 * (CommonJS + resvg), a Raspberry Pi node's kiosk browser (ESM + DOM), and tsx in
 * tests. Two classes of mistake would compile fine on the server and then break
 * every Pi node in the field, silently, at a masjid:
 *
 *   1. PLATFORM ACCESS (`node:fs`, `process.env`, `window`, `Buffer`, `require`).
 *      Caught by the COMPILER: tsconfig.json sets `"types": []` with no "DOM" lib, so
 *      each of those is a hard error (verified — see the tsconfig test below, which
 *      fails if someone weakens those two settings). Nothing to re-check here.
 *
 *   2. NON-DETERMINISM (`Math.random()`, `Date.now()`, `new Date()`). Perfectly legal
 *      TypeScript, so the compiler cannot help. The frame is recomputed from `now`
 *      every wall-clock second and TWO renderers must agree on it, so these are
 *      banned and checked textually below.
 *
 * This file is excluded from the package tsconfig, so it may use node:fs itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Locate this package by walking up from the working directory.
 *
 * Deliberately not `import.meta.url` or `__dirname`: the server compiles as CommonJS
 * and tsx loads these tests accordingly, so `import.meta` is a syntax error there —
 * while a future ESM move would break `__dirname`. Walking up works under both, and
 * from either `server/` (how `npm test` runs) or the repo root.
 */
function findPkg(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'packages', 'render-core', 'src'))) {
      return path.join(dir, 'packages', 'render-core');
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`could not locate packages/render-core from ${process.cwd()}`);
}

const PKG = findPkg();
const SRC = path.join(PKG, 'src');

/** Every non-test .ts file in the package, as [relativePath, lines]. */
function sources(): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        out.push([path.relative(SRC, full).replace(/\\/g, '/'), fs.readFileSync(full, 'utf8').split('\n')]);
      }
    }
  };
  walk(SRC);
  return out;
}

/**
 * Is this line pure commentary?
 *
 * A previous version of this test ran a character-by-character comment stripper, and
 * it desynchronized on regex literals containing a quote (`/[&<>"']/`), after which
 * it treated real doc comments as string contents and reported the word "window." in
 * prose as a browser global. A line-level test cannot desync, and it is sufficient
 * here: the patterns below all require a call `(`, which documentation about them
 * does not contain.
 */
const isCommentary = (line: string): boolean => {
  const t = line.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
};

/** Banned because the compiler cannot catch them — see the header. */
const NON_DETERMINISM: Array<{ re: RegExp; what: string; why: string }> = [
  {
    re: /\bMath\s*\.\s*random\s*\(/,
    what: 'Math.random()',
    why: 'the frame is recomputed every second from `now`, so randomness flickers — seed a hash of the date instead (see pickSalahHadith)',
  },
  {
    re: /\bDate\s*\.\s*now\s*\(/,
    what: 'Date.now()',
    why: 'the render must be a pure function of the `now` passed in, or the controller and a Pi node disagree',
  },
  {
    re: /\bnew\s+Date\s*\(\s*\)/,
    what: 'new Date()',
    why: 'reads the wall clock — same problem as Date.now(); use the `now` argument',
  },
  {
    re: /\bfrom\s*['"]node:/,
    what: "an import from 'node:*'",
    why: 'this package runs in a browser too (the compiler also rejects it; belt and braces)',
  },
];

test('render-core renders deterministically (no wall-clock or randomness)', () => {
  const files = sources();
  assert.ok(files.length >= 7, `expected the package's sources, found ${files.length}`);
  const violations: string[] = [];
  for (const [rel, lines] of files) {
    lines.forEach((line, i) => {
      if (isCommentary(line)) return;
      for (const { re, what, why } of NON_DETERMINISM) {
        if (re.test(line)) violations.push(`${rel}:${i + 1} uses ${what} — ${why}\n      ${line.trim().slice(0, 110)}`);
      }
    });
  }
  assert.deepEqual(violations, [], `render-core determinism violations:\n${violations.join('\n')}`);
});

test('the compile-time purity guard is still armed in tsconfig.json', () => {
  // These two settings ARE the platform-free guarantee: with them, `process`, `window`,
  // `Buffer`, `__dirname`, `require` and every `node:*` import are compile errors. If a
  // future edit adds "node" to types or "DOM" to lib, that guarantee silently vanishes
  // — so fail loudly here instead.
  const raw = fs.readFileSync(path.join(PKG, 'tsconfig.json'), 'utf8');
  const json = raw.replace(/^\s*\/\/.*$/gm, ''); // tsconfig is JSONC; drop comment lines
  const cfg = JSON.parse(json) as { compilerOptions: { types?: string[]; lib?: string[] } };
  assert.deepEqual(cfg.compilerOptions.types, [], 'compilerOptions.types must stay [] — no ambient Node types');
  const lib = cfg.compilerOptions.lib ?? [];
  assert.ok(lib.length > 0, 'compilerOptions.lib must be set explicitly');
  assert.ok(
    !lib.some((l) => l.toLowerCase().includes('dom')),
    `compilerOptions.lib must not include DOM (got ${JSON.stringify(lib)}) — the server renders this too`,
  );
});

test('the barrel re-exports every module with no name collisions', () => {
  // index.ts uses `export *`, which silently DROPS a name exported by two modules —
  // the symbol would vanish from the public surface with no error anywhere. Check the
  // modules declare disjoint names.
  const byName = new Map<string, Set<string>>();
  for (const [rel, lines] of sources()) {
    if (rel === 'index.ts') continue;
    for (const line of lines) {
      if (isCommentary(line)) continue;
      const m = /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/.exec(line);
      if (m) (byName.get(m[1]) ?? byName.set(m[1], new Set()).get(m[1])!).add(rel);
    }
  }
  const clashes = [...byName.entries()]
    .filter(([, files]) => files.size > 1)
    .map(([name, files]) => `${name} exported by ${[...files].join(' and ')}`);
  assert.deepEqual(clashes, [], 'two modules export the same name, so `export *` in index.ts would drop one');
  // Sanity: the scan is actually finding exports, not silently matching nothing.
  assert.ok(byName.has('renderDisplaySvg'), 'scan should have found renderDisplaySvg');
  assert.ok(byName.has('prayerTimes'), 'scan should have found prayerTimes');
  assert.ok(byName.has('Timetable'), 'scan should have found the Timetable type');
});
