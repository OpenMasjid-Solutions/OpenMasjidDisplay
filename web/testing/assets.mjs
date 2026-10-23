// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Let Node import the things Vite turns into URLs.
 *
 * A component here may `import markUrl from './assets/mark.png'`, which Vite resolves to a URL
 * string at build time. Node has no idea what a `.png` module is and refuses to load one, so a
 * single asset import anywhere in the module graph stops a test importing the component — and
 * `ui.tsx` has exactly one, which is enough to block every component in the app.
 *
 * So assets become what they are in the built app: a string. Nothing under test looks at the
 * value, and a test that did would be asserting Vite's hashing rather than our own code.
 *
 * Deliberately NOT a test framework. Everything else — rendering, assertions, the runner — is
 * node:test and react-dom/server, which the app already depends on. This file is the whole of the
 * gap between the two.
 */
import { register } from 'node:module';

const ASSET = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|woff2?|ttf|eot|mp3|wav|webm|mp4)(\?.*)?$/i;

/** The hook itself, registered below so one `--import` sets everything up. */
export async function load(url, context, next) {
  if (ASSET.test(url)) {
    return { format: 'module', shortCircuit: true, source: 'export default "/stub-asset";' };
  }
  return next(url, context);
}

// Registering from inside the same file keeps the command line to one `--import`. The hooks run
// on their own thread, so this module is loaded twice: once here as the registrar, once there as
// the hook. Both are harmless and idempotent.
if (!process.env.OMD_ASSET_HOOK) {
  process.env.OMD_ASSET_HOOK = '1';
  register(import.meta.url);
}
