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
/** Length of the session-cookie HMAC secret. A stored secret shorter than this is
 *  treated as damaged and replaced rather than used (see loadSecret). */
const SECRET_BYTES = 32;

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
      if (fs.existsSync(f)) {
        const stored = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
        // Buffer.from(…, 'hex') NEVER throws: malformed or truncated hex silently decodes
        // to a SHORT or EMPTY buffer, and createHmac will happily sign with a zero-length
        // key — a key every attacker also knows, so anyone could then forge an admin
        // session cookie. Fail CLOSED: accept only a full-length secret.
        if (stored.length >= SECRET_BYTES) return stored;
        log.warn(
          'session.secret is truncated or not valid hex — generating a new one. ' +
            'Everyone signed in will need to sign in again.',
        );
      }
    } catch (err) {
      log.warn(`could not read the session secret, generating a new one: ${errMsg(err)}`);
    }
    const secret = crypto.randomBytes(SECRET_BYTES);
    try {
      // tmp+rename, like persist() below: a crash or a full disk mid-write must not be
      // able to leave a half-written secret on disk, since that was exactly the state
      // that used to degrade into an empty (publicly known) signing key.
      const tmp = `${f}.tmp`;
      fs.writeFileSync(tmp, secret.toString('hex'), { mode: 0o600 });
      fs.renameSync(tmp, f);
    } catch (err) {
      log.warn(`could not persist session secret; sessions reset on restart: ${errMsg(err)}`);
    }
    return secret;
  }

  private persist(db: DB): void {
    const tmp = `${this.file}.tmp`;
    // db.json holds the admin's scrypt hash + salt and the volunteer PIN hash, so it must
    // not be group/other readable. session.secret next door was already written 0o600;
    // the file that actually contains the credentials was left to umask. Because rename
    // replaces the target inode, an existing 0644 db.json is corrected on the next save.
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    // writeFileSync applies `mode` only when it CREATES the file (it is open(O_CREAT, mode)),
    // so a db.json.tmp left behind by an earlier crash keeps whatever permissions it had —
    // and rename() then carries them onto db.json, silently defeating the 0600 above.
    // chmod unconditionally. Best-effort: some filesystems (and Windows) don't support it,
    // and failing to persist the store would be a far worse outcome than a loose mode.
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      /* not supported here */
    }
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
