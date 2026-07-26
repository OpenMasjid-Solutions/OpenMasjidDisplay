// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * nodeAssets.ts — the uploaded images a Pi node needs to draw a timetable.
 *
 * A masjid's own background photo and logo live in the controller's data volume, so a node
 * has to fetch them. They are addressed by CONTENT HASH, which buys three things at once:
 * a node re-fetches only when the bytes actually change (not on every reconcile), two
 * screens sharing a photo transfer it once, and a mis-typed filename can never point at
 * some other masjid's upload.
 *
 * The URL is a PATH, not an absolute URL, and the node resolves it against the controller
 * origin it already dials for its WebSocket. That sidesteps the "what address am I
 * reachable at" problem entirely — which matters because the honest answer differs between
 * a LAN install, a tunnelled one, and a cloud-hosted controller.
 */
import { uploadSha256 } from './render/background';
import type { AssetRef } from '../../packages/protocol/src/index';
import type { Timetable } from './types';

/** Path a node fetches an asset from, relative to the controller origin. */
export const nodeAssetPath = (sha: string): string => `/api/node/assets/${sha}`;

/**
 * The assets this timetable needs, or [] when it uses only the themed scene.
 *
 * `id` is the slot the renderer fills ('bg' or 'logo'), not the filename — the node keys
 * its render options off the slot and its cache off the hash, so neither depends on what
 * the admin happened to call the file.
 */
export function assetsForTimetable(tt: Timetable): AssetRef[] {
  const out: AssetRef[] = [];
  for (const [id, file] of [
    ['bg', tt.backgroundImage],
    ['logo', tt.logoImage],
  ] as const) {
    if (!file) continue;
    const sha = uploadSha256(file);
    // A missing or unreadable upload is skipped silently: the node renders the themed
    // scene, which is exactly what the controller does in the same situation.
    if (!sha) continue;
    out.push({ id, sha256: sha, url: nodeAssetPath(sha) });
  }
  return out;
}
