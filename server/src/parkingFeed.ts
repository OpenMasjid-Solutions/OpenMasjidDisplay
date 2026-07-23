// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Live parking board feed (OpenMasjidOS Fabric consumer).
 *
 * When a timetable has its announcement slideshow on AND "include the live parking
 * board" ticked, we periodically pull the current board (an SVG) from the Parking
 * Attendant app via the Fabric app-to-app broker, rasterize it to a PNG, and drop it
 * in as that timetable's parking frame. The existing slideshow (svg.ts
 * activeAnnouncementImage → renderWorker) then cycles it like any other image.
 *
 * Entirely best-effort: no platform, no grant, the app down, or a render error just
 * means the frame isn't refreshed (the slideshow skips a missing frame). It never
 * throws and holds no state on the data volume — the Fabric env is read fresh each
 * call (see fabric.ts / config.ts), so a restore-to-new-machine keeps working.
 */
import { Resvg } from '@resvg/resvg-js';
import { config } from './config';
import { makeLog } from './logger';
import { fetchParkingBoardSvg } from './fabric';
import { fontOptions } from './render/fonts';
import { saveParkingFrame } from './render/background';
import type { Store } from './store';

const log = makeLog('parking-feed');

const REFRESH_MS = 45_000;
const FIRST_DELAY_MS = 8_000; // let startup settle before the first pull

/** Begin the background refresh loop. Safe to call once at boot. */
export function startParkingFeed(store: Store): void {
  let running = false;

  async function tick(): Promise<void> {
    if (running) return; // never overlap a slow fetch/rasterize
    running = true;
    try {
      const targets = store.db.timetables.filter((t) => t.announcements?.enabled && t.announcements?.parking);
      if (targets.length === 0) return; // nobody wants it — don't call the Fabric at all
      if (!config.omosBaseUrl || !config.omosAppSecret) return; // standalone: no Fabric

      const svg = await fetchParkingBoardSvg();
      if (!svg) return; // unreachable / not granted / app off — keep the previous frame

      try {
        const png = Buffer.from(new Resvg(svg, { font: fontOptions(), fitTo: { mode: 'width', value: 1600 } }).render().asPng());
        for (const t of targets) saveParkingFrame(t.id, png);
        log.debug(`refreshed parking board for ${targets.length} timetable(s)`);
      } catch (err) {
        log.warn(`could not rasterize the parking board: ${err instanceof Error ? err.message : err}`);
      }
    } finally {
      running = false;
    }
  }

  setTimeout(() => void tick(), FIRST_DELAY_MS);
  setInterval(() => void tick(), REFRESH_MS);
}
