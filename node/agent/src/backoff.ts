// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Reconnect backoff for the controller dial loop.
 *
 * Two properties matter, and both are about a masjid rather than a server:
 *
 *  • IT NEVER GIVES UP. A node whose controller is down for a week must still reconnect
 *    when it comes back, unattended. So the delay is capped, not escalated to failure.
 *  • IT IS JITTERED. Every screen in a building loses its controller at the same instant
 *    (a container update, a switch reboot), so without jitter twenty nodes would retry in
 *    lockstep and hammer the controller exactly as it is trying to start.
 */

/** Delay bounds. First retry is quick — most outages are a container restart. */
export const MIN_DELAY_MS = 1_000;
export const MAX_DELAY_MS = 60_000;

export interface Backoff {
  /** ms to wait before the next attempt, then advance. */
  next(): number;
  /** Call after a connection that actually worked, to return to fast retries. */
  reset(): void;
  readonly attempts: number;
}

/**
 * Exponential with full jitter: delay = random(MIN, min(MAX, MIN * 2^n)).
 *
 * Full jitter rather than the ±10% kind because the point is to SPREAD a fleet that
 * failed simultaneously, and a narrow band around a shared value barely does that.
 *
 * `rand` is injectable so the tests are deterministic — the agent passes Math.random.
 */
export function makeBackoff(rand: () => number = Math.random): Backoff {
  let attempts = 0;
  return {
    get attempts() {
      return attempts;
    },
    next(): number {
      const ceiling = Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** attempts);
      attempts += 1;
      return Math.round(MIN_DELAY_MS + rand() * (ceiling - MIN_DELAY_MS));
    },
    reset(): void {
      attempts = 0;
    },
  };
}
