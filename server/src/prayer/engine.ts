// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/*
 * prayer/engine.ts — prayer-time calculation engine.
 *
 * A TypeScript port of the OpenMasjidAPPS prayer-times-display engine (original
 * work by the same author; reused here under this app's AGPL-3.0 licence). It
 * implements the standard astronomical method: the sun's declination and the
 * equation of time (NOAA/USNO low-precision approximation, accurate to well
 * under a minute), then solves the hour-angle equation for each prayer's
 * defining sun altitude. No third-party code.
 *
 * All trig helpers operate in degrees. Times are returned as decimal hours on
 * the masjid's local civil clock (0..24).
 */
import type { CalcMethod, AsrMadhab, IqamahRule } from '../types';

// --- Degree-based trigonometry helpers -------------------------------------
const dtr = (d: number) => (d * Math.PI) / 180;
const rtd = (r: number) => (r * 180) / Math.PI;
const dsin = (d: number) => Math.sin(dtr(d));
const dcos = (d: number) => Math.cos(dtr(d));
const dtan = (d: number) => Math.tan(dtr(d));
const darcsin = (x: number) => rtd(Math.asin(x));
const darccos = (x: number) => rtd(Math.acos(x));
const darctan2 = (y: number, x: number) => rtd(Math.atan2(y, x));
const darccot = (x: number) => rtd(Math.atan2(1, x));
const fixAngle = (a: number) => ((a % 360) + 360) % 360;
const fixHour = (h: number) => ((h % 24) + 24) % 24;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export interface MethodDef {
  label: string;
  fajr: number;
  isha?: number;
  ishaMinutes?: number;
  maghrib?: number;
}

// 'Custom' has no fixed entry — its angles come from the timetable at render time.
export const METHODS: Record<Exclude<CalcMethod, 'Custom'>, MethodDef> = {
  MWL: { label: 'Muslim World League', fajr: 18, isha: 17 },
  ISNA: { label: 'Islamic Society of North America', fajr: 15, isha: 15 },
  Egypt: { label: 'Egyptian General Authority', fajr: 19.5, isha: 17.5 },
  Makkah: { label: 'Umm al-Qura, Makkah', fajr: 18.5, ishaMinutes: 90 },
  Karachi: { label: 'University of Islamic Sciences, Karachi', fajr: 18, isha: 18 },
};

export interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface PrayerTimes {
  fajr: number;
  sunrise: number;
  dhuhr: number;
  asr: number;
  maghrib: number;
  isha: number;
  sunset: number;
}

// Julian Day Number at 0h UT for a Gregorian calendar date.
function julian(year: number, month: number, day: number): number {
  if (month <= 2) {
    year -= 1;
    month += 12;
  }
  const a = Math.floor(year / 100);
  const b = 2 - a + Math.floor(a / 4);
  return (
    Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + b - 1524.5
  );
}

// Sun's apparent declination (deg) and equation of time (hours) for a Julian date.
function sunPosition(jd: number): { declination: number; equation: number } {
  const d = jd - 2451545.0; // days since the J2000.0 epoch
  const g = fixAngle(357.529 + 0.98560028 * d); // mean anomaly
  const q = fixAngle(280.459 + 0.98564736 * d); // mean longitude
  const L = fixAngle(q + 1.915 * dsin(g) + 0.02 * dsin(2 * g)); // ecliptic longitude
  const e = 23.439 - 0.00000036 * d; // obliquity of the ecliptic
  const ra = darctan2(dcos(e) * dsin(L), dcos(L)) / 15; // right ascension (hours)
  const declination = darcsin(dsin(e) * dsin(L));
  const equation = q / 15 - fixHour(ra); // equation of time (hours)
  return { declination, equation };
}

/**
 * Compute prayer times for a given civil date and location.
 * Each value is decimal hours on the local clock.
 */
export function prayerTimes(
  date: Pick<DateParts, 'year' | 'month' | 'day'>,
  lat: number,
  lng: number,
  tz: number,
  method: CalcMethod | MethodDef,
  asrMadhab: AsrMadhab,
): PrayerTimes {
  const m = typeof method === 'string' ? METHODS[method as Exclude<CalcMethod, 'Custom'>] ?? METHODS.MWL : method;
  const jd = julian(date.year, date.month, date.day);
  // Evaluate the sun at local apparent noon for best accuracy.
  const { declination: decl, equation: eqt } = sunPosition(jd + 0.5 - lng / 360);

  const dhuhr = fixHour(12 - eqt) - lng / 15 + tz;

  const depressionOffset = (angle: number): number => {
    const x = (-dsin(angle) - dsin(lat) * dsin(decl)) / (dcos(lat) * dcos(decl));
    return darccos(clamp(x, -1, 1)) / 15;
  };

  const asrOffset = (shadow: number): number => {
    const altitude = darccot(shadow + dtan(Math.abs(lat - decl)));
    const x = (dsin(altitude) - dsin(lat) * dsin(decl)) / (dcos(lat) * dcos(decl));
    return darccos(clamp(x, -1, 1)) / 15;
  };

  const sunrise = dhuhr - depressionOffset(0.833);
  const sunset = dhuhr + depressionOffset(0.833);
  const fajr = dhuhr - depressionOffset(m.fajr);
  const asr = dhuhr + asrOffset(asrMadhab === 'Hanafi' ? 2 : 1);
  const maghrib = m.maghrib != null ? dhuhr + depressionOffset(m.maghrib) : sunset;
  const isha =
    m.ishaMinutes != null ? maghrib + m.ishaMinutes / 60 : dhuhr + depressionOffset(m.isha ?? 17);

  return { fajr, sunrise, dhuhr, asr, maghrib, isha, sunset };
}

// UTC offset (hours) for a given instant in an IANA timezone — DST aware.
export function timezoneOffsetHours(instant: Date, timeZone?: string): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const p: Record<string, string> = {};
    for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return (asUTC - instant.getTime()) / 3600000;
  } catch {
    return -instant.getTimezoneOffset() / 60; // fall back to the host's zone
  }
}

