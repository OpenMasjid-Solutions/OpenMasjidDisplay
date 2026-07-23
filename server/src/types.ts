// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Shared domain types for OpenMasjid Display.
 *
 * The platform injects no masjid profile, so everything masjid-specific lives
 * here and is persisted to the app's own data volume (see store.ts). Install
 * settings only seed sensible defaults on first run.
 */

export type Quality = '720p' | '1080p';
export type Orientation = 'landscape' | 'portrait';
/** Arrangement preset for the on-screen layout (see render/svg.ts). */
export type TimetableLayout = 'centered' | 'clockTop' | 'split';
export type Lang = 'en' | 'ar' | 'ur';
export type CalcMethod = 'MWL' | 'ISNA' | 'Egypt' | 'Makkah' | 'Karachi' | 'Custom';
export type AsrMadhab = 'Standard' | 'Hanafi';
export type TimeFormat = '12h' | '24h';

/** How a prayer's Iqamah time is decided. */
export interface IqamahRule {
  mode: 'offset' | 'fixed' | 'none';
  /** minutes after the Adhan (mode: 'offset') */
  offset?: number;
  /** wall-clock "HH:MM" (mode: 'fixed') */
  fixed?: string;
}

export interface IqamahConfig {
  fajr: IqamahRule;
  dhuhr: IqamahRule;
  asr: IqamahRule;
  maghrib: IqamahRule;
  isha: IqamahRule;
}

/** Per-day Iqamah override times (CSV import or the calendar editor), keyed by "MM-DD"
 *  (repeats each year). Each value maps a prayer key to a "HH:MM" clock time; where a date
 *  has an entry it wins over the IqamahConfig rule, and missing dates fall back to the rule.
 *  Maghrib is NEVER stored here — it always follows the calculated sunset time plus its
 *  Iqamah offset (a fixed clock time can't track the drifting sunset). */
export type IqamahYear = Record<string, Partial<Record<'fajr' | 'dhuhr' | 'asr' | 'maghrib' | 'isha' | 'jumuah', string>>>;

/** A scheduled Iqamah change. From the absolute date `from` ("YYYY-MM-DD") onward, the
 *  given prayers use these fixed "HH:MM" times (and, if set, these Jumu'ah times) — and
 *  KEEP using them until a later entry's date takes over. Unlike IqamahYear (a per-DAY
 *  map), a schedule entry holds indefinitely forward: the common "we moved Fajr on March 1
 *  and it stayed that way" case. Each prayer carries forward independently (an entry that
 *  only sets Fajr leaves the others on whatever the previous entry/rule gave). Maghrib is
 *  never scheduled — it always follows the calculated sunset plus its Iqamah offset. */
export interface IqamahScheduleEntry {
  /** absolute effective date, "YYYY-MM-DD" */
  from: string;
  fajr?: string;
  dhuhr?: string;
  asr?: string;
  isha?: string;
  /** Jumu'ah time(s) "HH:MM" effective from this date (replaces the base Jumu'ah times) */
  jumuah?: string[];
}

/** Image announcement slideshow: between spells of the normal display, the uploaded
 *  images cycle as the backdrop (prayer times stay on top), within a daily window. */
export interface Announcements {
  enabled: boolean;
  /** uploaded image filenames under /data/uploads */
  images: string[];
  /** daily active window "HH:MM" ('' = all day) */
  start: string;
  end: string;
  /** seconds the normal timetable shows before the slideshow runs */
  everySeconds: number;
  /** seconds the slideshow runs before the main layout takes back over */
  forSeconds: number;
  /** seconds each image is shown */
  imageSeconds: number;
  /** also cycle a live parking board pulled from the Parking Attendant app over the
   *  OpenMasjidOS Fabric (capability `parking-attendant/parking`). The frame is
   *  refreshed in the background and shown as one more slide. Off by default; only
   *  has effect when the platform + that app are present (fails soft otherwise). */
  parking?: boolean;
}

