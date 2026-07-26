// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * agent.ts — the state machine that IS the node.
 *
 * Deliberately separated from index.ts (which only wires up a real Pi) so the whole
 * behaviour can be driven in a test against the real controller with a fake Platform —
 * see agent.test.ts. There is no Pi-specific code in this file.
 *
 * States, in the order a node lives through them:
 *
 *   starting        → the agent came up; nothing on screen yet
 *   status_screen   → unadopted, or adopted-but-never-told-what-to-show: the diagnostic
 *                     page with the IP in huge type, which is how an admin adopts it
 *   timetable       → rendering a timetable locally, forever, offline-tolerant
 *   stream          → playing an RTSP URL
 *   off             → output blanked
 *
 * THE INVARIANT: losing the controller never changes what is on screen. Only an explicit
 * `set_content` does. A masjid's timetable keeps ticking through a container restart, a
 * network outage, or a week of downtime, because it is computed here from the clock.
 */
import { ControllerClient } from './controller';
import { Display, type Target } from './display';
import type { AgentStore } from './store';
import type { Platform } from './platform';
import { AssetCache, originFromWsUrl } from './assetCache';
import type { AssetRef, ControllerFrame, NodeMode, SetContent } from '../../../packages/protocol/src/index';

/** What the kiosk page fetches from /api/view to know what to draw. */
export type KioskView =
  | {
      kind: 'timetable';
      /** the Timetable document, verbatim from the controller */
      doc: unknown;
      /** false while the clock is unsynced — the page shows a notice instead of times */
      clockSynced: boolean;
      /**
       * Local URLs for the masjid's own images, by render slot ('bg' / 'logo'), for the
       * ones that are actually cached. Absent slots fall back to the themed scene.
       *
       * Plain URLs rather than data URIs: the controller has to inline base64 because resvg
       * only embeds data URIs, but a browser fetches `<image href>` happily — and over
       * loopback that avoids base64-ing a multi-megabyte photo into the document every
       * second on a 512 MB board. The bytes are identical, so the pixels are too.
       */
      assets?: Record<string, string>;
    }
  | {
      kind: 'status';
      serial: string;
      model: string;
      fw: string;
      ip: string;
      adopted: boolean;
      controllerName: string;
      /** is the controller link up right now? */
      linked: boolean;
      /** a short line explaining the current situation, shown under the address */
      note: string;
      /** set by `identify`: show the name big for a moment */
      identify?: { name: string; untilMs: number };
    };

export interface AgentOpts {
  store: AgentStore;
  platform: Platform;
  fw: string;
  /** origin the kiosk browser should load, e.g. 'http://127.0.0.1' */
  kioskOrigin: string;
  /** where cached assets live (a subdirectory of /data) */
  assetDir: string;
  log?: (msg: string) => void;
  now?: () => number;
  rand?: () => number;
  /** Restart-backoff timer, injectable so tests do not wait out real seconds (the
   *  supervisor's real delays run 1s → 2s → 4s → …, which is right on a Pi and far too
   *  slow in a test). Same reasoning as `now` and `rand`. */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
}

export class Agent {
  private readonly display: Display;
  private client: ControllerClient | null = null;
  private content: SetContent | null = null;
  /** render slot ('bg'/'logo') → cached sha, for whatever is actually on disk */
  private assets = new Map<string, string>();
  private cache: AssetCache | null = null;
  private linked = false;
  private note = '';
  private identifyUntil = 0;
  private identifyName = '';
  private readonly log: (msg: string) => void;
  private readonly now: () => number;

  constructor(private readonly opts: AgentOpts) {
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.display = new Display(opts.platform, {
      onRestart: (mode, attempt) => {
        this.log(`${mode} process crashed; restart ${attempt}`);
        this.client?.event('process_restarted', `${mode} restart ${attempt}`);
      },
      onGaveUp: (mode, detail) => {
        // Do not leave a black TV with no explanation: fall back to the page that at least
        // states the node's identity and the error.
        this.log(`${mode} kept crashing (${detail}); falling back to the status screen`);
        this.client?.event('stream_error', `${mode} kept crashing: ${detail}`);
        this.note = `Could not show the ${mode === 'stream' ? 'video source' : 'timetable'}: ${detail}`;
        void this.display.show(this.statusTarget());
      },
    }, opts.setTimer);
  }

