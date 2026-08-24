// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * fabricTimetable.ts — the `timetable` capability: another OpenMasjid app reading our prayer
 * times through the platform's app-to-app broker.
 *
 * WHY THIS EXISTS. Display owns prayer-time correctness in this family of apps — the
 * calculation, the Iqamah rules, the CSV overrides, the scheduled changes, the masjid's zone
 * and its Hijri offset all live here and nowhere else. OpenMasjidCompanion (the musallis'
 * phone app) is forbidden by its own rules from calculating any of that itself, and its push
 * notifications fire from these times. So it has to be able to READ a timetable from us,
 * server-to-server, and this is the sanctioned way to do that.
 *
 * WHAT IT IS NOT. It is not the public widget. `/w/<id>.json` is gated on `widget.enabled`,
 * shaped for an iframe (12-hour strings, one focus day, a Mon–Sun week, a live countdown) and
 * open to the internet with CORS. None of that is right for a consuming app, and the widget's
 * opt-in is the wrong gate here: it governs whether the masjid publishes times on their own
 * WEBSITE, which has nothing to do with whether the admin has granted another app on their own
 * box the capability to read them. Conflating the two would either expose timetables the admin
 * never published, or hide ones they clearly meant to share.
 *
 * The contract is `v: 1` and every success body says so. Adding a field is additive and bumps
 * nothing; changing or removing one is a new `v`. `docs/USING_THE_FABRIC.md` §8 is the written
 * copy of it and must move with this file.
 *
 * Three properties worth knowing before changing anything here:
 *
 *  - **Read-only, and provably so.** Nothing in this module calls `store.update`, and a test
 *    asserts that by reading this file. A provider that can write is a provider that turns a
 *    leaked secret into an attacker repointing a masjid's prayer times.
 *  - **No clock.** The answer depends only on the timetable and the requested range, never on
 *    "now" — so it is deterministic, cacheable by the caller, and testable without faking time.
 *  - **The times are the wall clock a musalli would read off the screen**, which means every
 *    override is already applied (see `buildModel`) and the format is 24-hour on the wire
 *    regardless of how this timetable happens to be displayed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config';
import { makeLog } from './logger';
import { sendJson } from './httpio';
import type { Store } from './store';
import type { Lang, Timetable } from './types';
import { buildModel, hijri, labels } from './render/svg';
import { zonedNoon } from './prayer/engine';
import { checkBrokerEnvelope } from './fabricInbound';

const log = makeLog('fabric-timetable');

/** The capability name in `manifest.yaml`'s `fabric.provides`, and the path segment the broker
 *  maps onto us. The two are the same string by construction — see fabricInbound.ts. */
export const TIMETABLE_CAPABILITY = 'timetable';

/** The exact, UNPREFIXED paths. Never register the tunnel's `/<basePath>/…` form. */
export const TIMETABLE_LIST_PATH = `/fabric/${TIMETABLE_CAPABILITY}/list`;
export const TIMETABLE_GET_PATH = `/fabric/${TIMETABLE_CAPABILITY}/get`;

/** Wire contract version. Additive fields do not change it. */
export const TIMETABLE_CONTRACT_VERSION = 1;

/**
 * The hard cap on a `get`, enforced here rather than trusted from the body.
 *
 * 45 days is the agreed ceiling and it is comfortably inside the broker's 256 KB response limit:
 * the worst case a masjid can actually configure — the day cap, eight Jumu'ah jamā'āt, the
 * longest names the store allows and Arabic labels at three bytes a character — measures about
 * 18.5 KB. The test does not assert that figure, which would break on any harmless wording
 * change; it asserts the answer stays under **half** the ceiling, so the alarm goes off while
 * there is still a factor of seven in hand.
 *
 * The cap is really about CPU, though: each day is a fresh solar computation and a handful of
 * `Intl` formatters, and this process is also running the 1 fps loop that draws the actual
 * screens. Unbounded days here would be a way to make a television stutter.
 */
export const TIMETABLE_MAX_DAYS = 45;

/**
 * Request body cap. The body is three short fields; the platform caps its own at 4 KB. Held as
 * a constant because api.ts's call site is pinned to it by a test — an inline literal there
 * could drift away from the number this file documents.
 */
export const TIMETABLE_MAX_BODY_BYTES = 8_000;

/** One timetable, as `list` reports it: enough to name it and ask for it, nothing more. */
export interface FabricTimetableSummary {
  id: string;
  name: string;
}

export interface FabricTimetableList {
  v: number;
  timetables: FabricTimetableSummary[];
}

