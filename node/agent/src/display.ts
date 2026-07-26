// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * display.ts — what is on the HDMI output, and only ever one thing at a time.
 *
 * THE MEMORY CONSTRAINT IS THE DESIGN. A Pi Zero 2 W has 512 MB. The kiosk browser is
 * ~250 MB and the GStreamer pipeline ~120 MB, so running both would swap and stutter, and
 * on a read-only rootfs with zram that means a frozen screen in a prayer hall. So
 * `show()` always stops the current process before starting the next, and there is exactly
 * one slot.
 *
 * Crash handling is here too: a kiosk or player that dies is restarted with backoff, and
 * after repeated failures the node falls back to the status screen (which states the
 * error) rather than leaving a black TV with no explanation.
 */
import { makeBackoff, type Backoff } from './backoff';
import type { Platform, Proc } from './platform';
import type { NodeMode } from '../../../packages/protocol/src/index';

/** What the display should be showing. */
export type Target =
  | { mode: 'timetable'; url: string }
  | { mode: 'status_screen'; url: string }
  | { mode: 'stream'; url: string; transport: 'tcp' | 'udp' }
  | { mode: 'off' };

/** How many consecutive crashes before we stop retrying and show the status screen. */
export const MAX_RESTARTS = 5;

export interface DisplayEvents {
  /** A supervised process crashed and is being restarted. */
  onRestart(mode: NodeMode, attempt: number): void;
  /** It kept crashing; we have given up and fallen back to the status screen. */
  onGaveUp(mode: NodeMode, detail: string): void;
}

export class Display {
  private current: Target = { mode: 'off' };
  private proc: Proc | null = null;
  private restarts = 0;
  private backoff: Backoff = makeBackoff();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly platform: Platform,
    private readonly events: DisplayEvents,
    /** injectable so tests do not wait real seconds */
    private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout = setTimeout,
  ) {}

  /** Is a restart currently pending? (A crashed process waiting out its backoff.) */
  get restarting(): boolean {
    return this.timer !== null;
  }

  get mode(): NodeMode {
    return this.current.mode;
  }

  /** Is the underlying process alive? (false for 'off', which has no process.) */
  get running(): boolean {
    return !!this.proc?.running;
  }

  /**
   * Switch to `target`. A no-op when it is already showing exactly that, so the
   * controller's every-15s reconcile does not relaunch the browser four times a minute.
   */
  async show(target: Target): Promise<void> {
    if (sameTarget(this.current, target)) return;
    this.current = target;
    this.restarts = 0;
    this.backoff.reset();
    await this.launch();
  }

  private async launch(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.stopProc();
    if (this.stopped) return;
    const target = this.current;
    if (target.mode === 'off') {
      this.platform.blank();
      return;
    }
    const proc =
      target.mode === 'stream'
        ? this.platform.startPlayer(target.url, target.transport)
        : this.platform.startKiosk(target.url);
    this.proc = proc;
    proc.onExit((info) => this.onCrash(info));
  }

  private onCrash(info: { code: number | null; signal: string | null }): void {
    // A clean exit we asked for is handled in stopProc(); anything reaching here is the
    // process going away on its own while it was meant to be showing something.
    if (this.stopped || this.proc?.running) return;
    if (this.current.mode === 'off') return;
    this.restarts += 1;
    const detail = `exited with ${info.signal ? `signal ${info.signal}` : `code ${info.code ?? '?'}`}`;
    if (this.restarts > MAX_RESTARTS) {
      this.events.onGaveUp(this.current.mode, detail);
      return;
    }
    this.events.onRestart(this.current.mode, this.restarts);
    this.timer = this.setTimer(() => void this.launch(), this.backoff.next());
  }

  private async stopProc(): Promise<void> {
    const p = this.proc;
    this.proc = null;
    if (p) await p.stop();
  }

  /** Shut down for good (agent exiting). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.stopProc();
  }
}

/** Are these the same thing on screen? Compared field-wise, not by identity. */
export function sameTarget(a: Target, b: Target): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === 'off' || b.mode === 'off') return true;
  if (a.mode === 'stream' && b.mode === 'stream') return a.url === b.url && a.transport === b.transport;
  return 'url' in a && 'url' in b && a.url === b.url;
}