// The masjid-local wall-clock parts for an instant in an IANA timezone.
export function localParts(instant: Date, timeZone?: string): DateParts {
  const opts: Intl.DateTimeFormatOptions = {
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  };
  if (timeZone) opts.timeZone = timeZone;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', opts);
  } catch {
    // An invalid IANA zone (e.g. a stale hand-typed value) would otherwise throw and
    // blank the whole display — fall back to the host zone instead.
    delete opts.timeZone;
    fmt = new Intl.DateTimeFormat('en-US', opts);
  }
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(instant)) {
    p[part.type] = part.value;
  }
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour,
    minute: +p.minute,
    second: +p.second,
  };
}

/** Day of week (0=Sun..6=Sat) for an instant in a timezone. */
export function dayOfWeek(instant: Date, timeZone?: string): number {
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short' };
  if (timeZone) opts.timeZone = timeZone;
  let wd: string;
  try {
    wd = new Intl.DateTimeFormat('en-US', opts).format(instant);
  } catch {
    // An invalid IANA zone (e.g. a stale hand-typed value) would otherwise throw and
    // crash the whole render — fall back to the host zone, like localParts does above.
    delete opts.timeZone;
    wd = new Intl.DateTimeFormat('en-US', opts).format(instant);
  }
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd.slice(0, 3));
}

/** An instant at ~noon local time on the given calendar date in `timeZone`. Anchoring at
 *  noon (rather than at 12:00 UTC) keeps localParts() on the INTENDED calendar date for
 *  every zone — including UTC+13/+14 (Auckland/Fiji/Kiritimati), where a 12:00-UTC instant
 *  rolls forward into the next day. Used to render/inspect a specific date's timetable. */
export function zonedNoon(year: number, month: number, day: number, timeZone?: string): Date {
  const utcNoon = Date.UTC(year, month - 1, day, 12);
  const offset = timezoneOffsetHours(new Date(utcNoon), timeZone); // hours east of UTC
  return new Date(utcNoon - offset * 3600000);
}

/** Parse "HH:MM" to decimal hours, or null if invalid. */
export function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = +m[1];
  const min = +m[2];
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h + min / 60;
}

/** Resolve an Iqamah time (decimal hours) from its rule and the Adhan time. */
export function iqamahHours(adhanHours: number, rule: IqamahRule): number | null {
  if (!rule || rule.mode === 'none') return null;
  if (rule.mode === 'fixed' && rule.fixed) return parseHHMM(rule.fixed);
  if (rule.mode === 'offset') return adhanHours + (rule.offset ?? 0) / 60;
  return null;
}