/** A prayer's two times. `null` where the masjid has not set an Iqamah (rule mode 'none'). */
export interface FabricPrayer {
  adhan: string | null;
  iqamah: string | null;
}

export type FabricPrayerKey = 'fajr' | 'dhuhr' | 'asr' | 'maghrib' | 'isha';

/**
 * One Jumu'ah jamā'ah.
 *
 * `adhan` is always null, and that is a fact about this app rather than an omission: a
 * timetable configures Jumu'ah as jamā'ah times only — there is no per-Jumu'ah Adhan field
 * anywhere in the model. On the screen the Friday countdown runs to the calculated DHUHR
 * adhan, relabelled "Jumu'ah", so a consumer that wants to show an adhan time for Jumu'ah
 * should read `prayers.dhuhr.adhan` for that day. Filling this in from Dhuhr would look like a
 * separately configured time and be wrong the moment anyone relies on it.
 */
export interface FabricJumuah {
  label: string;
  adhan: string | null;
  iqamah: string;
}

export interface FabricDay {
  /** "YYYY-MM-DD" in the masjid's own calendar and zone. */
  date: string;
  hijri: { label: string };
  /** Astronomical sunrise. Additive to the agreed contract, and free to compute — a masjid
   *  timetable that cannot show Shurūq looks incomplete. */
  sunrise: string | null;
  prayers: Record<FabricPrayerKey, FabricPrayer>;
  /** Empty on every day that is not a Friday in the masjid's timezone. */
  jumuah: FabricJumuah[];
}

