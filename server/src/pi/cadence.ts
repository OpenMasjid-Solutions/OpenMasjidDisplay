// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * pi/cadence.ts — how often the Pi can afford to redraw.
 *
 * The display is designed around one frame a second. That is not decoration: the clock's colons
 * blink on the second, and the Iqāmah countdown in the minutes before each prayer counts down in
 * mm:ss. Both look broken at any slower rate, and the whole point of this screen is that it looks
 * like the rest of the family.
 *
 * A Raspberry Pi 3 B+ cannot necessarily do it. Rasterising a 1080p timetable was measured at
 * about 110 ms on a modern desktop, and a 1.4 GHz Cortex-A53 is the better part of an order of
 * magnitude slower — so one frame a second could mean the better part of a whole core, forever,
 * on a board that also has to decode a camera. But a Pi 4 or 5 manages it easily, and a 720p
 * timetable costs roughly half of a 1080p one.
 *
 * So the rate is not a constant anybody guesses. **The agent times its own drawing and picks a
 * rate it can sustain**, which is right on hardware nobody has tested and stays right when the
 * timetable's quality setting changes underneath it. The thing being held constant is not the
 * frame rate but the *share of the machine* drawing is allowed to take — because what actually
 * matters is that the Pi has enough left over to play a camera and answer the network.
 *
 * All of it is arithmetic over measurements, so it is tested as arithmetic.
 */

/** The design cadence: one frame a second, and never faster — there is nothing to gain. */
export const TARGET_INTERVAL_MS = 1000;

/**
 * The most of one core drawing may take.
 *
 * Not a tuning knob so much as a statement of what the device is for. At 45% the Pi stays
 * responsive, has headroom for ffmpeg to decode a camera alongside, and does not sit at a
 * temperature that throttles it — a throttled Pi draws *slower*, which would otherwise feed back
 * on itself.
 */
export const MAX_DUTY = 0.45;

/** Beyond this, redrawing less often stops helping and the screen just looks frozen. A clock
 *  that updates every ten seconds is wrong-looking but still tells the time. */
export const MAX_INTERVAL_MS = 10_000;

/**
 * The interval to redraw at, given how long drawing actually takes.
 *
 * Rounded to a quarter second so the interval does not jitter with every sample, which would
 * make the colon blink irregular in a way that reads as a fault.
 */
export function intervalForRenderMs(renderMs: number): number {
  if (!Number.isFinite(renderMs) || renderMs <= 0) return TARGET_INTERVAL_MS;
  const sustainable = renderMs / MAX_DUTY;
  const rounded = Math.ceil(sustainable / 250) * 250;
  return Math.min(MAX_INTERVAL_MS, Math.max(TARGET_INTERVAL_MS, rounded));
}

/**
 * Track how long drawing takes, and turn that into a rate.
 *
 * The median of recent frames rather than the last one or the average: a single slow frame is
 * usually garbage collection or the SD card, and letting one of those halve the frame rate for
 * good would be a permanent penalty for a momentary hiccup. The median ignores it; a genuinely
 * slower device moves the median and the rate follows.
 */
export class RenderCadence {
  private samples: number[] = [];
  private readonly window: number;

  constructor(window = 9) {
    this.window = window;
  }

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.samples.push(ms);
    if (this.samples.length > this.window) this.samples.shift();
  }

  /** The typical frame cost so far, or 0 before anything has been drawn. */
  medianMs(): number {
    if (!this.samples.length) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  intervalMs(): number {
    return intervalForRenderMs(this.medianMs());
  }

  /** True once there is enough evidence to say anything — one frame is not a measurement. */
  settled(): boolean {
    return this.samples.length >= 3;
  }
}

/**
 * What to tell a human about the rate, or null when it is what it should be.
 *
 * Worth surfacing rather than hiding: a screen quietly updating every three seconds looks
 * *broken* to whoever walks past it, and the fix — set that timetable to 720p — is one click in
 * a place they would never think to look.
 */
export function cadenceAdvice(intervalMs: number, quality: string): string | null {
  if (intervalMs <= TARGET_INTERVAL_MS) return null;
  const secs = (intervalMs / 1000).toFixed(intervalMs % 1000 ? 2 : 0).replace(/\.?0+$/, '');
  const fix =
    quality === '1080p'
      ? ' Setting this timetable to 720p would roughly halve the work.'
      : ' This screen may be too slow for a live clock.';
  return `Drawing takes long enough that this screen updates every ${secs}s rather than every second.${fix}`;
}
