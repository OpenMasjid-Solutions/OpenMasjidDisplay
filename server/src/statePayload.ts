// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The object the control panel boots from — one definition, two hosts.
 *
 * This used to live in `api.ts`, and moved here for one concrete reason: a standalone Raspberry
 * Pi serves the same web app and therefore needs the same payload, and it cannot import
 * `api.ts`, which pulls in MediaMTX, the Fabric client and the WhatsApp gateway at module level.
 * Copying it to the Pi would have left two definitions of the shape the panel is written
 * against, and the panel would have started working on one host and not the other.
 *
 * The only thing it needed from the orchestrator was the screen statuses, so it asks for those
 * rather than for an orchestrator — which is what lets a device with one screen and no
 * orchestrator at all answer it.
 */
import type { Store } from './store';
import type { TvStatus } from './types';
import { config } from './config';
import { THEMES } from './render/theme';
import { DEFAULT_SALAH_HADITH } from './render/defaultHadith';

/** Whoever knows what the screens are doing: the server's orchestrator, or a Pi reporting on
 *  the one screen it is. */
export interface ScreenStatuses {
  getStatuses(): TvStatus[];
}

export function statePayload(store: Store, screens: ScreenStatuses) {
  const db = store.db;
  const s = db.settings;
  return {
    authRequired: true,
    settings: s,
    timetables: db.timetables,
    sources: db.sources,
    tvs: db.tvs,
    schedules: db.schedules,
    themes: THEMES,
    // The built-in library of ahadith on Salāh (id + English + citation + shipped salah
    // targeting) so the panel can render the enable/disable checklist and prayer pickers.
    // Arabic isn't sent — the panel only toggles/targets them.
    hadithDefaults: DEFAULT_SALAH_HADITH.map((h) => ({ id: h.id, en: h.en, cite: h.cite, prayers: h.prayers })),
    statuses: screens.getStatuses(),
    // The screens connect to rtsp://<this server>:<port>/<screen>. The host is
    // whatever address the panel was opened with (filled in by the browser), so
    // there is no server IP to configure here.
    rtsp: {
      port: config.rtspPort,
      transport: 'tcp',
    },
    omosBase: config.omosBaseUrl,
    // Volunteer mode (the simple mobile page on its own port). We never send the
    // PIN itself — only whether one is set, and the host port to show in the URL.
    volunteer: {
      pinSet: !!store.db.volunteerAuth,
      port: config.volunteerPublicPort,
    },
    serverNow: Date.now(),
  };
}
