// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Thin client for the MediaMTX control API (v3). We never rewrite mediamtx.yml
 * (its file watcher is unreliable in Docker); instead we drive paths at runtime:
 *   • add/patch/delete a path's config (/v3/config/paths/...)
 *   • read a path's live state (/v3/paths/get) for stream-ready / reader counts
 */
import { config } from './config';
import { makeLog } from './logger';

const log = makeLog('mediamtx');

export interface PathConf {
  /** "publisher" (something publishes in) or an rtsp:// URL to pull from. */
  source?: string;
  sourceOnDemand?: boolean;
  sourceOnDemandStartTimeout?: string;
  sourceOnDemandCloseAfter?: string;
}

export interface PathState {
  name: string;
  ready: boolean;
  readers: number;
  tracks: string[];
}

/** MediaMTX runs in this same container on loopback, so it answers in single-digit
 *  milliseconds or it is wedged. The orchestrator awaits these calls inside `reconcile()`,
 *  which is the loop that keeps every screen correct — a socket that connects and then never
 *  replies (a sidecar mid-crash, a full disk) would otherwise hang that loop for good, and
 *  every screen would silently stop being reconciled with no error anywhere. */
const MEDIAMTX_TIMEOUT_MS = 5000;

async function call(method: string, path: string, body?: unknown): Promise<Response | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), MEDIAMTX_TIMEOUT_MS);
  try {
    const res = await fetch(config.mediamtxApiUrl + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      // Loopback to our own sidecar: it has no business redirecting us anywhere.
      redirect: 'error',
    });
    return res;
  } catch (err) {
    log.debug(`${method} ${path} failed: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Is the MediaMTX API reachable? */
export async function ping(): Promise<boolean> {
  const res = await call('GET', '/v3/config/global/get');
  return !!res && res.ok;
}

/** Names of all currently-configured paths. */
export async function listConfiguredPaths(): Promise<Set<string>> {
  const out = new Set<string>();
  // The list is paginated; 1000 items is far beyond any real install.
  const res = await call('GET', '/v3/config/paths/list?itemsPerPage=1000');
  if (!res || !res.ok) return out;
  try {
    const data = (await res.json()) as { items?: Array<{ name?: string }> };
    for (const it of data.items ?? []) if (it.name) out.add(it.name);
  } catch {
    /* ignore */
  }
  return out;
}

export async function addPath(name: string, conf: PathConf): Promise<boolean> {
  const res = await call('POST', `/v3/config/paths/add/${encodeURIComponent(name)}`, conf);
  if (res && res.ok) return true;
  log.warn(`addPath ${name} -> ${res ? res.status : 'no response'}`);
  return false;
}

export async function patchPath(name: string, conf: PathConf): Promise<boolean> {
  const res = await call('PATCH', `/v3/config/paths/patch/${encodeURIComponent(name)}`, conf);
  if (res && res.ok) return true;
  log.warn(`patchPath ${name} -> ${res ? res.status : 'no response'}`);
  return false;
}

export async function deletePath(name: string): Promise<boolean> {
  const res = await call('DELETE', `/v3/config/paths/delete/${encodeURIComponent(name)}`);
  return !!res && res.ok;
}

/** Live state of a path (whether a stream is flowing and how many readers). */
export async function getPathState(name: string): Promise<PathState | null> {
  const res = await call('GET', `/v3/paths/get/${encodeURIComponent(name)}`);
  if (!res || !res.ok) return null;
  try {
    const d = (await res.json()) as {
      name?: string;
      ready?: boolean;
      readers?: unknown[];
      tracks?: string[];
    };
    return {
      name: d.name ?? name,
      ready: !!d.ready,
      readers: Array.isArray(d.readers) ? d.readers.length : 0,
      tracks: Array.isArray(d.tracks) ? d.tracks : [],
    };
  } catch {
    return null;
  }
}