/** One scrolling ticker message, optionally scheduled to a daily window. */
export interface TickerMessage {
  id: string;
  text: string;
  /** daily window "HH:MM" ('' = always, while the ticker is enabled) */
  start: string;
  end: string;
}
/** A bottom scrolling ticker of short messages. */
export interface Ticker {
  enabled: boolean;
  messages: TickerMessage[];
}

/** One hadith, optionally in both Arabic and English (either may be empty). */
export interface HadithItem {
  ar: string;
  en: string;
  /** short source attribution shown under the text (e.g. "al-Tirmidhī:413") */
  cite?: string;
  /** salawāt to show this after (prayer keys); empty/omitted = shown after any prayer */
  prayers?: string[];
}

/** During salah (the minutes after Iqāmah), show a hadith over a dimmed background. The
 *  display rotates through a built-in library of ahadith on Salāh plus any the admin
 *  adds. Individual built-ins can be turned off (see defaultHadith.ts). */
export interface SalahHadith {
  enabled: boolean;
  /** how many minutes after each Iqāmah to show the hadith overlay */
  minutes: number;
  /** the admin's own hadith (each with Arabic and/or English) */
  items: HadithItem[];
  /** ids of built-in ahadith the admin has turned OFF (all built-ins are on by default) */
  disabledDefaults?: string[];
  /** per-built-in salah targeting override (id → prayer keys); absent = use the shipped default */
  defaultPrayers?: Record<string, string[]>;
}

/** During salah (the minutes after each Iqāmah), black the screen out completely — no
 *  times, no hadith, nothing — so it isn't a distraction while the congregation prays.
 *  Mutually exclusive with the salah hadith overlay; if both are somehow on, the
 *  blackout wins. */
export interface SalahBlackout {
  enabled: boolean;
  /** how many minutes after each Iqāmah to keep the screen black */
  minutes: number;
}

/** A full-screen notice during the makrūh "prohibited" window before Dhuhr (zawāl),
 *  counting down to the Dhuhr Adhan. */
export interface ProhibitedNotice {
  enabled: boolean;
  /** how many minutes before the Dhuhr Adhan to show it */
  minutes: number;
  /** show a red scrolling message along the bottom (overriding any ticker) instead of
   *  the full-screen notice */
  ticker?: boolean;
}

/** A full-screen countdown shown for the last minutes before each Iqāmah. */
export interface IqamahCountdown {
  enabled: boolean;
  /** how many minutes before the Iqāmah the full-screen countdown takes over */
  minutes: number;
}

/** A static, plain-language heads-up shown in the bottom band when an upcoming per-day
 *  Iqāmah change (from iqamahYear) is within `daysBefore` days — e.g. "From Friday, Asr
 *  will be at 5:30 PM". Sits above the scrolling ticker (both can show at once) and shows
 *  even when the ticker is off. */
export interface IqamahChangeNotice {
  enabled: boolean;
  /** how many days before the change takes effect to start showing the heads-up */
  daysBefore: number;
}

/** Per-prayer minutes to add to the calculated Adhan time, for masjids that call the
 *  Adhan a few minutes after the astronomical time. Applies to the DISPLAYED Adhan (and,
 *  for offset-mode Iqāmah, shifts the Iqāmah with it) and to the "when does the next
 *  prayer come in" countdown; Sunrise and the sun/moon position stay on the true
 *  astronomical times. */
export type AdhanOffsets = Partial<Record<'fajr' | 'dhuhr' | 'asr' | 'maghrib' | 'isha', number>>;

/** A small, brief pop-up shown when an Adhan time arrives ("It's time for Fajr"), drawn
 *  over the normal layout (not a full-screen takeover). */
export interface AdhanPopup {
  enabled: boolean;
  /** how many seconds the pop-up stays on screen after the Adhan */
  seconds: number;
}

