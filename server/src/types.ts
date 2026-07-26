// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Shared domain types for OpenMasjid Display.
 *
 * The platform injects no masjid profile, so everything masjid-specific lives
 * here and is persisted to the app's own data volume (see store.ts). Install
 * settings only seed sensible defaults on first run.
 *
 * SPLIT: the DISPLAY types (Timetable and everything inside it) live in
 * `packages/render-core/src/types.ts`, because a Raspberry Pi node renders the
 * same screen from the same types without any of the server around it. They are
 * re-exported below — `import type { Timetable } from './types'` keeps working
 * everywhere in the server, and this file stays the one place to look. Types that
 * only make sense on the controller (screens, sources, schedules, credentials, the
 * store, node records) are defined here.
 */

// ── The display domain, owned by render-core (type-only re-export: no runtime cost) ──
export type {
  Quality,
  Orientation,
  TimetableLayout,
  Lang,
  CalcMethod,
  AsrMadhab,
  TimeFormat,
  IqamahRule,
  IqamahConfig,
  IqamahYear,
  IqamahScheduleEntry,
  Announcements,
  TickerMessage,
  Ticker,
  HadithItem,
  SalahHadith,
  SalahBlackout,
  ProhibitedNotice,
  IqamahCountdown,
  IqamahChangeNotice,
  AdhanOffsets,
  AdhanPopup,
  TimetableWidget,
  Timetable,
} from './core';

// Used by the server-only types below (Source geometry, Settings defaults, the store).
import type { Quality, Timetable } from './core';

export type SourceType = 'camera' | 'hdmi';
/** direct = MediaMTX relays the source as-is (lightest); normalize = transcode
 *  to a fixed H.264 geometry for the widest TV-decoder compatibility. */
export type SourceMode = 'direct' | 'normalize';

/** How a Pi node should get this source's video. `auto` = play it directly off the
 *  LAN when the node can decode it (the compute win — no controller involvement),
 *  else fall back to the controller's `normalize` transcode. `direct-only` never
 *  relays (an unplayable codec surfaces as an error instead of loading the host).
 *  `always-relay` reproduces the legacy behaviour of routing every byte through the
 *  controller. Ignored by legacy decoder screens, which always use MediaMTX. */
export type NodePlayback = 'auto' | 'direct-only' | 'always-relay';

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
  /** how Pi nodes should play this source (see NodePlayback); default 'auto' */
  nodePlayback?: NodePlayback;
  /** Video codec last observed on this source, lowercased (e.g. 'h264', 'h265'), or
   *  '' when unknown. Learned from a node's `unsupported_codec` event — we never
   *  probe on the controller for this — and used to pre-emptively relay instead of
   *  making the next node fail first. */
  videoCodec?: string;
  createdAt: string;
}

/** What a screen shows: a timetable, a source, or nothing. */
export interface ContentRef {
  kind: 'timetable' | 'source' | 'off';
  id?: string;
}

/** How a screen is driven.
 *  `decoder` — the original (and still default) kind: the controller renders video
 *    around the clock and the screen's RTSP-to-HDMI decoder box pulls a MediaMTX
 *    path. Works with any dumb decoder; costs the controller an encoder per screen.
 *  `node` — a Raspberry Pi running our image, plugged into the TV's HDMI. It
 *    renders the timetable itself from a tiny JSON document and pulls camera
 *    streams straight off the LAN, so the controller does no video work and may
 *    even be cloud-hosted. See docs/PI_NODE_SPEC.md. */
export type ScreenKind = 'decoder' | 'node';

/** A physical screen, addressed by a stable RTSP path its decoder connects to. */
export interface Tv {
  id: string;
  name: string;
  room?: string;
  defaultContent: ContentRef;
  /** Manual override set by a volunteer; until = epoch ms (null = until changed). */
  override?: { content: ContentRef; until: number | null } | null;
  /** How this screen is driven. Absent/'decoder' = the legacy RTSP path, so every
   *  screen that existed before Pi nodes keeps behaving exactly as it did. */
  kind?: ScreenKind;
  /** id of the PiNode driving this screen (only when kind === 'node') */
  nodeId?: string;
  createdAt: string;
}

