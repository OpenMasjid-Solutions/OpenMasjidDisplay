// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Durable JSON store for all app state, kept in the data volume. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config';
import { makeLog } from './logger';
import type {
  DB,
  Timetable,
  CalcMethod,
  AsrMadhab,
  TimeFormat,
  Lang,
  Quality,
  IqamahConfig,
} from './types';

const log = makeLog('store');
const DB_VERSION = 1;

const VALID_METHODS: CalcMethod[] = ['MWL', 'ISNA', 'Egypt', 'Makkah', 'Karachi', 'Custom'];

function pick<T extends string>(value: string, allowed: T[], fallback: T): T {
  return (allowed as string[]).includes(value) ? (value as T) : fallback;
}

/** Short, URL-safe id with a kind prefix, e.g. "tv_a1b2c3". */
export function rid(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

export function defaultIqamah(): IqamahConfig {
  return {
    fajr: { mode: 'offset', offset: 20 },
    dhuhr: { mode: 'offset', offset: 10 },
    asr: { mode: 'offset', offset: 10 },
    maghrib: { mode: 'offset', offset: 5 },
    isha: { mode: 'offset', offset: 10 },
  };
}

function seededTimetable(): Timetable {
  const s = config.seed;
  const lat = Number.parseFloat(s.latitude);
  const lng = Number.parseFloat(s.longitude);
  return {
    id: rid('tt'),
    name: 'Main timetable',
    themeId: 'emerald',
    orientation: 'landscape',
    quality: s.quality,
    layout: 'centered',
    layoutCarousel: false,
    masjidName: s.masjidName || 'Our Masjid',
    location: '',
    latitude: Number.isFinite(lat) && Math.abs(lat) <= 90 ? lat : null,
    longitude: Number.isFinite(lng) && Math.abs(lng) <= 180 ? lng : null,
    method: pick<CalcMethod>(s.method, VALID_METHODS, 'MWL'),
    fajrAngle: 18,
    ishaAngle: 17,
    asrMadhab: pick<AsrMadhab>(s.asrMadhab, ['Standard', 'Hanafi'], 'Hanafi'),
    timezone: s.timezone,
    timeFormat: pick<TimeFormat>(s.timeFormat, ['12h', '24h'], '12h'),
    language: pick<Lang>(s.language, ['en', 'ar', 'ur'], 'en'),
    hijriOffset: 0,
    gregorianOffset: 0,
    iqamah: defaultIqamah(),
    jumuah: ['13:30'],
    showSunrise: true,
    showCountdown: true,
    showDates: true,
    showLogo: true,
    showSeconds: false,
    showFooter: true,
    showCelestial: true,
    showName: true,
    backgroundImage: '',
    logoImage: '',
    // Show the built-in library of ahadith on Salāh during prayer out of the box (the
    // admin can turn individual ones off or add their own in Settings).
    salahHadith: { enabled: true, minutes: 15, items: [] },
    footerNote: '',
    createdAt: new Date().toISOString(),
  };
}

/** Backfill fields added in later versions onto a stored timetable, so an upgrade
 *  never silently hides elements that didn't exist as toggles before. */
function migrateTimetable(t: Timetable): Timetable {
  return {
    ...t,
    layout: t.layout ?? 'centered',
    layoutCarousel: t.layoutCarousel ?? false,
    textColor: t.textColor ?? '',
    showCountdown: t.showCountdown ?? true,
    showDates: t.showDates ?? true,
    showLogo: t.showLogo ?? true,
    showSeconds: t.showSeconds ?? false,
    showFooter: t.showFooter ?? true,
    showCelestial: t.showCelestial ?? true,
    showName: t.showName ?? true,
    bitrate720: t.bitrate720,
    bitrate1080: t.bitrate1080,
    location: t.location ?? '',
    hijriOffset: t.hijriOffset ?? 0,
    gregorianOffset: t.gregorianOffset ?? 0,
    fajrAngle: t.fajrAngle ?? 18,
    ishaAngle: t.ishaAngle ?? 17,
    backgroundImage: t.backgroundImage ?? '',
    logoImage: t.logoImage ?? '',
    // Drop methods we no longer support (was Tehran/Jafari) → safe default.
    method: VALID_METHODS.includes(t.method) ? t.method : 'MWL',
  };
}

function freshDB(): DB {
  return {
    version: DB_VERSION,
    admin: null,
    volunteerAuth: null,
    settings: {
      defaultQuality: config.seed.quality as Quality,
      scheduleTimezone: config.seed.timezone,
      volunteerEnabled: false,
      volunteerRemote: true,
    },
    timetables: [seededTimetable()],
    sources: [],
    tvs: [],
    schedules: [],
  };
}

export type ChangeListener = () => void;

export class Store {
  db: DB;
  /** HMAC secret for signing session cookies (generated once, persisted). */
  readonly secret: Buffer;
  private readonly file: string;
  private readonly listeners = new Set<ChangeListener>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.file = path.join(config.dataDir, 'db.json');
    this.db = this.load();
    this.secret = this.loadSecret();
  }

  private load(): DB {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as DB;
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.timetables)) {
          parsed.timetables = parsed.timetables.map(migrateTimetable);
          const fresh = freshDB();
          // Merge settings so fields added in later versions (e.g. volunteerEnabled) default in.
          return { ...fresh, ...parsed, settings: { ...fresh.settings, ...parsed.settings }, version: DB_VERSION };
        }
      }
    } catch (err) {
      log.error('could not read db.json, starting fresh', err);
    }
    const db = freshDB();
    this.persist(db);
    log.info('initialised a fresh data store');
    return db;
  }

  private loadSecret(): Buffer {
    const f = path.join(config.dataDir, 'session.secret');
    try {
      if (fs.existsSync(f)) return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
    } catch {
      /* regenerate below */
    }
    const secret = crypto.randomBytes(32);
    try {
      fs.writeFileSync(f, secret.toString('hex'), { mode: 0o600 });
    } catch (err) {
      log.warn('could not persist session secret; sessions reset on restart');
    }
    return secret;
  }

  private persist(db: DB): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Mutate the DB, persist (debounced), and notify listeners synchronously. */
  update(fn: (db: DB) => void): void {
    fn(this.db);
    this.scheduleSave();
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        log.error('change listener failed', err);
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        this.persist(this.db);
      } catch (err) {
        log.error('failed to persist db.json', err);
      }
    }, 150);
  }

  onChange(fn: ChangeListener): void {
    this.listeners.add(fn);
  }
}
