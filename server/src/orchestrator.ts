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
import os from 'node:os';
import { config } from './config';
import { makeLog } from './logger';
import type { Store } from './store';
import { RenderManager, type NormalizeSpec } from './render/renderer';
import { dimsFor } from './core';
import { resolveTv } from './scheduler';
import { planNodeContent, type NodePlan } from './nodeContent';
import { assetsForTimetable } from './nodeAssets';
import type { NodeHub } from './nodeHub';
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

/** Is this screen driven by a Pi node (rather than an RTSP decoder box)? Requires BOTH
 *  the kind and a bound node — a half-configured screen falls back to the legacy path
 *  rather than silently showing nothing. */
export function isNodeScreen(tv: Tv): boolean {
  return tv.kind === 'node' && !!tv.nodeId;
}

/**
 * An RTSP origin a node on the LAN can reach us at, or '' if we cannot tell.
 *
 * Only used for the re-encode fallback (§12 of the spec), which by definition needs the
 * controller on the same network as the camera. `NODE_RELAY_HOST` overrides the guess
 * for multi-homed hosts; otherwise we take the first non-internal IPv4 address, which is
 * right for the single-NIC box a masjid actually runs. A cloud-hosted controller has no
 * such address and returns '' — planNodeContent turns that into a clear admin message
 * instead of a black screen.
 */
export function lanRtspBase(): string {
  const override = (process.env.NODE_RELAY_HOST ?? '').trim();
  if (override) return `rtsp://${override}:${config.rtspPort}`;
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && a.address) return `rtsp://${a.address}:${config.rtspPort}`;
    }
  }
  return '';
}

export class Orchestrator {
  private running = false;
  private rerun = false;
  private statuses: TvStatus[] = [];
  /** last config applied per path, so we don't re-PATCH (and force a MediaMTX
   *  config reload) every reconcile when nothing actually changed. */
  private applied = new Map<string, string>();

  /** Per-screen alert state for the offline/online notifications. */
  private alerts = new Map<string, { downSince: number | null; offlineNotified: boolean }>();
  /** A screen must stop pulling its stream for this long before we call it offline. */
  private readonly OFFLINE_MS = 90_000;
  /** Last reported node-screen problem per screen, so we alert on change, not on repeat. */
  private nodeProblems = new Map<string, string>();
  /** The Pi node hub, attached after construction (it needs this orchestrator's notifier,
   *  so the two cannot be constructed in one expression). Absent = no node support. */
  private hub: NodeHub | null = null;

  /** Wire the Pi node hub in. Called once at startup; safe to never call. */
  attachNodeHub(hub: NodeHub): void {
    this.hub = hub;
  }

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

    // Screens split by HOW they are driven. Content resolution above is shared verbatim
    // (overrides, schedules and the volunteer page work identically for both kinds) —
    // only the delivery differs from here on.
    const decoders = resolutions.filter(({ tv }) => !isNodeScreen(tv));
    const nodeScreens = resolutions.filter(({ tv }) => isNodeScreen(tv));

    // THE COMPUTE WIN: only DECODER screens contribute to the working set, so a
    // timetable shown solely on Pi nodes never starts an ffmpeg pipeline and never gets
    // a MediaMTX path. A node renders it itself from a few KB of JSON. Do not "simplify"
    // this back to iterating every screen — nodeContent.test.ts asserts it.
    const refTt = new Set<string>();
    const refSrc = new Set<string>();
    for (const { res } of decoders) {
      const cp = this.contentPath(res.content);
      if (!cp) continue;
      if (res.content.kind === 'timetable') refTt.add(cp);
      else if (res.content.kind === 'source') refSrc.add(cp);
    }

    // Work out what each node should show. A node that needs the controller to re-encode
    // an undecodable camera is the ONE case where a node screen adds controller work —
    // and only then, for that one source.
    const nodePlans = this.planNodes(nodeScreens, refSrc);
    const relaySrc = new Set<string>();
    for (const { plan } of nodePlans) if (plan.normalizeSourceId) relaySrc.add(plan.normalizeSourceId);

