// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * @openmasjid/render-core — the pure display engine shared by every renderer.
 *
 * PLATFORM-FREE BY CONTRACT. Nothing in this package may import `node:*`,
 * `@resvg/resvg-js`, ffmpeg, or read `process.env`: it has to run unchanged in
 *   • the controller container (CommonJS, rasterized by resvg → H.264 → RTSP), and
 *   • a Raspberry Pi node's kiosk browser (ESM, rendered straight into the DOM).
 *
 * Assets (background photo, masjid logo, announcement image) are passed IN as
 * data/blob URIs by the caller — this package never touches a filesystem. Keep it
 * that way; a single `node:fs` import here breaks every Pi node in the field.
 * `packages/render-core/src/purity.test.ts` enforces this on every `npm test`.
 *
 * Re-exported with `export *` deliberately: the surface is whatever the modules
 * export, so adding one there needs no edit here (there are no name collisions
 * between these modules — the purity test also guards that).
 */

/** The display domain — Timetable and everything it contains. */
export * from './types';
/** Prayer-time engine: pure astronomy + local-clock maths. */
export * from './prayer/engine';
/** Palettes / themes. */
export * from './theme';
/** The built-in hadith library shown during salah. */
export * from './defaultHadith';
/** Per-day Iqamah table (CSV import/export) — also exports `parseClock`. */
export * from './iqamahCsv';
/** The "from this date onward" Iqamah change schedule. */
export * from './iqamahSchedule';
/** The screen itself: the SVG builder, its model, and the widget payloads. */
export * from './svg';