/** Public embeddable web widget: a compact vertical list of just the prayer times +
 *  Jumu'ah (NOT the full TV display), served unauthenticated for this timetable so a
 *  masjid can embed it on their own website. Off by default. */
export interface TimetableWidget {
  enabled: boolean;
}

/** A full-screen prayer-times display, themeable per room. */
export interface Timetable {
  id: string;
  name: string;
  /** palette preset key (see render/theme.ts) */
  themeId: string;
  /** optional custom primary/accent colour (hex) overriding the preset (rings, Iqamah, active row) */
  accent?: string;
  /** optional custom gold accent colour (hex): Arabic names, Jumu'ah, the next-prayer highlight */
  goldColor?: string;
  /** on-screen text colour: '' = auto (theme, or auto-contrast against a light photo); or a hex */
  textColor?: string;
  orientation: Orientation;
  quality: Quality;
  /** stream bitrate caps (kbps) for the RTSP video, per output size; blank = default */
  bitrate720?: number;
  bitrate1080?: number;
  /** on-screen arrangement preset */
  layout: TimetableLayout;
  /** rotate through the layouts over the day to avoid screen burn-in */
  layoutCarousel: boolean;
  masjidName: string;
  /** optional location line under the name (e.g. "Lansdale, Pennsylvania"); '' hides it */
  location: string;
  latitude: number | null;
  longitude: number | null;
  method: CalcMethod;
  /** Fajr sun-depression angle (degrees), used when method is 'Custom' */
  fajrAngle: number;
  /** Isha sun-depression angle (degrees), used when method is 'Custom' */
  ishaAngle: number;
  asrMadhab: AsrMadhab;
  /** IANA timezone; '' = use the server's zone */
  timezone: string;
  timeFormat: TimeFormat;
  language: Lang;
  /** nudge the displayed Hijri date by ±days (moon sighting); 0 = none */
  hijriOffset: number;
  /** nudge the displayed Gregorian date by ±days; 0 = none */
  gregorianOffset: number;
  iqamah: IqamahConfig;
  /** Per-day Iqamah overrides (CSV import); managed only by the iqamah-csv endpoints. */
  iqamahYear?: IqamahYear;
  /** Scheduled Iqamah changes ("from this date, times are …, until the next change");
   *  managed only by the iqamah-schedule endpoint. Sorted ascending by `from`. */
  iqamahSchedule?: IqamahScheduleEntry[];
  /** Friday khutbah/Jumu'ah times "HH:MM" (one or more) */
  jumuah: string[];
  showSunrise: boolean;
  /** element toggles for the on-screen display */
  showCountdown: boolean;
  showDates: boolean;
  showLogo: boolean;
  /** show seconds on the big clock (HH:MM:SS) */
  showSeconds: boolean;
  /** show the small footer line (custom note, or the calculation-method note) */
  showFooter: boolean;
  /** show the sun/moon arcing across the sky (and the soft glow it casts on the glass) */
  showCelestial: boolean;
  /** show the masjid name text (turn off for a logo-only header) */
  showName: boolean;
  /** filename of an uploaded custom background under /data/uploads ('' = themed scene) */
  backgroundImage: string;
  /** filename of an uploaded masjid logo under /data/uploads ('' = the built-in mark) */
  logoImage: string;
  /** custom on-screen label overrides (e.g. rename a prayer), keyed by label key */
  labels?: Record<string, string>;
  /** image announcement slideshow (images managed by the announcements endpoints) */
  announcements?: Announcements;
  /** bottom scrolling text ticker */
  ticker?: Ticker;
  /** ticker scroll speed, 1 (slow) … 10 (fast); default 5 */
  tickerSpeed?: number;
  /** hadith overlay shown during salah (minutes after each Iqāmah) */
  salahHadith?: SalahHadith;
  /** blank the screen entirely during salah (minutes after each Iqāmah) */
  salahBlackout?: SalahBlackout;
  /** "prohibited time" notice before the Dhuhr Adhan (zawāl) */
  prohibitedNotice?: ProhibitedNotice;
  /** full-screen countdown for the last minutes before each Iqāmah */
  iqamahCountdown?: IqamahCountdown;
  /** static heads-up in the bottom band about an upcoming per-day Iqāmah change */
  iqamahChangeNotice?: IqamahChangeNotice;
  /** per-prayer minutes added to the calculated Adhan time (precautionary delay) */
  adhanOffsets?: AdhanOffsets;
  /** brief "it's time for salah" pop-up when an Adhan arrives */
  adhanPopup?: AdhanPopup;
  /** public embeddable web widget (prayer times only) for this timetable */
  widget?: TimetableWidget;
  footerNote: string;
  createdAt: string;
}

