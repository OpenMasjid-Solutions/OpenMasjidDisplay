// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * assetCache.ts — the masjid's background photo and logo, on the node's own disk.
 *
 * Content-addressed: the file name IS the sha256 of its bytes, so
 *
 *  • a re-push of the same timetable costs zero bytes (the hash is already on disk),
 *  • two screens sharing a photo each fetch it once, and
 *  • a corrupted download can be DETECTED rather than cached and drawn forever, which on a
 *    read-only-rootfs box would otherwise need a card reader to clear.
 *
 * Failure posture: a missing asset is never fatal. The renderer simply falls back to the
 * themed scene, exactly as the controller does when an upload has gone missing — a masjid
 * would rather see the timetable without its logo than not see the timetable.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AssetRef } from '../../../packages/protocol/src/index';

/** Refuse anything absurd: these are photos, and the board has 512 MB. */
const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

export interface AssetCacheOpts {
  dir: string;
  /** the controller origin, derived from the adoption wsUrl (ws→http, wss→https) */
  origin: string;
  /** our bearer token and serial, for the controller's node-asset route */
  token: string;
  serial: string;
  log?: (msg: string) => void;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
}

/** Turn the adoption `wsUrl` into the HTTP origin the same controller serves. */
export function originFromWsUrl(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    // The path (/ws/node, possibly behind a tunnel prefix) is dropped: asset refs arrive as
    // paths and are resolved against the ORIGIN, so a tunnel prefix in the asset path still
    // works and a prefix here would be applied twice.
    return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
  } catch {
    return '';
  }
}

export class AssetCache {
  private readonly fetchImpl: typeof fetch;
  private readonly log: (msg: string) => void;
  /** in-flight fetches, so two screens asking for the same hash download it once */
  private readonly inflight = new Map<string, Promise<boolean>>();

  constructor(private readonly opts: AssetCacheOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? (() => {});
    try {
      fs.mkdirSync(opts.dir, { recursive: true });
    } catch {
      /* read-only /data would be a bigger problem elsewhere */
    }
  }

  private pathFor(sha: string): string {
    return path.join(this.opts.dir, sha);
  }

  /** Is this hash already on disk? */
  has(sha: string): boolean {
    try {
      return fs.statSync(this.pathFor(sha)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Make sure every ref is on disk. Returns slot → local file name for the ones that made
   * it; a ref that could not be fetched is simply absent from the map.
   */
  async ensure(refs: AssetRef[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const ref of refs) {
      if (!/^[0-9a-f]{64}$/.test(ref.sha256)) continue;
      if (this.has(ref.sha256) || (await this.fetchOne(ref))) out.set(ref.id, ref.sha256);
    }
    return out;
  }

  private fetchOne(ref: AssetRef): Promise<boolean> {
    const existing = this.inflight.get(ref.sha256);
    if (existing) return existing;
    const p = this.doFetch(ref).finally(() => this.inflight.delete(ref.sha256));
    this.inflight.set(ref.sha256, p);
    return p;
  }

  private async doFetch(ref: AssetRef): Promise<boolean> {
    if (!this.opts.origin) return false;
    // `url` is a PATH resolved against the controller origin — see nodeAssets.ts for why
    // (the controller cannot reliably know what address it is reachable at).
    const url = /^https?:\/\//i.test(ref.url) ? ref.url : `${this.opts.origin}${ref.url}`;
    const sep = url.includes('?') ? '&' : '?';
    const full = `${url}${sep}serial=${encodeURIComponent(this.opts.serial)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(full, {
        headers: { authorization: `Bearer ${this.opts.token}` },
        signal: ctrl.signal,
        redirect: 'error',
      });
      if (!res.ok) {
        this.log(`asset ${ref.id} fetch failed: HTTP ${res.status}`);
        return false;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_BYTES) {
        this.log(`asset ${ref.id} rejected: ${buf.length} bytes`);
        return false;
      }
      // VERIFY THE HASH. The whole cache is keyed on it, so writing bytes that do not match
      // would poison this slot permanently — and it is also the integrity check that makes
      // fetching over plain http on a LAN acceptable.
      const actual = crypto.createHash('sha256').update(buf).digest('hex');
      if (actual !== ref.sha256) {
        this.log(`asset ${ref.id} hash mismatch (wanted ${ref.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
        return false;
      }
      // Atomic: a power cut mid-write must not leave a truncated file under a hash that
      // says the bytes are good.
      const dest = this.pathFor(ref.sha256);
      const tmp = `${dest}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);
      this.log(`cached asset ${ref.id} (${buf.length} bytes)`);
      return true;
    } catch (err) {
      this.log(`asset ${ref.id} fetch failed: ${err instanceof Error ? err.message : err}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read a cached asset for serving to the kiosk, or null. */
  read(sha: string): Buffer | null {
    if (!/^[0-9a-f]{64}$/.test(sha)) return null;
    try {
      return fs.readFileSync(this.pathFor(sha));
    } catch {
      return null;
    }
  }

  /**
   * Delete cached files that are not in `keep`.
   *
   * Called after each content change: without it, every wallpaper a masjid ever tried
   * accumulates on the card until it fills. Bounded work — the cache holds a handful of
   * files, not thousands.
   */
  prune(keep: Iterable<string>): void {
    const keepSet = new Set(keep);
    try {
      for (const name of fs.readdirSync(this.opts.dir)) {
        if (/^[0-9a-f]{64}$/.test(name) && !keepSet.has(name)) {
          try {
            fs.rmSync(path.join(this.opts.dir, name), { force: true });
          } catch {
            /* ignore */
          }
        } else if (name.endsWith('.tmp')) {
          // Leftover from a power cut mid-write.
          try {
            fs.rmSync(path.join(this.opts.dir, name), { force: true });
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* no cache dir yet */
    }
  }
}
