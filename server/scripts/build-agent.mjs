// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * build-agent.mjs — bundle the Raspberry Pi screen agent into one file.
 *
 * The agent has to arrive on a Pi over a single `curl`, onto a machine where `npm install` of a
 * whole dependency tree would take minutes on a slow SD card and fail halfway on a bad uplink.
 * So it ships as one self-contained JavaScript file, and the Pi installs exactly one thing from
 * npm: the native rasteriser, which cannot be bundled because it is a compiled `.node` binary.
 *
 * Written as a script rather than an `esbuild` command line because the version has to be read
 * out of `package.json` and stamped in, and doing that in a cross-platform npm script is more
 * fragile than it is worth.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8'));
const outfile = path.join(serverDir, 'assets', 'pi', 'agent.js');

await build({
  entryPoints: [path.join(serverDir, 'src', 'pi', 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  // Raspberry Pi OS Bookworm ships Node 18. Targeting it rather than the image's Node 22 keeps
  // the agent runnable on the OS a masjid actually has, without asking anyone to add a repo.
  target: 'node18',
  format: 'cjs',
  // The one dependency the Pi installs itself: a native module, so there is nothing to bundle.
  external: ['@resvg/resvg-js'],
  define: { __AGENT_VERSION__: JSON.stringify(pkg.version) },
  // Kept readable on purpose. This is AGPL software running on somebody's hardware, and the
  // person maintaining a masjid's screen should be able to open the file and follow it.
  minify: false,
  legalComments: 'inline',
  banner: {
    js:
      '// SPDX-License-Identifier: AGPL-3.0-only\n' +
      '// Copyright (C) 2026 OpenMasjid-Solutions\n' +
      `// OpenMasjidDisplay screen agent ${pkg.version} — generated, do not edit.\n` +
      '// Source: https://github.com/OpenMasjid-Solutions/OpenMasjidDisplay',
  },
  logLevel: 'warning',
});

const bytes = fs.statSync(outfile).size;
console.log(`agent ${pkg.version} -> ${path.relative(serverDir, outfile)} (${Math.round(bytes / 1024)} KB)`);
