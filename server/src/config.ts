// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Environment configuration. Install settings seed first-run defaults only; all
 *  ongoing configuration lives in the data volume (store.ts). */
import path from 'node:path';
import type { Quality } from './types';

function env(name: string, def = ''): string {
  const v = process.env[name];
  return v == null || v === '' ? def : v;
}
function intEnv(name: string, def: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  port: intEnv('PORT', 8080),
  dataDir: env('DATA_DIR', path.resolve(process.cwd(), 'data')),
  publicDir: env('PUBLIC_DIR', path.resolve(__dirname, '..', 'public')),

  /** The simple mobile "volunteer" page runs on its own HTTP port so volunteers get
   *  a clean URL (and it can be firewalled separately). The container listens on
   *  `volunteerPort`; `volunteerPublicPort` is only what we *show* as the host port
   *  (mirrors rtspPort) since the container can't know the host mapping. */
  volunteerPort: intEnv('VOLUNTEER_PORT', 8081),
  volunteerPublicPort: intEnv('VOLUNTEER_PUBLIC_PORT', 7861),

  /** The RTSP port a screen's decoder connects to: rtsp://<host>:<port>/<screen>.
   *  Published to the host by docker-compose and surfaced to the UI, which builds
   *  each link from the address the panel was opened with — so there is no server
   *  IP to configure. Overridable only if the host port is remapped. */
  rtspPort: intEnv('RTSP_PUBLIC_PORT', 8554),

  /** The RTSP server (MediaMTX) runs inside THIS container — one thing to install
   *  and update. We launch and supervise it (see mediamtxServer.ts). Set
   *  MEDIAMTX_MANAGED=no for local dev where you run your own MediaMTX. */
  mediamtxManaged: env('MEDIAMTX_MANAGED', 'yes') !== 'no',
  mediamtxBin: env('MEDIAMTX_BIN', 'mediamtx'),
  mediamtxConfig: env('MEDIAMTX_CONFIG', '/app/mediamtx.yml'),

  /** How the app talks to MediaMTX (loopback — same container). */
  mediamtxApiUrl: env('MEDIAMTX_API_URL', 'http://127.0.0.1:9997'),
  /** Where the app PUBLISHES rendered timetables (app -> mediamtx). */
  rtspInternal: env('MEDIAMTX_RTSP_INTERNAL', 'rtsp://127.0.0.1:8554'),
  /** What MediaMTX uses to pull from ITSELF for per-TV self-relay paths. */
  rtspLoopback: env('MEDIAMTX_RTSP_LOOPBACK', 'rtsp://127.0.0.1:8554'),

  /** OpenMasjidOS Fabric (the platform↔app appearance + SSO layer). These are
   *  injected by the platform at install and empty on a standalone install, where
   *  the app simply uses its own appearance + own login. The wire identifiers
   *  (env var names, header, cookie, endpoints) are the shared Fabric contract and
   *  must stay byte-for-byte. See docs/FABRIC.md. */
  omosBaseUrl: env('OPENMASJID_BASE_URL', '').replace(/\/+$/, ''),
  omosAppId: env('OPENMASJID_APP_ID', ''),
  /** Per-app secret issued by the platform to `sso: true` apps. SSO is identity-
   *  bound: we must present this on the /api/auth/session check or the platform
   *  fails closed. It is a CREDENTIAL — never log or expose it. */
  omosAppSecret: env('OPENMASJID_APP_SECRET', ''),

  /** First-run seed values (from install settings). */
  seed: {
    quality: (env('DISPLAY_QUALITY', '720p') === '1080p' ? '1080p' : '720p') as Quality,
    masjidName: env('MASJID_NAME', 'Our Masjid'),
    latitude: env('LATITUDE', ''),
    longitude: env('LONGITUDE', ''),
    method: env('CALC_METHOD', 'MWL'),
    asrMadhab: env('ASR_MADHAB', 'Hanafi'),
    timezone: env('TIMEZONE', ''),
    timeFormat: env('TIME_FORMAT', '12h'),
    language: env('LANGUAGE', 'en'),
  },
};

export type Config = typeof config;
