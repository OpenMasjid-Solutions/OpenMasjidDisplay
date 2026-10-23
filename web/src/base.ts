// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The path this page is served under: "/display" (or whatever the admin named it) behind the
 * OpenMasjidOS tunnel, "" on the LAN and on a Raspberry Pi's own panel.
 *
 * Behind the tunnel the app shares one hostname with the OpenMasjidOS dashboard, which owns the
 * root, so any absolute URL this app builds without the prefix — an API call, a socket, a link —
 * reaches the dashboard instead. The server writes the prefix into the page as
 * `window.__OMD_BASE__` (server/src/httpio.ts `pageUnderBase`); read once, here.
 */
declare global {
  interface Window {
    /** injected by the server; absent on a host that never serves under a prefix */
    __OMD_BASE__?: string;
  }
}

/** A plain `/segment`, the shape of an OpenMasjidOS app path; anything else means the root. */
export const baseFrom = (raw: unknown): string =>
  typeof raw === 'string' && /^\/[a-z0-9-]{1,80}$/.test(raw) ? raw : '';

export const BASE = baseFrom(typeof window !== 'undefined' ? window.__OMD_BASE__ : undefined);

/** An absolute in-app path ("/api/x") under the base path; anything else is returned as-is. */
export const withBase = (p: string): string => (p.startsWith('/') && !p.startsWith('//') ? BASE + p : p);

/** A WebSocket on this page's own host for an in-app path, under the base path. */
export const wsUrl = (p: string): string =>
  `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${withBase(p)}`;