    const activeTts = db.timetables.filter((t) => refTt.has(t.id));
    const refSources = db.sources.filter((s) => refSrc.has(s.id) && s.enabled);
    const directSources = refSources.filter((s) => s.mode === 'direct');
    // Sources needing a transcode: those an admin marked 'normalize' for decoder screens,
    // plus any a node asked us to relay (deduped — the same source can be both).
    const normalizeIds = new Set<string>([...refSources.filter((s) => s.mode === 'normalize').map((s) => s.id), ...relaySrc]);
    const normalizeSources: NormalizeSpec[] = db.sources
      .filter((s) => normalizeIds.has(s.id) && s.enabled)
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
      // Only decoder screens get a tv_<id> relay path. A node screen has no decoder box
      // to serve, so configuring one would keep an idle path (and its on-demand plumbing)
      // alive for nothing. A screen converted to a node therefore has its old path
      // removed by the cleanup below, exactly like a deleted screen.
      for (const { tv, res } of decoders) {
        const cp = this.contentPath(res.content);
        if (!cp) continue;
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

    // Push each node its content (the hub no-ops when it matches what it last sent, so
    // this is free on the 15 s reconciles where nothing changed).
    for (const { tv, plan } of nodePlans) {
      const nodeId = tv.nodeId;
      if (!nodeId) continue;
      this.hub?.setContent(nodeId, plan.content);
      this.reportNodeProblem(tv.id, tv.name, plan.problem);
    }

    const statuses: TvStatus[] = [];
    for (const { tv, res } of resolutions) {
      const cp = this.contentPath(res.content);
      let ready = false;
      if (isNodeScreen(tv)) {
        // For a node there is no RTSP path to inspect: the node IS the player. "Ready"
        // means its socket is up and it has heartbeated recently (protocol
        // OFFLINE_AFTER_MS), which is the same ~90 s tolerance decoder screens get.
        ready = !!tv.nodeId && !!this.hub?.isFresh(tv.nodeId);
      } else if (reachable && cp) {
        // "Pulling" = a decoder is actively reading this screen's RTSP path. The path
        // is on-demand, so a reader (the screen) is what makes it live — readers≥1 is
        // the cleanest "the screen is on and showing the stream" signal.
        const st = await getPathState(tv.id);
        ready = !!st && st.readers >= 1;
      }
      statuses.push({
        tvId: tv.id,
        effective: res.content,
        source: res.source,
        ruleId: res.ruleId,
        streamReady: ready,
      });
    }
    this.statuses = statuses;
    this.onStatus(this.statuses);

    // Offline/online notifications. Decoder screens are only judged while MediaMTX is
    // reachable (so a MediaMTX blip never makes every screen look offline at once);
    // node screens are judged always, because their liveness is a socket to US and has
    // nothing to do with whether MediaMTX is up.
    const byId = new Map(statuses.map((s) => [s.tvId, s]));
    this.runAlerts(
      resolutions
        .filter(({ tv }) => isNodeScreen(tv) || reachable)
        .map(({ tv, res }) => ({
          tv,
          pulling: byId.get(tv.id)?.streamReady ?? false,
          off: res.content.kind === 'off',
        })),
      // Which screens EXIST, as distinct from which are judgeable this pass. Alert state is
      // pruned against existence only — a decoder screen is unjudgeable while MediaMTX is
      // unreachable, but it has not gone away, and forgetting it would re-arm its 90 s timer
      // and fire a second "Screen offline" push (or swallow its "back online") on every
      // MediaMTX restart. That would hit installs with no Pi nodes at all.
      new Set(resolutions.map(({ tv }) => tv.id)),
    );
  }

  /**
   * Work out what each node screen should show.
   *
   * `decoderSrcIds` is the set of sources currently feeding legacy decoder screens; it is
   * what lets planNodeContent refuse to start a transcode that would fight an existing
   * MediaMTX proxy path and break one of those screens.
   */
  private planNodes(
    nodeScreens: { tv: Tv; res: { content: ContentRef } }[],
    decoderSrcIds: ReadonlySet<string>,
  ): { tv: Tv; plan: NodePlan }[] {
    const db = this.store.db;
    const relayBase = lanRtspBase();
    return nodeScreens.map(({ tv, res }) => {
      const node = tv.nodeId ? db.nodes?.find((n) => n.id === tv.nodeId) : undefined;
      const plan = planNodeContent({
        content: res.content,
        timetable: res.content.kind === 'timetable' ? db.timetables.find((t) => t.id === res.content.id) : undefined,
        source: res.content.kind === 'source' ? db.sources.find((s) => s.id === res.content.id) : undefined,
        caps: node?.caps,
        relayBase,
        usedByDecoder: res.content.kind === 'source' && !!res.content.id && decoderSrcIds.has(res.content.id),
        // The masjid's own background photo and logo, addressed by content hash so a node
        // fetches each once and then never again however often content is re-pushed.
        assets:
          res.content.kind === 'timetable'
            ? (() => {
                const tt = db.timetables.find((t) => t.id === res.content.id);
                return tt ? assetsForTimetable(tt) : [];
              })()
            : [],
      });
      return { tv, plan };
    });
  }

  /** Alert the masjid once per distinct problem per screen, not once per reconcile. */
  private reportNodeProblem(tvId: string, tvName: string, problem: string | undefined): void {
    const previous = this.nodeProblems.get(tvId);
    if (!problem) {
      this.nodeProblems.delete(tvId);
      return;
    }
    if (previous === problem) return;
    this.nodeProblems.set(tvId, problem);
    log.warn(`node screen "${tvName}": ${problem}`);
    void this.notify?.({
      title: 'Screen needs attention',
      text: `📺 "${(tvName || 'Screen').slice(0, 60)}": ${problem}`,
      level: 'warning',
    });
  }

  /**
   * Relay an alert (via the Fabric) when a screen stops pulling its RTSP stream for
   * more than OFFLINE_MS, and again when it resumes. Screens intentionally set to
   * "Off" are not monitored. Debounced so brief reconnects (content switches, power
   * cycles) don't flap. Fires only when a `notify` callback is wired and configured.
   */
  private runAlerts(items: { tv: Tv; pulling: boolean; off: boolean }[], existing: ReadonlySet<string>): void {
    if (!this.notify) return;
    const now = Date.now();
    // Prune by EXISTENCE, not by what we could judge this pass — see the call site.
    for (const id of [...this.alerts.keys()]) if (!existing.has(id)) this.alerts.delete(id);

    for (const { tv, pulling, off } of items) {
      let st = this.alerts.get(tv.id);
      if (!st) {
        st = { downSince: null, offlineNotified: false };
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
        if (st.offlineNotified) {
          void this.notify({ title: 'Screen back online', text: `✅ "${name}" is showing its stream again.`, level: 'success' });
        }
        st.downSince = null;
        st.offlineNotified = false;
      } else {
        if (st.downSince == null) st.downSince = now;
        if (now - st.downSince >= this.OFFLINE_MS && !st.offlineNotified) {
          st.offlineNotified = true;
          void this.notify({
            title: 'Screen offline',
            text: `📺 "${name}" isn't pulling its video stream — the screen or its decoder may be turned off or disconnected.`,
            level: 'warning',
          });
        }
      }
    }
  }
}