/** Hardware/firmware capabilities a node reports in its `hello`. The controller uses
 *  these to decide whether a source can be played directly or must be relayed. */
export interface NodeCaps {
  /** video codecs the node can decode in hardware, lowercased (e.g. ['h264']) */
  codecs: string[];
  maxHeight: number;
  maxFps: number;
}

/** Last-known health of a node, refreshed from its `status` heartbeat. Purely
 *  informational — shown in the panel's node drawer. */
export interface NodeHealth {
  /** SoC temperature in °C */
  tempC?: number;
  /** free RAM in MiB */
  memFreeMb?: number;
  /** seconds since the node booted */
  uptimeS?: number;
  /** Wi-Fi signal in dBm (absent on Ethernet) */
  wifiRssi?: number;
  ip?: string;
}

/** An adopted Raspberry Pi display node.
 *
 *  SECURITY: only `tokenHash` is stored — never the adoption token itself. The
 *  plaintext token exists once, in the adopt response, and thereafter only on the
 *  node's own /data. Verified with the same scrypt + constant-time compare used for
 *  the admin password (see auth.ts), so a stolen db.json cannot impersonate a node. */
export interface PiNode {
  id: string;
  /** the Pi's hardware serial, from /proc/cpuinfo — stable across reflashes */
  serial: string;
  name: string;
  /** scrypt hash of the 256-bit adoption token */
  tokenHash: string;
  tokenSalt: string;
  /** agent firmware version last reported */
  fw: string;
  /** board model string the agent reported (e.g. 'Raspberry Pi Zero 2 W') */
  model: string;
  caps: NodeCaps;
  /** last IP the node was seen at (from adoption, then from heartbeats) */
  ip: string;
  /** epoch ms of the last frame received from this node (0 = never) */
  lastSeen: number;
  health?: NodeHealth;
  /** the screen this node drives, if it has been bound to one */
  screenId?: string;
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
  /** expose the Raspberry Pi node screen kind (adoption, the node hub, the panel's
   *  "Add → Pi node" flow). Off by default until the hardware path is proven on real
   *  boards; legacy decoder screens are completely unaffected either way. */
  piNodes: boolean;
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

/** An incorrect-parking report, filed by a volunteer on the volunteer page. Each
 *  report becomes a full-screen red alert card that rotates in the announcement
 *  slideshow of the timetable(s) it targets (['*'] = every timetable). Its optional
 *  photo is stored under /data/uploads as `<id>.report.<ext>`. */
export interface ParkingReport {
  id: string;
  /** license plate (may be empty if only a description is given) */
  plate: string;
  /** the car — colour, make, model */
  description: string;
  /** where it is */
  location: string;
  /** why it's being reported */
  reason: string;
  /** uploaded photo filenames under /data/uploads (0..several); the card renders one
   *  frame per photo so the slideshow scrolls through them */
  images: string[];
  /** timetable ids to show this on; ['*'] = all timetables */
  targets: string[];
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
  /** adopted Raspberry Pi display nodes (added in the Pi-node release; absent on
   *  every store written before it, hence optional — store.ts fills it in) */
  nodes?: PiNode[];
  /** incorrect-parking reports filed on the volunteer page (rotated as alert cards) */
  reports?: ParkingReport[];
}

/** Live status for one screen, pushed to the UI over WebSocket. */
export interface TvStatus {
  tvId: string;
  effective: ContentRef;
  source: 'override' | 'schedule' | 'default';
  /** the schedule rule currently driving it, if any */
  ruleId?: string;
  /** For a decoder screen: is a screen currently pulling this RTSP stream (online)?
   *  For a node screen: is the node's WebSocket connected with a fresh heartbeat?
   *  Either way, false = nothing is showing this content. */
  streamReady: boolean;
}
