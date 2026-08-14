// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The release notes this build shipped with — the admin panel's "What's new".
 *
 * An admin whose app was updated in the background by OpenMasjidOS has no way to find out
 * what changed without leaving for GitHub, which is exactly the kind of thing that has to
 * be said in the panel. CHANGELOG.md is copied into the image, so this works with no
 * internet.
 *
 * The parsing lives HERE, on the server, rather than in the web bundle: this app's test
 * runner only covers server/, and a changelog parser is not hypothetical code to get wrong
 * — OpenMasjid Students shipped a "What's new" that rendered only bullet lines, so every
 * plain paragraph in its notes was silently dropped (fixed in its v0.45.1). The endpoint
 * therefore returns structured releases and the client only formats them.
 */
import fs from 'node:fs';
import path from 'node:path';

/** One release section: its heading text and the paragraphs/bullets under it. */
export interface Release {
  /** The heading exactly as written, e.g. "0.66.1" or "0.62.0 – 0.65.0 (withdrawn)". */
  version: string;
  /** Each bullet or standalone paragraph, in file order, with inline markdown intact. */
  items: string[];
}

/**
 * Pull `## <version>` sections and their contents out of the changelog.
 *
 * The format is the five constructs our own CHANGELOG.md uses, so this is deliberately not
 * a Markdown library. The rule that matters: a non-bullet line is a CONTINUATION of the
 * bullet above only when no blank line separates them; after a blank line it is a paragraph
 * of its own. Getting that wrong in either direction is how content disappears — dropping
 * such lines loses them outright, and blindly appending them to the previous bullet welds a
 * standalone paragraph onto an unrelated sentence.
 */
export function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  let current: Release | null = null;
  // Whether the previous non-blank line can still be continued (i.e. no blank line since).
  let openItem = false;

  for (const raw of String(md ?? '').split(/\r?\n/)) {
    const line = raw.trim();

    if (!line) {
      openItem = false; // a blank line ends the current bullet/paragraph
      continue;
    }

    const head = /^##\s+(.+?)\s*$/.exec(line);
    if (head) {
      current = { version: head[1].trim(), items: [] };
      releases.push(current);
      openItem = false;
      continue;
    }

    // Anything above the first `## ` heading (the licence header, the title, the intro)
    // belongs to no release and is not shown.
    if (!current) continue;

    // A deeper heading inside a release isn't part of our format; keep its text rather
    // than dropping it.
    const sub = /^#{3,}\s+(.+?)\s*$/.exec(line);
    if (sub) {
      current.items.push(sub[1]);
      openItem = true;
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      current.items.push(bullet[1]);
      openItem = true;
      continue;
    }

    if (openItem) {
      current.items[current.items.length - 1] += ` ${line}`;
    } else {
      current.items.push(line);
      openItem = true;
    }
  }

  // Drop sections that ended up with nothing to say rather than rendering an empty heading.
  return releases.filter((r) => r.items.length > 0);
}

/** A release section that grows by one entry per version stays small; this is a sanity
 *  ceiling so a corrupted or hostile file can't be read into memory unbounded. */
const MAX_BYTES = 256 * 1024;

/**
 * Where CHANGELOG.md sits, depending on how the app is running. Checked in order; the
 * first that exists wins.
 *
 * The two layouts that actually occur:
 *   • from the repo (tsx) — `__dirname` is `server/src`, so the repo root is two up.
 *   • from the image — tsconfig has `rootDir: src`/`outDir: dist`, so the entrypoint is
 *     `/app/dist/index.js` and `__dirname` is `/app/dist`; the Dockerfile copies the file
 *     to `/app/CHANGELOG.md`, one up.
 *
 * There used to be a third candidate (`../../..`) commented as "dist/server/src -> app
 * root". No such directory is ever produced: `path.resolve` clamps at the filesystem root,
 * so from `/app/dist` it resolved to exactly the same `/CHANGELOG.md` as the entry above
 * it, and from `server/src` it pointed at the repo's PARENT. It could never match in either
 * mode, so it is gone rather than left looking like it covers the image.
 */
export function changelogCandidates(dir: string = __dirname): string[] {
  return [
    path.resolve(dir, '..', '..', 'CHANGELOG.md'), // server/src -> repo root (tsx)
    path.resolve(dir, '..', 'CHANGELOG.md'), // /app/dist -> /app (the image)
    path.resolve(process.cwd(), 'CHANGELOG.md'),
  ];
}

/** Read the shipped changelog. Returns '' when the image was built without one — a missing
 *  file is a cosmetic gap, never a reason to fail a request. */
export function readChangelog(candidates: string[] = changelogCandidates()): string {
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, 'utf8').slice(0, MAX_BYTES);
    } catch {
      // try the next location
    }
  }
  return '';
}