  /** Bring the node up: show the status screen, then dial home if we are adopted. */
  async start(): Promise<void> {
    // `note` carries EXCEPTIONAL states only (clock unsynced, a render that gave up).
    // Adoption and link state are derived by the kiosk from `adopted`/`linked`, so setting
    // a note here as well printed the same sentence twice on the TV.
    this.note = '';
    await this.display.show(this.statusTarget());
    this.connectIfAdopted();
  }

  /** Called by the local API right after a successful adoption. */
  onAdopted(): void {
    this.note = '';
    this.connectIfAdopted();
  }

  private connectIfAdopted(): void {
    const a = this.opts.store.adoption;
    if (!a || this.client) return;
    const p = this.opts.platform;
    this.client = new ControllerClient({
      wsUrl: a.wsUrl,
      token: a.nodeToken,
      serial: p.serial(),
      fw: this.opts.fw,
      model: p.model(),
      caps: p.caps(),
      rand: this.opts.rand,
      sample: () => ({ mode: this.mode, health: p.health() }),
      handlers: {
        onLink: (up, detail) => {
          if (up !== this.linked) this.log(`controller link ${up ? 'up' : 'down'} (${detail})`);
          this.linked = up;
          // NOTE: no display change here, on purpose. See the invariant in the header.
          // Deliberately no note: the kiosk already renders "Waiting for X" vs "Connected to
          // X" from `linked`, and a note would duplicate it on screen.
        },
        onCommand: (frame) => this.onCommand(frame),
      },
    });
    this.client.start();
  }

  private async onCommand(frame: ControllerFrame): Promise<string | void> {
    switch (frame.type) {
      case 'ping':
        return;
      case 'identify':
        this.identifyUntil = this.now() + frame.seconds * 1000;
        this.identifyName = this.opts.store.adoption?.controllerName ?? '';
        // Identify must be visible whatever is showing, including over a video stream, so
        // it takes the screen for its duration and then the content is restored.
        await this.display.show(this.statusTarget());
        setTimeout(() => void this.restoreContent(), frame.seconds * 1000);
        return;
      case 'reboot':
        this.log('rebooting on request');
        setTimeout(() => this.opts.platform.reboot(), 200);
        return;
      case 'factory_reset':
        this.log('factory reset on request');
        this.opts.store.clear();
        setTimeout(() => this.opts.platform.wipeData(), 200);
        return;
      case 'update':
        // M3. NAK explicitly rather than silently succeeding, so a controller that tries
        // it sees a clear reason in the panel instead of a node that never updates.
        return 'agent self-update is not implemented in this firmware';
      case 'set_content':
        this.content = frame.content;
        await this.applyContent();
        return;
    }
  }

  private async applyContent(): Promise<void> {
    const c = this.content;
    if (!c) return;
    if (c.type === 'timetable') {
      // Fetch the masjid's photo/logo BEFORE switching the screen, so a node shows the
      // finished design rather than the themed scene for a beat and then repainting. Any
      // asset that cannot be fetched is simply left out — never a reason to withhold the
      // timetable itself.
      await this.syncAssets(c.assets ?? []);
    }
    if (c.type === 'timetable' && !this.opts.platform.clockSynced()) {
      // The Pi has no RTC. Drawing prayer times from a 1970 clock would be worse than
      // saying so, so hold the timetable until NTP lands and re-check shortly.
      this.note = 'Synchronizing the clock…';
      this.client?.event('clock_unsynced', 'holding the timetable until NTP sets the clock');
      await this.display.show(this.statusTarget());
      setTimeout(() => void this.applyContent(), 5000);
      return;
    }
    this.note = '';
    await this.display.show(this.targetFor(c));
  }

