// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseChangelog, readChangelog, changelogCandidates } from './changelog';

test('sections split on ## and keep their bullets in order', () => {
  const r = parseChangelog(['# Changelog', '', '## 1.2.0', '- first', '- second', '', '## 1.1.0', '- older'].join('\n'));
  assert.equal(r.length, 2);
  assert.equal(r[0].version, '1.2.0');
  assert.deepEqual(r[0].items, ['first', 'second']);
  assert.deepEqual(r[1].items, ['older']);
});

test('the licence header, title and intro above the first release are not shown', () => {
  const r = parseChangelog(
    [
      '<!-- SPDX-License-Identifier: AGPL-3.0-only -->',
      '# Changelog',
      '',
      'Release notes, newest first.',
      '',
      '## 1.0.0',
      '- shipped',
    ].join('\n'),
  );
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].items, ['shipped']);
});

// The bug OpenMasjid Students shipped: only bullet lines were rendered, so a plain
// paragraph in the notes vanished. Both directions are asserted here.
test('a standalone paragraph is kept, not dropped', () => {
  const r = parseChangelog(['## 1.0.0', 'A summary sentence that is not a bullet.', '', '- a bullet'].join('\n'));
  assert.deepEqual(r[0].items, ['A summary sentence that is not a bullet.', 'a bullet']);
});

test('a paragraph AFTER bullets is its own item, not welded onto the last bullet', () => {
  const r = parseChangelog(['## 1.0.0', '- a bullet', '', 'A closing note.'].join('\n'));
  assert.deepEqual(r[0].items, ['a bullet', 'A closing note.']);
});

test('a wrapped bullet is joined back into one item', () => {
  const r = parseChangelog(['## 1.0.0', '- this bullet wraps', '  onto a second line', '  and a third'].join('\n'));
  assert.deepEqual(r[0].items, ['this bullet wraps onto a second line and a third']);
});

test('a blank line ends a bullet, so the next line cannot continue it', () => {
  const r = parseChangelog(['## 1.0.0', '- bullet one', '', 'not part of bullet one', '- bullet two'].join('\n'));
  assert.deepEqual(r[0].items, ['bullet one', 'not part of bullet one', 'bullet two']);
});

test('* bullets work as well as -', () => {
  assert.deepEqual(parseChangelog(['## 1.0.0', '* star'].join('\n'))[0].items, ['star']);
});

test('a deeper heading inside a release keeps its text', () => {
  const r = parseChangelog(['## 1.0.0', '### Highlights', '- a thing'].join('\n'));
  assert.deepEqual(r[0].items, ['Highlights', 'a thing']);
});

test('a heading with no content is dropped rather than rendered empty', () => {
  const r = parseChangelog(['## 1.0.0', '', '## 0.9.0', '- real'].join('\n'));
  assert.deepEqual(r.map((x) => x.version), ['0.9.0']);
});

test('CRLF files parse the same as LF', () => {
  const lf = parseChangelog('## 1.0.0\n- a\n- b\n');
  const crlf = parseChangelog('## 1.0.0\r\n- a\r\n- b\r\n');
  assert.deepEqual(crlf, lf);
});

test('empty, whitespace and nullish input yield no releases and never throw', () => {
  for (const input of ['', '   \n\n  ', undefined as unknown as string, null as unknown as string]) {
    assert.deepEqual(parseChangelog(input), []);
  }
});

test('a non-version heading (e.g. a withdrawn range) is preserved verbatim', () => {
  const r = parseChangelog(['## 0.62.0 – 0.65.0 (withdrawn)', '- that feature was withdrawn'].join('\n'));
  assert.equal(r[0].version, '0.62.0 – 0.65.0 (withdrawn)');
});

test('readChangelog returns empty string when no candidate exists', () => {
  assert.equal(readChangelog([path.join('/', 'nope', 'CHANGELOG.md')]), '');
});

test('changelogCandidates covers both the repo and image layouts', () => {
  // path.resolve() is absolutised against the cwd's drive on Windows, so build the
  // expectations the same way rather than assuming a leading separator is enough.
  const src = path.join(path.sep, 'app', 'server', 'src');
  const c = changelogCandidates(src);
  assert.ok(c.includes(path.resolve(src, '..', '..', 'CHANGELOG.md')), 'repo root (server/src -> ..)');
  assert.ok(c.includes(path.resolve(src, '..', '..', '..', 'CHANGELOG.md')), 'image root (dist/server/src -> ...)');
  assert.ok(c.includes(path.resolve(process.cwd(), 'CHANGELOG.md')), 'cwd fallback');
});

// The real file is the one that actually ships, so assert on it rather than only on
// fixtures: a parser that passes synthetic cases but loses content from OUR notes is the
// failure that matters.
test('the shipped CHANGELOG.md parses, and loses no line of its content', () => {
  const md = readChangelog();
  assert.ok(md.length > 0, 'CHANGELOG.md must ship with the app');

  const releases = parseChangelog(md);
  assert.ok(releases.length > 50, `expected the full history, got ${releases.length} sections`);

  // Every release heading in the file must appear exactly once.
  const heads = [...md.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((m) => m[1]);
  assert.deepEqual(releases.map((r) => r.version), heads);

  // The newest section must be the running version, so "You're on this" can land.
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
  assert.equal(releases[0].version, pkg.version, 'the top section must match this build');

  // No content dropped: every non-blank line below the first heading must be reachable in
  // the parsed output. This is the Students regression, checked against the real notes.
  const body = md.slice(md.indexOf('\n## '));
  const sourceWords = body
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*]\s+/, '').replace(/^#{2,}\s+/, '').trim())
    .filter(Boolean)
    .join(' ');
  const parsedWords = releases.flatMap((r) => [r.version, ...r.items]).join(' ');
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  assert.equal(norm(parsedWords), norm(sourceWords), 'parsed text must contain every source line, in order');
});
