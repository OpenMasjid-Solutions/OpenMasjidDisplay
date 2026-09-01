// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * orchestrator.ts — the brain that keeps reality matching intent.
 *
 * On every reconcile it: resolves each screen's effective content, starts/stops
 * the timetable + transcode pipelines that are actually needed, and programs
 * MediaMTX so each screen's stable path (tv_<id>) relays the right content. It
 * also samples each path's live state for the status feed.
 *
 * Model:
 *   • Timetables publish to a runtime path named by their id (tt_<id>).
 *   • Direct sources become a MediaMTX proxy path (src_<id>, sourceOnDemand).
 *   • Normalize sources are transcoded by us and published to src_<id>.
 *   • Each screen path (tv_<id>) self-relays from rtsp://<loopback>/<contentPath>,
 *     so switching a screen is a single PATCH of its source.
 */
import { config } from './config';
import { makeLog } from './logger';
import type { Store } from './store';
import { RenderManager, type NormalizeSpec } from './render/renderer';
import { dimsFor } from './render/svg';
import { resolveTv } from './scheduler';
import { webScreenOnline } from './webScreen';
import { deviceOnline } from './piAgent';
import {
  ping,
  listConfiguredPaths,
  addPath,
  patchPath,
  deletePath,
  getPathState,
  type PathConf,
} from './mediamtx';
import type { ContentRef, Tv, TvStatus } from './types';

const log = makeLog('orchestrator');

export class Orchestrator {
  private running = false;
  private rerun = false;
  private statuses: TvStatus[] = [];
  /** last config applied per path, so we don't re-PATCH (and force a MediaMTX
   *  config reload) every reconcile when nothing actually changed. */
  private applied = new Map<string, string>();

  /** Per-screen alert state for the offline/online notifications. */
  private alerts = new Map<string, { downSince: number | null; offlineNotified: boolean; lastAlertAt: number }>();
  /** A screen must stop pulling its stream for this long before we call it offline. */
  private readonly OFFLINE_MS = 90_000;
  /**
   * And we will not tell the admin about the same screen more often than this.
   *
   * These alerts fire on an EXTERNAL failure rather than on anything a person did, which is the
   * shape that has no natural bound. `offlineNotified` latches, so a screen that is simply down
   * is reported once — but a decoder that flaps produces a down alert and a recovery alert every
   * `OFFLINE_MS`, and at 90 seconds that is around 950 pairs a day, each one an email and a
   * webhook. Nothing else limits it: the platform's alert route gates on the admin's on/off for
   * the alert type, not on how often it arrives.
   *
   * The floor is on the DOWN alert only. A recovery is exempt because it can only ever follow a
   * down alert we already sent, and suppressing it would leave the admin believing a screen is
   * dead — so the bound is two alerts per screen per window, with every "down" still getting its
   * matching "back online". Thirty minutes matches what the other OpenMasjid apps settled on for
   * the same class of alert.
   */
  private readonly ALERT_MIN_GAP_MS = 30 * 60_000;

  constructor(
    private readonly store: Store,
    private readonly render: RenderManager,
    private readonly onStatus: (s: TvStatus[]) => void,
    /** optional Fabric notifier — alerts the masjid when a screen stops/starts pulling */
    private readonly notify?: (p: { title?: string; text: string; level?: 'info' | 'success' | 'warning' | 'error' }) => unknown,
  ) {}

  getStatuses(): TvStatus[] {
    return this.statuses;
  }

  /** Resolve a content ref to its MediaMTX path name, or null if invalid/off. */
  private contentPath(c: ContentRef): string | null {
    const db = this.store.db;
    if (c.kind === 'timetable' && c.id && db.timetables.some((t) => t.id === c.id)) return c.id;
    if (c.kind === 'source' && c.id) {
      const s = db.sources.find((x) => x.id === c.id);
      if (s && s.enabled) return s.id;
    }
    return null;
  }