export type SourceType = 'camera' | 'hdmi';
/** direct = MediaMTX relays the source as-is (lightest); normalize = transcode
 *  to a fixed H.264 geometry for the widest TV-decoder compatibility. */
export type SourceMode = 'direct' | 'normalize';

export interface Source {
  id: string;
  name: string;
  type: SourceType;
  /** rtsp:// or rtsps:// URL (may embed credentials) */
  url: string;
  mode: SourceMode;
  /** output resolution when mode is 'normalize' (ignored for 'direct') */
  quality: Quality;
  enabled: boolean;
  createdAt: string;
}

/** What a screen shows: a timetable, a source, or nothing. */
export interface ContentRef {
  kind: 'timetable' | 'source' | 'off';
  id?: string;
}

/** A physical screen, addressed by a stable RTSP path its decoder connects to. */
export interface Tv {
  id: string;
  name: string;
  room?: string;
  defaultContent: ContentRef;
  /** Manual override set by a volunteer; until = epoch ms (null = until changed). */
  override?: { content: ContentRef; until: number | null } | null;
  createdAt: string;
}

export interface ScheduleRule {
  id: string;
  name: string;
  enabled: boolean;
  /** TV ids, or ['*'] for every screen */
  targets: string[];
  content: ContentRef;
  /** days the window applies on: 0=Sunday … 6=Saturday */
  days: number[];
  /** window start/end as "HH:MM" (end <= start means it wraps past midnight) */
  start: string;
  end: string;
  /** higher wins when two rules overlap */
  priority: number;
  createdAt: string;
}

export interface Settings {
  defaultQuality: Quality;
  /** IANA timezone used to evaluate schedules ('' = server zone) */
  scheduleTimezone: string;
  /** allow the simple mobile volunteer page (PIN-gated) on its own port */
  volunteerEnabled: boolean;
  /** also serve the volunteer page on the main control-panel port (under /volunteer), so it's
   *  reachable over the OpenMasjidOS remote-access tunnel — not just the local network. When
   *  off, the volunteer page stays on its own LAN port only. Default on. */
  volunteerRemote: boolean;
}

/** A hashed credential (scrypt). Used for the admin password and the volunteer PIN. */
export interface Credential {
  hash: string;
  salt: string;
}

/** The single control-panel admin, created in-app on first run. */
export interface AdminAccount {
  hash: string;
  salt: string;
  name?: string;
  createdAt: string;
}

export interface DB {
  version: number;
  /** null until first-run setup creates the admin. */
  admin: AdminAccount | null;
  /** the volunteer PIN (hashed), or null if none set */
  volunteerAuth?: Credential | null;
  settings: Settings;
  timetables: Timetable[];
  sources: Source[];
  tvs: Tv[];
  schedules: ScheduleRule[];
}

/** Live status for one screen, pushed to the UI over WebSocket. */
export interface TvStatus {
  tvId: string;
  effective: ContentRef;
  source: 'override' | 'schedule' | 'default';
  /** the schedule rule currently driving it, if any */
  ruleId?: string;
  /** is a screen currently pulling this RTSP stream (online); false = offline/no decoder */
  streamReady: boolean;
}
