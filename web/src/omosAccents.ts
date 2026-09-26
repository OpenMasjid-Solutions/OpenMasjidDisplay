// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The five accent colours OpenMasjidOS hands an app, each with the ink that goes ON it.
 *
 * The admin picks one on the dashboard and it arrives in `appearance.accent` — through the
 * launch fragment when the dashboard opens us, and again from `/api/public/appearance` while we
 * are open. Two themes times five accents is ten looks; a panel that ignores the accent shows
 * four masjids in five a colour they did not choose.
 *
 * **`onPrimary` is not decoration and is not optional.** These fills are chosen for the
 * dashboard, not for white text: white on `gold` measures 1.67:1, well under AA, and the same
 * mistake on a delete button is the one the platform's own spec says already cost it a bug. So
 * the fill and its ink move together or neither moves — see `applyAccent` in prefs.ts, and
 * `panelContrast.test.ts`, which measures every one of these pairings rather than trusting them.
 *
 * Kept as a flat literal on purpose: that test reads this file as text, so the table here and
 * the table in docs/design-system/APP_UI_SPEC.md §3 cannot drift apart unnoticed.
 */
export interface Accent {
  /** The FILL: buttons, active chips. Use it through `--color-btn`. */
  primary: string;
  /** The hover fill. */
  hover: string;
  /** The ink that goes on `primary`. Never assume white. */
  onPrimary: string;
  /**
   * The same accent as TEXT on the LIGHT theme — a link, the active nav label, the brand.
   *
   * Ours, not the platform's three, and it exists because a fill and a letterform are not the
   * same problem. Every one of these accents is chosen to be a bright fill carrying dark ink;
   * as text on a white card they measure 1.67:1 (gold) to 2.72:1 (violet), which is a colour
   * nobody can read. Each of these is its own accent walked toward a dark neutral until it
   * clears AA on both the light card (#FFFFFF) and the light page (#F0F9FF) — the hue is kept
   * and only the lightness gives way, so a gold masjid still looks gold.
   *
   * The dark theme needs no equivalent: the raw accents run 6.6:1 to 11.7:1 on its page, so
   * there the fill colour and the text colour really are the same colour.
   */
  textLight: string;
}

export const ACCENTS: Record<string, Accent> = {
  cyan: { primary: '#22D3EE', hover: '#67E8F9', onPrimary: '#00131C', textLight: '#177A8F' },
  teal: { primary: '#2DD4BF', hover: '#5EEAD4', onPrimary: '#00201B', textLight: '#1E7F79' },
  sky: { primary: '#38BDF8', hover: '#7DD3FC', onPrimary: '#001B2E', textLight: '#2679A2' },
  violet: { primary: '#A78BFA', hover: '#C4B5FD', onPrimary: '#190B3D', textLight: '#7564B4' },
  gold: { primary: '#FBBF24', hover: '#FCD34D', onPrimary: '#2B1B00', textLight: '#886C22' },
};

/** What the dashboard ships with, and what an unknown value falls back to. */
export const DEFAULT_ACCENT = 'cyan';

export function accentFor(id: string | undefined): Accent {
  return ACCENTS[String(id ?? '')] ?? ACCENTS[DEFAULT_ACCENT];
}
