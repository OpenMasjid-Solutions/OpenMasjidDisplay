// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
// Client-side mirror of the server domain types (see server/src/types.ts).

export type Quality = '720p' | '1080p';
export type Orientation = 'landscape' | 'portrait';
export type TimetableLayout = 'centered' | 'clockTop' | 'split';
export type Lang = 'en' | 'ar' | 'ur';
export type CalcMethod = 'MWL' | 'ISNA' | 'Egypt' | 'Makkah' | 'Karachi' | 'Custom';
export type AsrMadhab = 'Standard' | 'Hanafi';
export type TimeFormat = '12h' | '24h';

export interface IqamahRule {
  mode: 'offset' | 'fixed' | 'none';
  offset?: number;
  fixed?: string;
}
export interface IqamahConfig {
  fajr: IqamahRule;
  dhuhr: IqamahRule;
  asr: IqamahRule;
  maghrib: IqamahRule;
  isha: IqamahRule;
}
export type IqamahYear = Record<string, Partial<Record<'fajr' | 'dhuhr' | 'asr' | 'maghrib' | 'isha' | 'jumuah', string>>>;
export interface Announcements {
  enabled: boolean;
  images: string[];
  start: string;
  end: string;
  everySeconds: number;
  forSeconds: number;
  imageSeconds: number;
}
export interface TickerMessage { id: string; text: string; start: string; end: string }
export interface Ticker { enabled: boolean; messages: TickerMessage[] }
export interface HadithItem { ar: string; en: string; cite?: string; prayers?: string[] }
export interface SalahHadith { enabled: boolean; minutes: number; items: HadithItem[]; disabledDefaults?: string[]; defaultPrayers?: Record<string, string[]> }
/** Blank the screen entirely during salah (minutes after each Iqāmah). */
export interface SalahBlackout { enabled: boolean; minutes: number }
/** A built-in hadith the display ships with (English + citation + shipped salah targeting). */
export interface HadithDefault { id: string; en: string; cite: string; prayers?: string[] }
export interface ProhibitedNotice { enabled: boolean; minutes: number; ticker?: boolean }
export interface IqamahCountdown { enabled: boolean; minutes: number }
/** Static heads-up about an upcoming per-day Iqāmah change, shown a few days before. */
export interface IqamahChangeNotice { enabled: boolean; daysBefore: number }
export type AdhanOffsets = Partial<Record<'fajr' | 'dhuhr' | 'asr' | 'maghrib' | 'isha', number>>;
export interface AdhanPopup { enabled: boolean; seconds: number }
export interface TimetableWidget { enabled: boolean }
export interface Timetable {
  id: string;
  name: string;
  themeId: string;
  accent?: string;
  /** custom gold accent colour (hex): Arabic names, Jumu'ah, next-prayer highlight */
  goldColor?: string;
  /** on-screen text colour: '' = auto contrast; or a hex */
  textColor?: string;
  orientation: Orientation;
  quality: Quality;
  layout: TimetableLayout;
  layoutCarousel: boolean;
  masjidName: string;
  location: string;
  latitude: number | null;
  longitude: number | null;
  method: CalcMethod;
  fajrAngle: number;
  ishaAngle: number;
  asrMadhab: AsrMadhab;
  timezone: string;
  timeFormat: TimeFormat;
  language: Lang;
  hijriOffset: number;
  gregorianOffset: number;
  iqamah: IqamahConfig;
  iqamahYear?: IqamahYear;
  jumuah: string[];
  showSunrise: boolean;
  showCountdown: boolean;
  showDates: boolean;
  showLogo: boolean;
  showSeconds: boolean;
  showFooter: boolean;
  showCelestial: boolean;
  showName: boolean;
  bitrate720?: number;
  bitrate1080?: number;
  backgroundImage: string;
  logoImage: string;
  labels?: Record<string, string>;
  announcements?: Announcements;
  ticker?: Ticker;
  /** ticker scroll speed 1 (slow) … 10 (fast) */
  tickerSpeed?: number;
  salahHadith?: SalahHadith;
  salahBlackout?: SalahBlackout;
  prohibitedNotice?: ProhibitedNotice;
  iqamahCountdown?: IqamahCountdown;
  iqamahChangeNotice?: IqamahChangeNotice;
  adhanOffsets?: AdhanOffsets;
  adhanPopup?: AdhanPopup;
  widget?: TimetableWidget;
  footerNote: string;
  createdAt: string;
}

export type SourceType = 'camera' | 'hdmi';
export type SourceMode = 'direct' | 'normalize';
export interface Source {
  id: string;
  name: string;
  type: SourceType;
  url: string;
  mode: SourceMode;
  quality: Quality;
  enabled: boolean;
  createdAt: string;
}

export interface ContentRef {
  kind: 'timetable' | 'source' | 'off';
  id?: string;
}

export interface Tv {
  id: string;
  name: string;
  room?: string;
  defaultContent: ContentRef;
  override?: { content: ContentRef; until: number | null } | null;
  createdAt: string;
}

export interface ScheduleRule {
  id: string;
  name: string;
  enabled: boolean;
  targets: string[];
  content: ContentRef;
  days: number[];
  start: string;
  end: string;
  priority: number;
  createdAt: string;
}

export interface Settings {
  defaultQuality: Quality;
  scheduleTimezone: string;
  volunteerEnabled: boolean;
  /** also serve the volunteer page on the main address / over remote access (default on) */
  volunteerRemote: boolean;
}

export interface TvStatus {
  tvId: string;
  effective: ContentRef;
  source: 'override' | 'schedule' | 'default';
  ruleId?: string;
  /** a screen is currently pulling this RTSP stream (online); false = offline */
  streamReady: boolean;
}

export interface ThemePreset {
  id: string;
  label: string;
  palette: Record<string, string>;
}

/** A click-to-edit text region on the live preview (fractions of the canvas). */
export interface Hotspot {
  id: string;
  value: string;
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

export interface AppState {
  authRequired: boolean;
  settings: Settings;
  timetables: Timetable[];
  sources: Source[];
  tvs: Tv[];
  schedules: ScheduleRule[];
  themes: ThemePreset[];
  /** built-in ahadith on Salāh (for the enable/disable checklist) */
  hadithDefaults: HadithDefault[];
  statuses: TvStatus[];
  /** The screen-facing RTSP port. The link's host is filled in by the browser. */
  rtsp: { port: number; transport: string };
  /** OpenMasjidOS base URL when running under the platform, else '' (for A2 sync). */
  omosBase: string;
  /** volunteer mode: whether a PIN is set, and the host port the page is shown on */
  volunteer: { pinSet: boolean; port: number };
  serverNow: number;
}
