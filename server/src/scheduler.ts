// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * scheduler.ts — decides what each screen should be showing right now.
 *
 * Precedence (highest first):
 *   1. a volunteer's manual override (until it expires or is cleared)
 *   2. the highest-priority schedule rule whose weekly window is open
 *   3. the screen's default content
 *
 * Times are evaluated in the masjid's configured timezone. Windows may wrap past
 * midnight (end <= start); a wrapping window belongs to its start day.
 */
import { dayOfWeek, localParts, parseHHMM } from './prayer/engine';
import type { Tv, ScheduleRule, ContentRef } from './types';

export interface Resolution {
  content: ContentRef;
  source: 'override' | 'schedule' | 'default';
  ruleId?: string;
}

function toMinutes(hhmm: string): number | null {
  const h = parseHHMM(hhmm);
  return h == null ? null : Math.round(h * 60);
}

export function ruleActive(rule: ScheduleRule, dow: number, mins: number): boolean {
  if (!rule.enabled) return false;
  const s = toMinutes(rule.start);
  const e = toMinutes(rule.end);
  if (s == null || e == null) return false;
  if (s === e) return false; // empty window
  if (s < e) {
    return rule.days.includes(dow) && mins >= s && mins < e;
  }
  // Wraps past midnight: active late on a listed day, or early on the next day.
  const prev = (dow + 6) % 7;
  return (rule.days.includes(dow) && mins >= s) || (rule.days.includes(prev) && mins < e);
}

export function resolveTv(
  tv: Tv,
  rules: ScheduleRule[],
  now: Date,
  timezone: string,
): Resolution {
  const ov = tv.override;
  if (ov && ov.content && (ov.until == null || ov.until > now.getTime())) {
    return { content: ov.content, source: 'override' };
  }

  const tz = timezone || undefined;
  const parts = localParts(now, tz);
  const dow = dayOfWeek(now, tz);
  const mins = parts.hour * 60 + parts.minute;

  let best: ScheduleRule | null = null;
  for (const r of rules) {
    if (!(r.targets.includes('*') || r.targets.includes(tv.id))) continue;
    if (!ruleActive(r, dow, mins)) continue;
    if (!best || r.priority > best.priority) best = r;
  }
  if (best) return { content: best.content, source: 'schedule', ruleId: best.id };

  return { content: tv.defaultContent, source: 'default' };
}
