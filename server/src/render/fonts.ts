// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Locate a small, curated set of bundled font files for resvg to render with.
 *
 *  We pick only the BASE families we actually draw with (Latin sans/serif +
 *  Arabic). `fonts-noto-core` ships dozens of per-script files (NotoSansThai,
 *  NotoSansHebrew, …); loading all of them makes every render parse far more font
 *  data, and if the base Latin face gets crowded out resvg can hang on glyph
 *  fallback. DejaVu is the always-present safety net when Noto isn't installed.
 *
 *  Rendering runs on a worker thread (see render/renderWorker.ts), so the per-frame
 *  cost no longer blocks the event loop; the OS page cache keeps these few files
 *  hot after the first read. The scan + selection is done once and memoised. */
import fs from 'node:fs';
import path from 'node:path';
import { makeLog } from '../logger';

const log = makeLog('fonts');

// `/app/fonts` (our vendored faces) is scanned FIRST so a bundled file wins over the
// distro's copy of the same family — e.g. our STATIC Noto Naskh Arabic (verified to
// carry the ﷺ ligature, U+FDFA) is picked ahead of the distro's variable font, which
// resvg can render that glyph as a tofu box. See assets/fonts/README.md.
// OMD_FONT_DIR is scanned ahead of all of them, so the server can be run from a source
// checkout — where /app/fonts does not exist — and still draw with the vendored faces rather
// than falling back to system fonts. Unset in the image, where /app/fonts is the real thing.
const DIRS = [process.env.OMD_FONT_DIR, '/app/fonts', '/usr/share/fonts', '/usr/local/share/fonts'].filter(
  (d): d is string => !!d,
);

// The curated faces, in priority order. Matched on the file's basename (without
// extension). Keep this small — EVERY file here is parsed on EVERY frame, so a
// leaner set means faster renders (fewer per-frame ms = the per-second video loop
// keeps up and the countdown doesn't skip a second on a busy box). The display only
// ever draws with the sans + Arabic families, so we deliberately DON'T load serif.
const PRIORITY = [
  'NotoSans-Regular',
  'NotoSans-Bold',
  // The Arabic face. Amiri is a traditional Naskh (vendored, OFL) with FULL Latin
  // punctuation AND the ﷺ ligature, so mixed Arabic+punctuation text (hadith, notes)
  // renders in ONE font with no tofu — resvg picks a single font per run and does NOT
  // per-glyph fall back, so an Arabic-only face left "( ) tofu boxes in the text.
  'Amiri-Regular',
  'NotoNaskhArabic-Regular', // kept as a secondary Arabic fallback
  'DejaVuSans',
];
const MAX_FONTS = 5;

export interface ResvgFontOptions {
  fontFiles?: string[];
  fontDirs?: string[];
  loadSystemFonts: boolean;
  defaultFontFamily: string;
  serifFamily?: string;
  sansSerifFamily?: string;
}

let cached: ResvgFontOptions | null = null;
/** The bundled font file path for ffmpeg's drawtext ticker (null = none bundled). */
let primaryFont: string | null = null;
export function primaryFontFile(): string | null {
  fontOptions(); // ensure the scan/selection has run
  return primaryFont;
}

function scan(): string[] {
  const found: string[] = [];
  for (const dir of DIRS) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const rel of fs.readdirSync(dir, { recursive: true }) as string[]) {
        const name = String(rel);
        if (/\.(ttf|otf)$/i.test(name)) found.push(path.join(dir, name));
      }
    } catch {
      log.debug(`scan ${dir} failed`);
    }
  }
  return found;
}

export function fontOptions(): ResvgFontOptions {
  if (cached) return cached;

  const all = scan();
  // Pick our curated files in priority order (matched on basename, sans extension).
  const chosen: string[] = [];
  for (const want of PRIORITY) {
    const hit = all.find((f) => path.basename(f).replace(/\.(ttf|otf)$/i, '') === want);
    if (hit && !chosen.includes(hit)) chosen.push(hit);
    if (chosen.length >= MAX_FONTS) break;
  }
  // Arabic safety net: recent Noto ships Arabic as VARIABLE fonts whose basenames
  // don't match "…-Regular" (e.g. NotoNaskhArabic[wght].ttf), so the exact-match
  // loop above misses them and Arabic renders as tofu boxes. If no Arabic face got
  // picked, grab one by substring (Naskh preferred — it's the traditional Qur'anic
  // hand — then Sans Arabic), so hadith/labels in Arabic actually shape.
  const haveArabic = chosen.some((f) => /arabic|amiri/i.test(path.basename(f)));
  if (!haveArabic && chosen.length < MAX_FONTS) {
    const ar =
      all.find((f) => /NotoNaskhArabic/i.test(path.basename(f))) ??
      all.find((f) => /NotoSansArabic/i.test(path.basename(f))) ??
      all.find((f) => /arabic/i.test(path.basename(f)));
    if (ar && !chosen.includes(ar)) chosen.push(ar);
  }

  if (chosen.length === 0) {
    log.warn('no bundled fonts found; loading system fonts (slower)');
    cached = { fontDirs: DIRS, loadSystemFonts: true, defaultFontFamily: 'sans-serif' };
    return cached;
  }

  primaryFont = chosen.find((f) => /NotoSans-Bold/i.test(f)) ?? chosen.find((f) => /NotoSans-Regular/i.test(f)) ?? chosen[0] ?? null;
  const haveNotoSans = chosen.some((f) => /NotoSans-/.test(path.basename(f)));
  const sans = haveNotoSans ? 'Noto Sans' : 'DejaVu Sans';
  log.info(`using ${chosen.length} of ${all.length} bundled font file(s) for rendering`);
  cached = {
    fontFiles: chosen,
    loadSystemFonts: false,
    defaultFontFamily: sans,
    // We don't bundle a serif (the display is all sans) — map serif → the sans we
    // loaded so any stray serif request still resolves to a real, loaded face.
    serifFamily: sans,
    sansSerifFamily: sans,
  };
  return cached;
}
