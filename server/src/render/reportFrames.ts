// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Turn volunteer incorrect-parking reports into the announcement alert frames that
 * rotate on each timetable. Called at boot and whenever a report is created or
 * removed on the volunteer page. Best-effort: a render error for one report is
 * logged and skipped; a timetable with no matching reports gets its frames cleared.
 */
import { Resvg } from '@resvg/resvg-js';
import { makeLog } from '../logger';
import { fontOptions } from './fonts';
import { renderReportCardSvg } from './reportCard';
import { reportImageDataUri, syncParkingFrames } from './background';
import type { Store } from '../store';

const log = makeLog('reports');

/** Regenerate the alert frames for every timetable from the current reports. */
export function regenerateReportFrames(store: Store): void {
  const reports = store.db.reports ?? [];
  const raster = (svg: string): Buffer =>
    Buffer.from(new Resvg(svg, { font: fontOptions(), fitTo: { mode: 'width', value: 1600 } }).render().asPng());
  for (const tt of store.db.timetables) {
    const reps = reports.filter((r) => r.targets.includes('*') || r.targets.includes(tt.id));
    const frames: Buffer[] = [];
    for (const r of reps) {
      // One frame per photo (so the slideshow scrolls through them); a photo-less
      // report still gets one text-only card.
      const photos = r.images.length ? r.images : [''];
      for (const img of photos) {
        try {
          frames.push(raster(renderReportCardSvg(r, img ? reportImageDataUri(img) : null)));
        } catch (err) {
          log.warn(`could not render report ${r.id}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    syncParkingFrames(tt.id, frames);
  }
}
