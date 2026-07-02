// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Normalizers that turn untrusted request bodies into safe, fully-formed
 *  domain objects. Every field is clamped/defaulted; ids and createdAt are
 *  preserved on update or generated on create. */
import { rid, defaultIqamah } from './store';
import { THEMES } from './render/theme';
import { parseHHMM } from './prayer/engine';
import type {
  Timetable,
  Source,
  Tv,
  ScheduleRule,
  Settings,
  ContentRef,
  IqamahRule,
  IqamahConfig,
  CalcMethod,
  AsrMadhab,
  TimeFormat,
  Lang,
  Quality,
  Orientation,
  Announcements,
  Ticker,
  SalahHadith,
  HadithItem,
  ProhibitedNotice,
  IqamahCountdown,
  AdhanOffsets,
  AdhanPopup,
  TimetableWidget,
} from './types';

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});

function str(v: unknown, def = '', max = 2000): string {
  if (v == null) return def;
  return String(v).slice(0, max);
}
function oneOf<T extends string>(v: unknown, list: readonly T[], def: T): T {
  return (list as readonly string[]).includes(String(v)) ? (v as T) : def;
}
function bool(v: unknown, def = false): boolean {
  return typeof v === 'boolean' ? v : def;
}
function intIn(v: unknown, def: number, min: number, max: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
/** A clamped float (allows decimals, e.g. a 17.5° angle). */
function numIn(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function numOrNull(v: unknown): number | null {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
/** A coordinate within range, or null (so the display shows "Setup needed"
 *  rather than nonsensical times for an out-of-range typo). */
function geoOrNull(v: unknown, lo: number, hi: number): number | null {
  const n = numOrNull(v);
  return n == null || n < lo || n > hi ? null : n;
}
function hhmmOrNull(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return parseHHMM(s) != null ? s : null;
}

const THEME_IDS = THEMES.map((t) => t.id);
const METHODS_LIST: CalcMethod[] = ['MWL', 'ISNA', 'Egypt', 'Makkah', 'Karachi', 'Custom'];

export function normContent(v: unknown): ContentRef {
  const o = asObj(v);
  const kind = oneOf(o.kind, ['timetable', 'source', 'off'] as const, 'off');
  if (kind === 'off') return { kind: 'off' };
  const id = str(o.id, '', 80);
  return id ? { kind, id } : { kind: 'off' };
}

function normIqamahRule(v: unknown): IqamahRule {
  const o = asObj(v);
  const mode = oneOf(o.mode, ['offset', 'fixed', 'none'] as const, 'offset');
  if (mode === 'fixed') return { mode, fixed: hhmmOrNull(o.fixed) ?? '00:00' };
  if (mode === 'none') return { mode };
  return { mode: 'offset', offset: intIn(o.offset, 10, 0, 240) };
}

/** Sanitise custom label overrides: known-ish keys, short non-empty strings. */
function normLabels(v: unknown, base?: Record<string, string>): Record<string, string> | undefined {
  if (v === undefined) return base;
  const o = asObj(v);
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, val] of Object.entries(o)) {
    if (n >= 24) break;
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,23}$/.test(k)) continue;
    const s = String(val ?? '').slice(0, 40).trim();
    if (s) {
      out[k] = s;
      n++;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function normIqamah(v: unknown): IqamahConfig {
  const o = asObj(v);
  const d = defaultIqamah();
  return {
    fajr: o.fajr ? normIqamahRule(o.fajr) : d.fajr,
    dhuhr: o.dhuhr ? normIqamahRule(o.dhuhr) : d.dhuhr,
    asr: o.asr ? normIqamahRule(o.asr) : d.asr,
    maghrib: o.maghrib ? normIqamahRule(o.maghrib) : d.maghrib,
    isha: o.isha ? normIqamahRule(o.isha) : d.isha,
  };
}

/** Announcement slideshow timing/window — images are NEVER trusted from the form
 *  (they're managed by the announcements upload/delete endpoints). */
function normAnnouncements(v: unknown, base?: Announcements): Announcements | undefined {
  if (v === undefined) return base;
  const o = asObj(v);
  return {
    enabled: bool(o.enabled, base?.enabled ?? false),
    images: base?.images ?? [],
    start: hhmmOrNull(o.start) ?? '',
    end: hhmmOrNull(o.end) ?? '',
    everySeconds: intIn(o.everySeconds, base?.everySeconds ?? 60, 5, 3600),
    forSeconds: intIn(o.forSeconds, base?.forSeconds ?? 20, 3, 1800),
    imageSeconds: intIn(o.imageSeconds, base?.imageSeconds ?? 8, 2, 600),
  };
}

function normSalahHadith(v: unknown, base?: SalahHadith): SalahHadith | undefined {
  if (v === undefined) return base;
  const o = asObj(v);
  const arr = Array.isArray(o.items) ? o.items : [];
  const items = arr
    .slice(0, 50)
    .map((x): HadithItem => {
      // Legacy items were plain strings (English only) — keep them working.
      if (typeof x === 'string') return { ar: '', en: str(x, '', 800) };
      const io = asObj(x);
      return { ar: str(io.ar, '', 800), en: str(io.en, '', 800) };
    })
    .filter((h) => h.ar.trim() !== '' || h.en.trim() !== '');
  return {
    enabled: bool(o.enabled, base?.enabled ?? false),
    minutes: intIn(o.minutes, base?.minutes ?? 10, 1, 60),
    items,
  };
}
function normProhibited(v: unknown, base?: ProhibitedNotice): ProhibitedNotice | undefined {
  if (v === undefined) return base;
  const o = asObj(v);
  return {
    enabled: bool(o.enabled, base?.enabled ?? false),
    minutes: intIn(o.minutes, base?.minutes ?? 10, 1, 45),
    ticker: o.ticker === undefined ? base?.ticker ?? false : bool(o.ticker, false),
  };
}
function normIqamahCountdown(v: unknown, base?: IqamahCountdown): IqamahCountdown | undefined {
  if (v === undefined) return base;
  const o = asObj(v);
  return {
    enabled: bool(o.enabled, base?.enabled ?? false),
    minutes: intIn(o.minutes, base?.minutes ?? 5, 1, 30),
  };
}

const ADHAN_KEYS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const;
/** Per-prayer Adhan delay in minutes (0–60). Zeros are omitted to keep the object small. */
function normAdhanOffsets(v: unknown, base?: AdhanOffsets): AdhanOffsets | undefined {
  if (v === undefined) return base;
  const o = asObj(v);
  const out: AdhanOffsets = {};
  for (const k of ADHAN_KEYS) {
    const cur = o[k] !== undefined ? intIn(o[k], base?.[k] ?? 0, 0, 60) : base?.[k] ?? 0;
    if (cur) out[k] = cur;
  }
  return out;
}

function normAdhanPopup(v: unknown, base?: AdhanPopup): AdhanPopup | undefined {
  if (v === undefined) return base;
  const o = asObj(v);
  return {
    enabled: bool(o.enabled, base?.enabled ?? false),
    seconds: intIn(o.seconds, base?.seconds ?? 15, 3, 120),
  };
}
function normWidget(v: unknown, base?: TimetableWidget): TimetableWidget | undefined {
  if (v === undefined) return base;
  const o = asObj(v);
  return { enabled: bool(o.enabled, base?.enabled ?? false) };
}
function normTicker(v: unknown, base?: Ticker): Ticker | undefined {
  if (v === undefined) return base;
  const o = asObj(v);
  const arr = Array.isArray(o.messages) ? o.messages : [];
  const messages = arr
    .slice(0, 20)
    .map((mm) => {
      const mo = asObj(mm);
      return {
        id: str(mo.id, rid('msg'), 40) || rid('msg'),
        text: str(mo.text, '', 200),
        start: hhmmOrNull(mo.start) ?? '',
        end: hhmmOrNull(mo.end) ?? '',
      };
    })
    .filter((mm) => mm.text.trim() !== '');
  return { enabled: bool(o.enabled, base?.enabled ?? false), messages };
}

export function normTimetable(input: unknown, base?: Timetable): Timetable {
  const o = asObj(input);
  const accentRaw = str(o.accent, '', 7).trim();
  const accent = /^#?[0-9a-fA-F]{6}$/.test(accentRaw)
    ? accentRaw.startsWith('#') ? accentRaw : `#${accentRaw}`
    : undefined;
  // Text colour: '' = auto-contrast; otherwise a normalized #rrggbb. Falls back to base.
  const tcRaw = (o.textColor === undefined ? base?.textColor ?? '' : str(o.textColor, '', 7)).trim();
  const textColor = /^#?[0-9a-fA-F]{6}$/.test(tcRaw)
    ? (tcRaw.startsWith('#') ? tcRaw : `#${tcRaw}`).toLowerCase()
    : '';
  const jumuahIn = Array.isArray(o.jumuah) ? o.jumuah : base?.jumuah ?? ['13:30'];
  const jumuah = jumuahIn.slice(0, 8).map((x) => hhmmOrNull(x)).filter((x): x is string => x != null);
  return {
    id: base?.id ?? rid('tt'),
    name: str(o.name, base?.name ?? 'Timetable', 80) || 'Timetable',
    themeId: oneOf(o.themeId, THEME_IDS, base?.themeId ?? 'emerald'),
    accent,
    textColor,
    orientation: oneOf(o.orientation, ['landscape', 'portrait'] as const, base?.orientation ?? 'landscape') as Orientation,
    // Coerce the fallback too, so a timetable saved at the now-removed 4K downgrades to 1080p.
    quality: oneOf(o.quality, ['720p', '1080p'] as const, oneOf(base?.quality, ['720p', '1080p'] as const, '1080p')) as Quality,
    layout: oneOf(o.layout, ['centered', 'clockTop', 'split'] as const, base?.layout ?? 'centered'),
    layoutCarousel: o.layoutCarousel === undefined ? base?.layoutCarousel ?? false : bool(o.layoutCarousel, false),
    masjidName: str(o.masjidName, base?.masjidName ?? 'Our Masjid', 80) || 'Our Masjid',
    location: str(o.location, base?.location ?? '', 80),
    latitude: o.latitude === undefined ? base?.latitude ?? null : geoOrNull(o.latitude, -90, 90),
    longitude: o.longitude === undefined ? base?.longitude ?? null : geoOrNull(o.longitude, -180, 180),
    method: oneOf(o.method, METHODS_LIST, base?.method ?? 'MWL'),
    fajrAngle: o.fajrAngle === undefined ? base?.fajrAngle ?? 18 : numIn(o.fajrAngle, 18, 0, 30),
    ishaAngle: o.ishaAngle === undefined ? base?.ishaAngle ?? 17 : numIn(o.ishaAngle, 17, 0, 30),
    asrMadhab: oneOf(o.asrMadhab, ['Standard', 'Hanafi'] as const, base?.asrMadhab ?? 'Hanafi') as AsrMadhab,
    timezone: str(o.timezone, base?.timezone ?? '', 64).trim(),
    timeFormat: oneOf(o.timeFormat, ['12h', '24h'] as const, base?.timeFormat ?? '12h') as TimeFormat,
    language: oneOf(o.language, ['en', 'ar', 'ur'] as const, base?.language ?? 'en') as Lang,
    hijriOffset: o.hijriOffset === undefined ? base?.hijriOffset ?? 0 : intIn(o.hijriOffset, 0, -3, 3),
    gregorianOffset: o.gregorianOffset === undefined ? base?.gregorianOffset ?? 0 : intIn(o.gregorianOffset, 0, -3, 3),
    iqamah: o.iqamah ? normIqamah(o.iqamah) : base?.iqamah ?? defaultIqamah(),
    // iqamahYear (CSV import) is managed only by the iqamah-csv endpoints.
    iqamahYear: base?.iqamahYear,
    jumuah: jumuah.length ? jumuah : ['13:30'],
    showSunrise: o.showSunrise === undefined ? base?.showSunrise ?? true : bool(o.showSunrise, true),
    showCountdown: o.showCountdown === undefined ? base?.showCountdown ?? true : bool(o.showCountdown, true),
    showDates: o.showDates === undefined ? base?.showDates ?? true : bool(o.showDates, true),
    showLogo: o.showLogo === undefined ? base?.showLogo ?? true : bool(o.showLogo, true),
    showSeconds: o.showSeconds === undefined ? base?.showSeconds ?? false : bool(o.showSeconds, false),
    showFooter: o.showFooter === undefined ? base?.showFooter ?? true : bool(o.showFooter, true),
    showCelestial: o.showCelestial === undefined ? base?.showCelestial ?? true : bool(o.showCelestial, true),
    bitrate720: o.bitrate720 === undefined ? base?.bitrate720 : intIn(o.bitrate720, base?.bitrate720 ?? 4000, 500, 20000),
    bitrate1080: o.bitrate1080 === undefined ? base?.bitrate1080 : intIn(o.bitrate1080, base?.bitrate1080 ?? 8000, 500, 30000),
    showName: o.showName === undefined ? base?.showName ?? true : bool(o.showName, true),
    // backgroundImage + logoImage are managed only by the upload/delete endpoints, never trusted from the form body.
    backgroundImage: base?.backgroundImage ?? '',
    logoImage: base?.logoImage ?? '',
    labels: normLabels(o.labels, base?.labels),
    announcements: normAnnouncements(o.announcements, base?.announcements),
    ticker: normTicker(o.ticker, base?.ticker),
    tickerSpeed: o.tickerSpeed === undefined ? base?.tickerSpeed ?? 5 : intIn(o.tickerSpeed, 5, 1, 10),
    salahHadith: normSalahHadith(o.salahHadith, base?.salahHadith),
    prohibitedNotice: normProhibited(o.prohibitedNotice, base?.prohibitedNotice),
    iqamahCountdown: normIqamahCountdown(o.iqamahCountdown, base?.iqamahCountdown),
    adhanOffsets: normAdhanOffsets(o.adhanOffsets, base?.adhanOffsets),
    adhanPopup: normAdhanPopup(o.adhanPopup, base?.adhanPopup),
    widget: normWidget(o.widget, base?.widget),
    footerNote: str(o.footerNote, base?.footerNote ?? '', 160),
    createdAt: base?.createdAt ?? new Date().toISOString(),
  };
}

/** Only stream protocols are allowed for a source URL — blocks ffmpeg/MediaMTX
 *  abuse like file:// (read local files onto a screen) or http:// SSRF. */
const ALLOWED_SOURCE_SCHEMES = ['rtsp:', 'rtsps:', 'rtmp:', 'rtmps:'];
function safeSourceUrl(raw: string): string {
  const u = raw.trim();
  if (!u) return '';
  try {
    return ALLOWED_SOURCE_SCHEMES.includes(new URL(u).protocol) ? u : '';
  } catch {
    return '';
  }
}

export function normSource(input: unknown, base?: Source): Source {
  const o = asObj(input);
  const url = safeSourceUrl(str(o.url, base?.url ?? '', 1000));
  return {
    id: base?.id ?? rid('src'),
    name: str(o.name, base?.name ?? 'Source', 80) || 'Source',
    type: oneOf(o.type, ['camera', 'hdmi'] as const, base?.type ?? 'camera'),
    url,
    mode: oneOf(o.mode, ['direct', 'normalize'] as const, base?.mode ?? 'direct'),
    quality: oneOf(o.quality, ['720p', '1080p'] as const, oneOf(base?.quality, ['720p', '1080p'] as const, '1080p')) as Quality,
    enabled: o.enabled === undefined ? base?.enabled ?? true : bool(o.enabled, true),
    createdAt: base?.createdAt ?? new Date().toISOString(),
  };
}

export function normTv(input: unknown, base?: Tv): Tv {
  const o = asObj(input);
  return {
    id: base?.id ?? rid('tv'),
    name: str(o.name, base?.name ?? 'Screen', 80) || 'Screen',
    room: str(o.room, base?.room ?? '', 80),
    defaultContent: o.defaultContent ? normContent(o.defaultContent) : base?.defaultContent ?? { kind: 'off' },
    override: base?.override ?? null,
    createdAt: base?.createdAt ?? new Date().toISOString(),
  };
}

export function normSchedule(input: unknown, base?: ScheduleRule): ScheduleRule {
  const o = asObj(input);
  const targetsIn = Array.isArray(o.targets) ? o.targets : base?.targets ?? ['*'];
  const targets = targetsIn.slice(0, 200).map((x) => str(x, '', 80)).filter(Boolean);
  const daysIn = Array.isArray(o.days) ? o.days : base?.days ?? [];
  const days = [...new Set(daysIn.map((d) => intIn(d, -1, 0, 6)).filter((d) => d >= 0))];
  return {
    id: base?.id ?? rid('rule'),
    name: str(o.name, base?.name ?? 'Schedule', 80) || 'Schedule',
    enabled: o.enabled === undefined ? base?.enabled ?? true : bool(o.enabled, true),
    targets: targets.length ? targets : ['*'],
    content: o.content ? normContent(o.content) : base?.content ?? { kind: 'off' },
    days,
    start: hhmmOrNull(o.start) ?? base?.start ?? '13:00',
    end: hhmmOrNull(o.end) ?? base?.end ?? '14:00',
    priority: intIn(o.priority, base?.priority ?? 0, 0, 100),
    createdAt: base?.createdAt ?? new Date().toISOString(),
  };
}

export function normSettings(input: unknown, base: Settings): Settings {
  const o = asObj(input);
  return {
    defaultQuality: oneOf(o.defaultQuality, ['720p', '1080p'] as const, oneOf(base.defaultQuality, ['720p', '1080p'] as const, '1080p')) as Quality,
    scheduleTimezone: str(o.scheduleTimezone, base.scheduleTimezone, 64).trim(),
    volunteerEnabled: o.volunteerEnabled === undefined ? base.volunteerEnabled ?? false : bool(o.volunteerEnabled, false),
  };
}
