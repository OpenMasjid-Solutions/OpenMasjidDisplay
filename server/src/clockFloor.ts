// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Is this machine's clock plausible?
 *
 * A Raspberry Pi has no battery-backed clock, so after a power cut its idea of the time is
 * whenever the card was last written — and prayer times computed against that are confidently,
 * silently wrong, which is the one failure a prayer screen must never have. The floor is the
 * build's own date: a clock reading earlier than the software that is running cannot be right.
 *
 * Lifted out of `render/renderer.ts` so a standalone screen can ask the same question. That file
 * reaches ffmpeg and the encoder, and a device that only draws has no business importing either.
 */
export const CLOCK_FLOOR_MS = Date.parse('2026-08-13T00:00:00Z');

export function clockSuspect(now = Date.now()): boolean {
  return now < CLOCK_FLOOR_MS;
}
