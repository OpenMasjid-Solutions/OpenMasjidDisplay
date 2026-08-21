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
/** A scheduled "from this date onward" Iqamah change (see server types). */
export interface IqamahScheduleEntry {
  from: string;
  fajr?: string;
  dhuhr?: string;
  asr?: string;
  isha?: string;
  jumuah?: string[];
}
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
  iqamahSchedule?: IqamahScheduleEntry[];
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
  /** absent = 'rtsp' — every screen made before browser screens existed */
  kind?: TvKind;
  /** the unguessable token in a browser screen's public URL */
  webToken?: string;
  /** the Raspberry Pi driving this screen, for kind: 'pi'. Set when the device is adopted. */
  piDeviceId?: string;
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

/** Posting the Iqāmah-change notice to a WhatsApp group, via OpenMasjidOS. All off by default. */
export interface WhatsAppSettings {
  iqamahChange: boolean;
  /** the approved group's JID, or '' */
  groupId: string;
  /** its label when chosen, so it can still be named if approval is later withdrawn */
  groupLabel: string;
  /** whose changes to announce; '' = the first timetable */
  timetableId: string;
  /** days ahead of the change to post; 0 = on the day */
  daysBefore: number;
}

export type TvKind = 'rtsp' | 'web' | 'pi';

/** A Raspberry Pi running the display agent, as the dashboard sees it. */
export interface PiDeviceInfo {
  id: string;
  /** the pairing code shown on its screen; empty once adopted, because the code is spent */
  code: string;
  adopted: boolean;
  hostname: string;
  ip: string;
  model: string;
  agentVersion: string;
  tvId?: string;
  online: boolean;
  lastSeenAt: string;
  /** true when this device already runs what the server would give it, so Update is a no-op */
  upToDate?: boolean;
  /** the last lines the agent logged, as it saw them. Display text only. */
  recentLog?: string[];
  logAt?: string;
  /** Load, memory and temperature, as the screen last reported them. */
  stats?: {
    load1: number; cores: number; cpuPercent: number;
    memUsedMb: number; memTotalMb: number; memPercent: number;
    tempC: number; uptimeSec: number;
  };
  statsAt?: string;
  /** The full journal from the screen, collected when asked for. Already ANSI-stripped. */
  journal?: string;
  /** when it was collected, so the viewer can say how stale it is */
  journalAt?: string;
  /** The Wi-Fi networks this screen can see, strongest first. */
  networks?: { ssid: string; signal: number; secured: boolean; active: boolean }[];
  /** The outcome of the last join. `ok: null` = joined, but the server was not proven reachable. */
  wifiResult?: { ok: boolean | null; detail: string; at: string };
  /** When an install was last asked for, so the card can say it is busy for the couple of minutes
   *  it takes. Not proof of anything: the version changing is what says it worked. */
  updateAskedAt?: number;
  /** How the screen is attached to the network. Undefined — not 'none' — until the device has
   *  checked in with an agent new enough to report it, which is a different thing from being
   *  unplugged and has to be drawn differently. */
  net?: PiDeviceNet;
}

export interface PiDeviceNet {
  /** Ethernet wins when both are up, because the cable is what carries the traffic. */
  link: 'ethernet' | 'wifi' | 'none';
  /** The Wi-Fi network it is on. Empty unless link is 'wifi'. */
  ssid: string;
  /** 0-100. Zero unless link is 'wifi'. */
  signal: number;
  /** Whether the radio is switched on — distinct from whether there is a radio at all. */
  radio: boolean;
  /** Whether this device has Wi-Fi hardware. Wi-Fi is not offered for a screen without it. */
  hasWifi: boolean;
}

export interface Settings {
  defaultQuality: Quality;
  scheduleTimezone: string;
  volunteerEnabled: boolean;
  /** also serve the volunteer page on the main address / over remote access (default on) */
  volunteerRemote: boolean;
  whatsapp: WhatsAppSettings;
  /** BETA: offer browser screens as an alternative to an RTSP decoder */
  webScreensBeta: boolean;
}

/** Why this masjid can or cannot send — the platform's vocabulary, each needing its own
 *  sentence. `no-fabric` and `not-allowed` are this app's own additions. */
export type WhatsAppReason = 'ready' | 'not-configured' | 'not-linked' | 'unreachable' | 'not-allowed' | 'no-fabric';

export interface WhatsAppLogEntry {
  at: string;
  event: 'iqamah-change';
  /** the group JID — an id, never a name or a body */
  recipient: string;
  effectiveFrom: string;
  outcome: 'queued' | 'failed';
  /** the poster image went too, rather than text alone */
  asImage?: boolean;
  error?: string;
  manual?: boolean;
}

export interface WhatsAppStatus {
  available: boolean;
  reason: WhatsAppReason;
  /** can OpenMasjidOS carry the poster image? False on an older platform, which means the
   *  notice goes as text instead. */
  media: boolean;
  /** the platform's own decoded-bytes cap for an image; 0 when unknown */
  maxMediaBytes: number;
  /** only the groups the OpenMasjidOS admin approved for this app */
  groups: { id: string; label: string }[];
  /** the exact message that would be posted — the caption when the poster goes with it,
   *  the whole notice when it cannot. Null when there is nothing to announce. */
  preview: string | null;
  /** why there is no preview */
  previewNote: string | null;
  /** newest first */
  log: WhatsAppLogEntry[];
}

export interface TvStatus {
  tvId: string;
  effective: ContentRef;
  source: 'override' | 'schedule' | 'default';
  ruleId?: string;
  /** a screen is currently pulling this RTSP stream (online); false = offline */
  streamReady: boolean;
  /** the timetable stopped updating, so the times on that screen are NOT current
   *  (can be true while a decoder is happily reading the frozen picture) */
  contentStale?: boolean;
  /** why: frozen renderer, or a wrong machine clock (frame age says nothing then) */
  staleReason?: 'frozen' | 'clock';
  /** age in ms of the frame being published, when known */
  frameAgeMs?: number;
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

/** One release section of the shipped CHANGELOG.md, as parsed by the server
 *  (server/src/changelog.ts). `items` are bullets/paragraphs in file order, still
 *  carrying their inline **bold** and `code` markers for the panel to format. */
export interface Release {
  version: string;
  items: string[];
}
