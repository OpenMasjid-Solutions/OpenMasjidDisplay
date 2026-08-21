// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * pi/assetCache.ts — the images and fonts a Pi draws with, fetched once and kept.
 *
 * The renderer takes its pictures as `data:` URIs, because resvg embeds those and does not go
 * and fetch anything — deliberately, since a renderer that fetches is a renderer that can be
 * pointed at somewhere it should not go. A browser screen sidesteps this by letting the *browser*
 * load the URLs; the Pi has no browser, so it does the fetching itself and hands over bytes.
 *
 * Caching is not an optimisation here, it is a requirement. A masjid's wallpaper is often a
 * photograph of a few megabytes, and re-fetching it for every frame would use more bandwidth than
 * the video stream this whole design exists to avoid. It is also what lets a screen come back
 * after a power cut while the internet is still down: the last background it drew is on the card.
 *
 * Two guards worth naming, because both protect a device nobody is watching:
 *
 *   - **A size cap**, so a wrong URL cannot fill an SD card.
 *   - **A prune**, so replacing a wallpaper every week does not leave every old one behind
 *     forever.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sniffImageMime, isRenderableImageMime } from '../render/background';

/** Room for a large photographic wallpaper, and not much more. */
export const MAX_ASSET_BYTES = 12 * 1024 * 1024;

/** Long enough for a slow masjid uplink to deliver a few megabytes. */
const FETCH_TIMEOUT_MS = 60_000;

/**
 * How long to wait before trying a failed asset again — doubling, from seconds to five minutes.
 *
 * It used to be a flat five minutes, and that number was chosen against the wrong failure. The one
 * that matters is not "this URL is wrong", it is "the first fetch after a restart lost a race" —
 * the network settling, the server still coming up, a Wi-Fi association half made. The background
 * is the FIRST asset the agent asks for, so it is the one that eats that failure, and a flat five
 * minutes meant the most visible thing on the screen was missing for five minutes while the logo
 * and every announcement image (asked for after it, once the network was up) arrived at once. On a
 * real device that read exactly as "the custom background does not work".
 *
 * Doubling gets both halves right: a transient failure costs seconds, and a genuinely wrong URL
 * still settles into asking about as often as before.
 */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/** How long to wait before attempt `tries` + 1. Exported because it is the whole of the fix: the
 *  behaviour that mattered was a NUMBER, and a number is what a test can hold still. */
export function retryDelayMs(tries: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, tries - 1), RETRY_MAX_MS);
}

export const CACHE_DIR = process.env.OMD_SCREEN_CACHE || '/var/lib/openmasjid-screen/cache';

/** A filename derived from the URL. Hashed rather than sanitised: the URL contains this
 *  device's token, which has no business being a filename anybody can read off the card. */
function keyFor(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
}

export class AssetCache {
  /** url → data: URI, so a frame a second costs no disk reads either. */
  private memo = new Map<string, string>();
  /** urls that failed, with how many times running — so a missing asset is not re-fetched every
   *  single frame, and a transient failure is not punished for five minutes. */
  private failed = new Map<string, { at: number; tries: number }>();

  constructor(
    private readonly dir: string = CACHE_DIR,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Told about every failure, because the alternative is what actually happened: a background
     *  that never appeared, on a device nobody can open a console on, with not one line about it
     *  in the journal the dashboard collects. */
    private readonly onFail: (message: string) => void = () => {},
  ) {}

  private ensureDir(): boolean {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  private pathFor(url: string): string {
    return path.join(this.dir, keyFor(url));
  }

  /** Fetch to the cache if it is not already there, and return the bytes. */
  private async bytes(url: string): Promise<Buffer | null> {
    const file = this.pathFor(url);
    try {
      const buf = fs.readFileSync(file);
      if (buf.length) return buf;
    } catch {
      /* not cached yet */
    }

    // Don't hammer a URL that has already failed, but do come back to it quickly the first time.
    const prev = this.failed.get(url);
    if (prev) {
      if (Date.now() - prev.at < retryDelayMs(prev.tries)) return null;
    }

    try {
      const res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        // Same reasoning as every other outbound call in this project: the server does not
        // redirect these, so a redirect means something is in the way.
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Checked before reading the body as well as after: a wrong Content-Length is not a
      // reason to buffer a gigabyte into a Pi's memory.
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > MAX_ASSET_BYTES) throw new Error(`declared ${declared} bytes`);

      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_ASSET_BYTES) throw new Error(`${buf.length} bytes`);

      if (this.ensureDir()) {
        // Through a temporary name: a power cut mid-write must not leave a truncated image that
        // is then treated as cached forever.
        const tmp = `${this.pathFor(url)}.tmp`;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, this.pathFor(url));
      }
      this.failed.delete(url);
      return buf;
    } catch (err) {
      const tries = (prev?.tries ?? 0) + 1;
      this.failed.set(url, { at: Date.now(), tries });
      const wait = retryDelayMs(tries);
      // The URL carries this device's token, so only the last part of it is named.
      const what = url.slice(url.lastIndexOf('/') + 1);
      this.onFail(
        `could not fetch ${what} (attempt ${tries}): ${err instanceof Error ? err.message : String(err)} — retrying in ${Math.round(wait / 1000)}s`,
      );
      return null;
    }
  }

  /**
   * An image as a `data:` URI the renderer can embed, or null.
   *
   * The type is sniffed from the bytes rather than taken from the response header, and checked
   * against the same list the server checks against. A mislabelled image is not a hypothetical:
   * resvg picks its decoder from the label, so a PNG announced as a JPEG renders as nothing at
   * all — silently, on a screen in a hall.
   */
  async dataUri(url: string): Promise<string | null> {
    const hit = this.memo.get(url);
    if (hit) return hit;

    const buf = await this.bytes(url);
    if (!buf) return null;

    const mime = sniffImageMime(buf);
    if (!mime || !isRenderableImageMime(mime)) return null;

    const uri = `data:${mime};base64,${buf.toString('base64')}`;
    this.memo.set(url, uri);
    return uri;
  }

  /** A cached file's path on disk — how fonts reach resvg, which takes those by path. */
  async localFile(url: string): Promise<string | null> {
    const buf = await this.bytes(url);
    return buf ? this.pathFor(url) : null;
  }

  /**
   * Forget everything not in `keep`.
   *
   * Called when the timetable changes rather than on a timer, because that is exactly when an
   * asset stops being referenced — a new wallpaper, a removed announcement. Without it the card
   * accumulates every image the masjid has ever used.
   */
  prune(keep: string[]): void {
    const wanted = new Set(keep.map(keyFor));
    for (const url of [...this.memo.keys()]) if (!keep.includes(url)) this.memo.delete(url);
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (wanted.has(name)) continue;
        try {
          fs.unlinkSync(path.join(this.dir, name));
        } catch {
          /* it can go next time */
        }
      }
    } catch {
      /* no cache directory yet */
    }
  }
}