  /** Run a reconcile; coalesces overlapping calls into a single trailing rerun. */
  async reconcile(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerun = false;
        await this.runOnce();
      } while (this.rerun);
    } catch (err) {
      log.error('reconcile failed', err);
    } finally {
      this.running = false;
    }
  }

  private async runOnce(): Promise<void> {
    const db = this.store.db;
    const tz = db.settings.scheduleTimezone;
    const now = new Date();

    const resolutions = db.tvs.map((tv) => ({ tv, res: resolveTv(tv, db.schedules, now, tz) }));

    const refTt = new Set<string>();
    const refSrc = new Set<string>();
    for (const { tv, res } of resolutions) {
      const cp = this.contentPath(res.content);
      if (!cp) continue;
      if (res.content.kind === 'timetable') {
        // A browser screen renders the timetable ITSELF, so it needs no ffmpeg pipeline and no
        // resvg loop. That is the whole saving: a masjid that moves every screen to a browser
        // stops encoding video entirely.
        if (tv.kind === 'web' || tv.kind === 'pi') continue;
        refTt.add(cp);
      } else if (res.content.kind === 'source') {
        // A Pi agent opens the camera's own RTSP address directly, on the same LAN as the
        // camera. Pulling it here as well would mean the server carrying video it is not
        // showing to anyone — and with the server in the cloud, carrying it across the
        // internet twice. That is precisely what the device exists to avoid.
        if (tv.kind === 'pi') continue;
        // A BROWSER screen is the opposite case, and skipping it here was a real bug: a browser
        // cannot render a camera, it PLAYS one — as HLS, which MediaMTX can only serve from a
        // path it has been told to pull. Leaving web screens out meant the source path was
        // never created, so every camera on a browser screen was "unavailable".
        refSrc.add(cp);
      }
    }

    const activeTts = db.timetables.filter((t) => refTt.has(t.id));
    const refSources = db.sources.filter((s) => refSrc.has(s.id) && s.enabled);
    const directSources = refSources.filter((s) => s.mode === 'direct');
    const normalizeSources: NormalizeSpec[] = refSources
      .filter((s) => s.mode === 'normalize')
      .map((s) => ({ id: s.id, url: s.url, dims: dimsFor('landscape', s.quality) }));

    const reachable = await ping();

    // Program MediaMTX BEFORE (re)starting pipelines, and delete now-unwanted
    // paths BEFORE adding, so a source switching direct→normalize has its stale
    // proxy path removed before the transcode publishes into that same name.
    if (reachable) {
      const configured = await listConfiguredPaths();
      const desired = new Map<string, PathConf>();

      for (const s of directSources) {
        desired.set(s.id, {
          source: s.url,
          sourceOnDemand: true,
          sourceOnDemandStartTimeout: '10s',
          sourceOnDemandCloseAfter: '10s',
        });
      }
      for (const { tv, res } of resolutions) {
        const cp = this.contentPath(res.content);
        if (!cp) continue;
        // Neither a browser screen nor a Pi has a decoder pointed at an RTSP path: they draw
        // the timetable themselves and open a camera directly. Programming one would leave
        // MediaMTX holding a relay open for a reader that never arrives.
        if (tv.kind === 'web' || tv.kind === 'pi') continue;
        desired.set(tv.id, {
          source: `${config.rtspLoopback}/${cp}`,
          sourceOnDemand: true,
          sourceOnDemandStartTimeout: '10s',
          sourceOnDemandCloseAfter: '60s',
        });
      }

      // Remove screen/source paths we own that are no longer wanted (first).
      for (const name of configured) {
        if ((name.startsWith('tv_') || name.startsWith('src_')) && !desired.has(name)) {
          await deletePath(name);
          this.applied.delete(name);
        }
      }
      for (const [name, conf] of desired) {
        const key = JSON.stringify(conf);
        if (configured.has(name)) {
          // Only patch (which reloads MediaMTX) when the config actually changed.
          if (this.applied.get(name) !== key) {
            await patchPath(name, conf);
            this.applied.set(name, key);
          }
        } else {
          await addPath(name, conf);
          this.applied.set(name, key);
        }
      }
    } else {
      this.applied.clear(); // re-add everything once it comes back
      log.warn('MediaMTX API unreachable; will retry on next reconcile');
    }

    // Start/stop the timetable + transcode pipelines to match the active set.
    this.render.reconcile(activeTts, normalizeSources, (id) =>
      db.timetables.find((t) => t.id === id),
    );

    const statuses: TvStatus[] = [];
    for (const { tv, res } of resolutions) {
      const cp = this.contentPath(res.content);
      // "Pulling" = a decoder is actively reading this screen's RTSP path. The path
      // is on-demand, so a reader (the screen) is what makes it live — readers≥1 is
      // the cleanest "the screen is on and showing the stream" signal.
      let pulling = false;
      if (tv.kind === 'web') {
        // The browser-screen equivalent: it checks in on a timer, and six missed polls is
        // offline. Same field, so the panel badge and the offline alert are unchanged.
        pulling = webScreenOnline(tv.id, Date.now());
      } else if (tv.kind === 'pi') {
        // Same idea for a device, keyed on the DEVICE rather than the screen: the agent is
        // what checks in, and a screen with no device adopted yet is simply offline.
        pulling = !!tv.piDeviceId && deviceOnline(tv.piDeviceId, Date.now());
      } else if (reachable && cp) {
        const st = await getPathState(tv.id);
        pulling = !!st && st.readers >= 1;
      }
      // A decoder reading a FROZEN picture still counts as "pulling", so freshness has to
      // be asked separately — otherwise a screen showing yesterday's times reports green.
      // Staleness is about the RENDER LOOP producing frames. A browser screen has no such
      // loop on the server — it draws for itself — so a frozen-frame verdict would be about a
      // pipeline this screen does not use. It marks its own picture instead (screen.tsx),
      // from the server clock it is handed and from whether it can still reach us.
      const isTt = res.content.kind === 'timetable' && !!cp && tv.kind !== 'web' && tv.kind !== 'pi';
      const reason = isTt ? this.render.staleReason(cp!) : null;
      statuses.push({
        tvId: tv.id,
        effective: res.content,
        source: res.source,
        ruleId: res.ruleId,
        streamReady: pulling,
        contentStale: reason !== null,
        ...(reason ? { staleReason: reason } : {}),
        // Only meaningful for a FROZEN screen. Under a wrong clock the renderer is happily
        // producing a frame every second, so the age is ~0 and quoting it would read as
        // "out of date, 0 minutes ago" — true but useless, and it looks like a panel bug.
        frameAgeMs: isTt && reason !== 'clock' ? this.render.frameAgeMs(cp!) : undefined,
      });
    }
    this.statuses = statuses;
    this.onStatus(this.statuses);

    // Offline/online notifications, only while MediaMTX itself is reachable (so a
    // platform/MediaMTX blip never makes every screen look offline at once).
    if (reachable) {
      this.runAlerts(
        resolutions.map(({ tv, res }, i) => ({
          tv,
          // A screen showing a FROZEN timetable is not "online" in any sense the masjid
          // cares about — wrong prayer times on the wall are worse than a blank screen —
          // so stale content raises the same alert as a disconnected decoder.
          pulling: statuses[i].streamReady && !statuses[i].contentStale,
          off: res.content.kind === 'off',
          stale: !!statuses[i].contentStale,
          staleReason: statuses[i].staleReason,
          // Whether a decoder is attached, INDEPENDENT of freshness. The alert wording said
          // "still lit up" purely on `stale`, so a screen that was stale AND had no decoder
          // attached was described as lit up when it was dark.
          litUp: statuses[i].streamReady,
        })),
      );
    }
  }

  /**
   * Relay an alert (via the Fabric) when a screen stops pulling its RTSP stream for
   * more than OFFLINE_MS, and again when it resumes. Screens intentionally set to
   * "Off" are not monitored. Debounced so brief reconnects (content switches, power
   * cycles) don't flap. Fires only when a `notify` callback is wired and configured.
   */
  /** The alert to send for a screen that has been unhealthy for OFFLINE_MS. Split out so the
   *  wording is testable, and so each distinct fault names its own remedy. */
  alertFor(
    name: string,
    s: { stale: boolean; staleReason?: 'frozen' | 'clock'; litUp: boolean },
  ): { title: string; text: string; level: 'info' | 'success' | 'warning' | 'error' } {
    if (s.stale && s.staleReason === 'clock') {
      return {
        title: 'Clock wrong — prayer times are wrong',
        text: `⚠️ "${name}" is showing prayer times worked out from this machine's clock, and that clock is clearly wrong. Every time on that screen is wrong. Set the clock (or fix its time sync) and the screen corrects itself.`,
        level: 'error',
      };
    }
    if (s.stale) {
      return {
        title: 'Screen showing out-of-date times',
        text: s.litUp
          ? `⚠️ "${name}" is still lit up, but its timetable stopped updating — the prayer times on it are NOT current. Please check that screen.`
          : `⚠️ "${name}" has stopped updating its timetable AND is not pulling its stream — the times it last showed are not current. Please check that screen and its decoder.`,
        level: 'error',
      };
    }
    return {
      title: 'Screen offline',
      text: `📺 "${name}" isn't pulling its video stream — the screen or its decoder may be turned off or disconnected.`,
      level: 'warning',
    };
  }

  private runAlerts(
    items: {
      tv: Tv;
      pulling: boolean;
      off: boolean;
      stale?: boolean;
      staleReason?: 'frozen' | 'clock';
      litUp?: boolean;
    }[],
  ): void {
    if (!this.notify) return;
    const now = Date.now();
    const present = new Set(items.map((i) => i.tv.id));
    for (const id of [...this.alerts.keys()]) if (!present.has(id)) this.alerts.delete(id);

    for (const { tv, pulling, off, stale, staleReason, litUp } of items) {
      let st = this.alerts.get(tv.id);
      if (!st) {
        st = { downSince: null, offlineNotified: false, lastAlertAt: 0 };
        this.alerts.set(tv.id, st);
      }
      const name = (tv.name || 'Screen').slice(0, 60);
      if (off) {
        // Intentionally off — not "offline". Clear any pending/asserted state quietly.
        st.downSince = null;
        st.offlineNotified = false;
        continue;
      }
      if (pulling) {
        // Only ever after a down alert the admin actually received, and never floored — see
        // ALERT_MIN_GAP_MS. It resets the floor, so the NEXT down alert is the one that waits.
        if (st.offlineNotified) {
          void this.notify({ title: 'Screen back online', text: `✅ "${name}" is showing its stream again.`, level: 'success' });
          st.lastAlertAt = now;
        }
        st.downSince = null;
        st.offlineNotified = false;
      } else {
        if (st.downSince == null) st.downSince = now;
        if (now - st.downSince >= this.OFFLINE_MS && !st.offlineNotified) {
          // Floored, and `offlineNotified` is deliberately NOT set when it is. A screen that is
          // still down when the window expires is reported then — the alert is delayed, never
          // dropped, which is the difference between pacing an alert and losing one.
          if (now - st.lastAlertAt < this.ALERT_MIN_GAP_MS) continue;
          st.offlineNotified = true;
          st.lastAlertAt = now;
          // Say the true thing. "Still lit up" is only accurate when a decoder really is
          // attached, and a wrong clock is a different problem from a frozen renderer with
          // a different remedy, so each gets its own wording.
          void this.notify(this.alertFor(name, { stale: !!stale, staleReason, litUp: !!litUp }));
        }
      }
    }
  }
}