export interface FabricTimetableFeed {
  v: number;
  id: string;
  name: string;
  masjidName: string;
  /** IANA, always a real zone — see `effectiveTimeZone`. */
  timezone: string;
  language: Lang;
  /** '12' | '24' — this timetable's own DISPLAY setting. Presentation only; the times on the
   *  wire are 24-hour whatever this says. */
  hourCycle: '12' | '24';
  days: FabricDay[];
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Decimal hours → "HH:mm", 24-hour, or null.
 *
 * FLOORS the minute, and that is not a detail: a wall clock must never show the next minute
 * early, so the screens floor, and a phone app showing a time a minute later than the board on
 * the wall is exactly the kind of discrepancy nobody can explain. `iqamahCsv.ts`'s look-alike
 * ROUNDS — do not reach for it, and do not add a third variant. `fabricTimetable.test.ts`
 * asserts this agrees with the renderer's own `fmtShort(h, '24h')` across the awkward values.
 *
 * The reason this is not simply `fmtShort(h, '24h')` is the empty case: that returns the em
 * dash it needs for a screen, and a JSON feed needs `null`.
 */
export function hhmm(hours: number | null | undefined): string | null {
  if (hours == null || !Number.isFinite(hours)) return null;
  let total = Math.floor(hours * 60);
  total = ((total % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/**
 * The zone the times were ACTUALLY computed in — which is not always `tt.timezone`.
 *
 * `tt.timezone` is `''` for "use whatever zone this box is in", and the prayer engine also
 * falls back to the host zone for a name Intl does not recognise. Reporting the stored string
 * would therefore hand a consumer a blank, or a zone the times are not in. It schedules push
 * notifications from this: being wrong here is silently an hour or more out, on every prayer,
 * for everyone who installed the app.
 */
export function effectiveTimeZone(tt: Timetable): string {
  const want = (tt.timezone || '').trim();
  if (want) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: want });
      return want;
    } catch {
      // Not a zone Intl knows. The engine silently uses the host zone, so we must say so too.
    }
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** "YYYY-MM-DD" → parts, rejecting anything that isn't a real calendar date (2026-02-30). */
export function parseFrom(s: unknown): { y: number; m: number; d: number } | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1970 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Round-trip through UTC so 2026-02-30 and 2026-04-31 are refused rather than rolled.
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() + 1 !== mo || probe.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

/** Does this timetable have somewhere to compute times FOR? `buildModel` asserts these are
 *  non-null and would otherwise quietly compute for latitude 0, longitude 0 — the Gulf of
 *  Guinea — and return times that look entirely plausible. */
export function hasLocation(tt: Timetable): boolean {
  return tt.latitude != null && tt.longitude != null;
}

/**
 * The whole payload for one timetable over a date range. Pure: no clock, no I/O, no writes.
 *
 * One `buildModel` per day, anchored with `zonedNoon` rather than UTC noon — a 12:00-UTC
 * instant lands on the following calendar date in UTC+13/+14, so an Auckland masjid would get
 * every day's times shifted by one. `startD + i` overflowing its month is fine; `Date.UTC`
 * normalises it, and each day's own `parts` is what the emitted date comes from, so the
 * arithmetic can never disagree with the times.
 */
export function buildFeed(tt: Timetable, from: { y: number; m: number; d: number }, days: number): FabricTimetableFeed {
  const tz = tt.timezone || undefined;
  const L = labels(tt.language, tt.labels);
  const out: FabricDay[] = [];
  for (let i = 0; i < days; i++) {
    const model = buildModel(tt, zonedNoon(from.y, from.m, from.d + i, tz));
    const p = model.parts;
    const row = (key: FabricPrayerKey): FabricPrayer => {
      const r = model.rows.find((x) => x.key === key);
      return { adhan: hhmm(r?.adhan), iqamah: hhmm(r?.iqamah) };
    };
    // Jumu'ah is carried on EVERY day of the model, because the screens show it as a standing
    // reference strip. Repeating that here would assert a jamā'ah on a Tuesday, so it is
    // emitted only on the day it happens — Friday in the MASJID's zone, which is what
    // `isFriday` means and is not always Friday in UTC.
    const jumuah: FabricJumuah[] = [];
    if (model.isFriday) {
      for (let n = 0; n < model.jumuah.length; n++) {
        const iqamah = hhmm(model.jumuah[n]);
        // Unreachable in practice — buildModel has already dropped anything unparseable — but
        // the numbering deliberately stays with the original index either way, so a consumer's
        // "Jumu'ah 2" is the masjid's second Jumu'ah and not merely the second one we emitted.
        if (iqamah === null) continue;
        const suffix = model.jumuah.length > 1 ? ` ${n + 1}` : '';
        jumuah.push({ label: (L.jumuah ?? "Jumu'ah") + suffix, adhan: null, iqamah });
      }
    }
    out.push({
      date: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
      hijri: { label: hijri(p, tt.language, tt.hijriOffset) },
      sunrise: hhmm(model.times.sunrise),
      prayers: { fajr: row('fajr'), dhuhr: row('dhuhr'), asr: row('asr'), maghrib: row('maghrib'), isha: row('isha') },
      jumuah,
    });
  }
  return {
    v: TIMETABLE_CONTRACT_VERSION,
    id: tt.id,
    name: tt.name,
    masjidName: tt.masjidName,
    timezone: effectiveTimeZone(tt),
    language: tt.language,
    hourCycle: tt.timeFormat === '24h' ? '24' : '12',
    days: out,
  };
}

/** Every timetable the admin has created — id and name only. Not gated on `widget.enabled`;
 *  see the header comment for why that gate belongs to the public website widget alone. */
export function listTimetables(store: Store): FabricTimetableList {
  return {
    v: TIMETABLE_CONTRACT_VERSION,
    timetables: store.db.timetables.map((t) => ({ id: t.id, name: t.name })),
  };
}

export type TimetableMethod = 'list' | 'get';

/**
 * The route. `method` is which of the two the dispatcher matched, so the exact path this
 * request had to arrive on is decided here and never derived from anything in the request.
 */
export function handleFabricTimetable(
  req: IncomingMessage,
  res: ServerResponse,
  method: TimetableMethod,
  body: Record<string, unknown>,
  store: Store,
): void {
  const exact = method === 'list' ? TIMETABLE_LIST_PATH : TIMETABLE_GET_PATH;
  const env = checkBrokerEnvelope(req, exact, config.omosAppSecret);
  if (!env.ok) {
    // Metadata only: who asked and which capability. Never the body, never the secret.
    log.warn(`refused a ${TIMETABLE_CAPABILITY}/${method} call from ${env.caller} (${env.error})`);
    return sendJson(res, env.status, { error: env.error });
  }

  if (method === 'list') return sendJson(res, 200, listTimetables(store));

  const id = typeof body.id === 'string' ? body.id : '';
  const from = parseFrom(body.from);
  const days = body.days;
  if (!id || !from) return sendJson(res, 400, { error: 'bad_request' });
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > TIMETABLE_MAX_DAYS) {
    return sendJson(res, 400, { error: 'bad_request' });
  }

  const tt = store.db.timetables.find((t) => t.id === id);
  if (!tt) return sendJson(res, 404, { error: 'unknown_timetable' });
  // The timetable exists but has no location, so there are no times to give — a state the
  // admin has to fix, not one that will pass. 409 rather than 503: retrying changes nothing,
  // and a consumer that only knows "not 200" still falls back correctly.
  if (!hasLocation(tt)) return sendJson(res, 409, { error: 'no_location' });

  return sendJson(res, 200, buildFeed(tt, from, days));
}
