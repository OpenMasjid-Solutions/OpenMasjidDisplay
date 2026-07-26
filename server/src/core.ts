// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The server's single seam onto `packages/render-core` — the pure, shared display
 * engine (prayer-time maths, the SVG builder, palettes, the built-in hadith
 * library, Iqamah CSV/schedule resolution).
 *
 * Everything in render-core is platform-free: no fs, no resvg, no ffmpeg, no
 * process.env. That is what lets a Raspberry Pi node render byte-identical screens
 * in a kiosk browser while this container rasterizes them to H.264 (see
 * docs/PI_NODE_SPEC.md). The server keeps the impure half — rasterization
 * (render/renderWorker.ts), asset inlining (render/background.ts), fonts, ffmpeg.
 *
 * Import render-core through THIS file, never by reaching across the tree, so the
 * awkward relative path exists in exactly one place and the boundary stays obvious
 * in every diff.
 */
export * from '../../packages/render-core/src/index';