  /**
   * Bring the asset cache in line with what this timetable needs.
   *
   * Built lazily and rebuilt if the adoption changes, because the cache needs the token and
   * the controller origin, neither of which exists before adoption.
   */
  private async syncAssets(refs: AssetRef[]): Promise<void> {
    const a = this.opts.store.adoption;
    if (!a) return;
    if (!this.cache) {
      this.cache = new AssetCache({
        dir: this.opts.assetDir,
        origin: originFromWsUrl(a.wsUrl),
        token: a.nodeToken,
        serial: this.opts.platform.serial(),
        log: (m) => this.log(m),
      });
    }
    if (refs.length === 0) {
      this.assets = new Map();
      this.cache.prune([]);
      return;
    }
    this.assets = await this.cache.ensure(refs);
    const missing = refs.filter((r) => !this.assets.has(r.id));
    if (missing.length) {
      this.client?.event('asset_fetch_failed', `could not fetch: ${missing.map((m) => m.id).join(', ')}`);
    }
    // Drop anything this timetable no longer references, so a masjid trying five wallpapers
    // does not slowly fill the card.
    this.cache.prune(this.assets.values());
  }

  /** Serve a cached asset to the kiosk (the local API routes /assets/<sha> here). */
  readAsset(sha: string): Buffer | null {
    return this.cache?.read(sha) ?? null;
  }

  /** Put back whatever content we were told to show (after an identify overlay). */
  private async restoreContent(): Promise<void> {
    const remaining = this.identifyUntil - this.now();
    if (remaining > 0) {
      // Either a newer identify extended the window, or this timer fired a hair early.
      // RESCHEDULE — do not just return. Returning drops the restore on the floor, and
      // since nothing else ever calls this, the screen would sit on the identify page
      // until the next content change. setTimeout is allowed to fire marginally early,
      // so that is a real stuck-screen bug on a node, not just a flaky test.
      setTimeout(() => void this.restoreContent(), remaining + 20);
      return;
    }
    this.identifyUntil = 0;
    if (this.content) await this.applyContent();
    else await this.display.show(this.statusTarget());
  }

  private targetFor(c: SetContent): Target {
    switch (c.type) {
      case 'timetable':
        return { mode: 'timetable', url: `${this.opts.kioskOrigin}/` };
      case 'stream':
        return { mode: 'stream', url: c.url, transport: c.transport };
      case 'off':
        return { mode: 'off' };
      case 'status_screen':
        return this.statusTarget();
    }
  }

  private statusTarget(): Target {
    return { mode: 'status_screen', url: `${this.opts.kioskOrigin}/` };
  }

  /** The mode reported in heartbeats. */
  get mode(): NodeMode {
    return this.display.mode;
  }

  /** What the kiosk page should draw right now. */
  view(): KioskView {
    const p = this.opts.platform;
    const identifying = this.now() < this.identifyUntil;
    if (this.content?.type === 'timetable' && !identifying && this.display.mode === 'timetable') {
      const assets: Record<string, string> = {};
      for (const [slot, sha] of this.assets) assets[slot] = `/assets/${sha}`;
      return { kind: 'timetable', doc: this.content.doc, clockSynced: p.clockSynced(), assets };
    }
    const a = this.opts.store.adoption;
    const view: KioskView = {
      kind: 'status',
      serial: p.serial(),
      model: p.model(),
      fw: this.opts.fw,
      ip: p.health().ip ?? '',
      adopted: this.opts.store.adopted,
      controllerName: a?.controllerName ?? '',
      linked: this.linked,
      note: this.note,
    };
    if (identifying) view.identify = { name: this.identifyName, untilMs: this.identifyUntil };
    return view;
  }

  /** Report a stream problem the platform noticed (used by index.ts wiring). */
  reportUnsupportedCodec(sourceId: string, codec: string): void {
    this.client?.event('unsupported_codec', `cannot hardware-decode ${codec}`, { sourceId, codec });
  }

  async stop(): Promise<void> {
    this.client?.stop();
    await this.display.stop();
  }
}
