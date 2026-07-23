// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Live incorrect-parking alerts feed (OpenMasjidOS Fabric consumer).
 *
 * When a timetable has its announcement slideshow on AND "show incorrect-parking
 * alerts" ticked, we periodically pull the current alert cards (one SVG per active
 * report) from the Parking Attendant app via the Fabric app-to-app broker, rasterize
 * each to a PNG, and sync them as that timetable's parking frames. The existing
 * slideshow (svg.ts activeAnnouncementImage → renderWorker) then cycles just those
 * cards — and shows nothing parking-related when there are no reports.
 *
 * Entirely best-effort: no platform, no grant, or the app down just means the frames
 * aren't refreshed. It never throws and holds no state on the data volume — the
 * Fabric env is read fresh each call (see fabric.ts / config.ts), so a
 * restore-to-new-machine keeps working.
 */
import { Resvg } from '@resvg/resvg-js';
import { config } from './config';
import { makeLog } from './logger';
import { fetchParkingReportCards } from './fabric';
import { fontOptions } from './render/fonts';
import { syncParkingFrames } from './render/background';
import type { Store } from './store';

const log = makeLog('parking-feed');

const REFRESH_MS = 30_000;
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

      // One fetch for everyone (the alerts are the same for the masjid).
      const cards = await fetchParkingReportCards(); // [] on error/none — clears the frames below

      let frames: Buffer[];
      try {
        frames = cards.map((svg) =>
          Buffer.from(new Resvg(svg, { font: fontOptions(), fitTo: { mode: 'width', value: 1600 } }).render().asPng()),
        );
      } catch (err) {
        log.warn(`could not rasterize a parking alert: ${err instanceof Error ? err.message : err}`);
        return; // leave the previous frames in place rather than clearing on a render error
      }
      for (const t of targets) syncParkingFrames(t.id, frames);
      log.debug(`synced ${frames.length} parking alert(s) to ${targets.length} timetable(s)`);
    } finally {
      running = false;
    }
  }

  setTimeout(() => void tick(), FIRST_DELAY_MS);
  setInterval(() => void tick(), REFRESH_MS);
}
