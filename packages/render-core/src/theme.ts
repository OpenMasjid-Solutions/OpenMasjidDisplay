// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Colour palettes for the timetable display. Each is a calm, dignified scheme;
 *  the control panel mirrors these as room themes. Colours are plain hex/rgba so
 *  they drop straight into the rendered SVG. */

export interface Palette {
  /** deepest background (bottom of the radial scene) */
  bg: string;
  /** lighter top of the radial scene */
  bg2: string;
  surface: string;
  surface2: string;
  primary: string;
  primarySoft: string;
  gold: string;
  goldSoft: string;
  text: string;
  textDim: string;
  textFaint: string;
  border: string;
  /** stroke colour for the faint geometric pattern */
  pattern: string;
  /** true for light (parchment) themes — the renderer flips the glass fill/border to
   *  dark-on-light so the cards read correctly over a bright background */
  light?: boolean;
}

export interface ThemePreset {
  id: string;
  label: string;
  palette: Palette;
}

export const THEMES: ThemePreset[] = [
  {
    id: 'emerald',
    label: 'Emerald (calm green)',
    palette: {
      bg: '#0e1814', bg2: '#16271f', surface: '#1a2a24', surface2: '#20342c',
      primary: '#1fa37a', primarySoft: '#2bbf90', gold: '#d4af37', goldSoft: '#e6c768',
      text: '#eaf3ee', textDim: '#9db5aa', textFaint: '#5f786d',
      border: 'rgba(255,255,255,0.06)', pattern: '#1fa37a',
    },
  },
  {
    id: 'light',
    label: 'Parchment (light)',
    palette: {
      bg: '#e7eae1', bg2: '#f3f5ee', surface: '#ffffff', surface2: '#f6f8f2',
      primary: '#1fa37a', primarySoft: '#15805c', gold: '#b8860b', goldSoft: '#9c7209',
      text: '#233028', textDim: '#5a6b62', textFaint: '#8c988f',
      border: 'rgba(30,50,40,0.12)', pattern: '#8a8266', light: true,
    },
  },
  {
    id: 'cyan',
    label: 'OpenMasjid Cyan',
    palette: {
      bg: '#030D1A', bg2: '#0c3a4d', surface: '#0F2040', surface2: '#14284d',
      primary: '#22D3EE', primarySoft: '#67E8F9', gold: '#F59E0B', goldSoft: '#fbbf24',
      text: '#F4F7FB', textDim: '#9FACC2', textFaint: '#5C6B83',
      border: 'rgba(148,175,210,0.14)', pattern: '#22D3EE',
    },
  },
  {
    id: 'ocean',
    label: 'Ocean blue',
    palette: {
      bg: '#04101f', bg2: '#0e4f8a', surface: '#0a2750', surface2: '#103366',
      primary: '#38bdf8', primarySoft: '#7dd3fc', gold: '#2dd4bf', goldSoft: '#5eead4',
      text: '#eef6ff', textDim: '#9db4cf', textFaint: '#5b7396',
      border: 'rgba(148,175,210,0.14)', pattern: '#38bdf8',
    },
  },
  {
    id: 'twilight',
    label: 'Twilight purple',
    palette: {
      bg: '#0a0618', bg2: '#3a1d6e', surface: '#241048', surface2: '#2f1659',
      primary: '#c084fc', primarySoft: '#d8b4fe', gold: '#f0abfc', goldSoft: '#f5d0fe',
      text: '#f3eefb', textDim: '#b3a3cf', textFaint: '#6f5f96',
      border: 'rgba(190,175,210,0.14)', pattern: '#c084fc',
    },
  },
  {
    id: 'berry',
    label: 'Berry',
    palette: {
      bg: '#1a0518', bg2: '#6d1a50', surface: '#3a1133', surface2: '#4a1641',
      primary: '#f472b6', primarySoft: '#f9a8d4', gold: '#fb7185', goldSoft: '#fda4af',
      text: '#fbeef6', textDim: '#cf9db8', textFaint: '#965f7c',
      border: 'rgba(210,175,195,0.14)', pattern: '#f472b6',
    },
  },
  {
    id: 'sunset',
    label: 'Sunset',
    palette: {
      bg: '#190d08', bg2: '#8a3a1f', surface: '#3a1f12', surface2: '#4a2818',
      primary: '#fb923c', primarySoft: '#fdba74', gold: '#facc15', goldSoft: '#fde047',
      text: '#fdf2e9', textDim: '#cfae9d', textFaint: '#96755f',
      border: 'rgba(210,190,175,0.14)', pattern: '#fb923c',
    },
  },
  {
    id: 'forest',
    label: 'Forest',
    palette: {
      bg: '#04140e', bg2: '#15543a', surface: '#0f3324', surface2: '#15402e',
      primary: '#4ade80', primarySoft: '#86efac', gold: '#a3e635', goldSoft: '#bef264',
      text: '#eafaf0', textDim: '#9dcfb2', textFaint: '#5f967c',
      border: 'rgba(175,210,190,0.14)', pattern: '#4ade80',
    },
  },
  {
    id: 'night',
    label: 'Midnight blue',
    palette: {
      bg: '#02060f', bg2: '#1b2f63', surface: '#0c1838', surface2: '#122047',
      primary: '#60a5fa', primarySoft: '#93c5fd', gold: '#fcd34d', goldSoft: '#fde68a',
      text: '#eef2fb', textDim: '#9da9cf', textFaint: '#5f6b96',
      border: 'rgba(148,165,210,0.14)', pattern: '#60a5fa',
    },
  },
  {
    id: 'graphite',
    label: 'Graphite (neutral)',
    palette: {
      bg: '#0b0f17', bg2: '#2a3340', surface: '#161c27', surface2: '#1f2733',
      primary: '#94a3b8', primarySoft: '#cbd5e1', gold: '#eab308', goldSoft: '#facc15',
      text: '#f1f5f9', textDim: '#9aa6b6', textFaint: '#5f6b7c',
      border: 'rgba(180,190,205,0.12)', pattern: '#94a3b8',
    },
  },
];

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

/** Lighten a #rrggbb hex by mixing toward white by `amt` (0..1). */
function lighten(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const mix = (c: number) => Math.round(c + (255 - c) * amt);
  return `#${((1 << 24) | (mix(r) << 16) | (mix(g) << 8) | mix(b)).toString(16).slice(1)}`;
}

/** Resolve a palette by theme id, optionally overriding the primary colour. */
/** Normalise a "#rrggbb" (or "rrggbb") hex, or null if it isn't one. */
function hex6(c: string | undefined): string | null {
  if (!c || !/^#?[0-9a-f]{6}$/i.test(c.trim())) return null;
  const t = c.trim();
  return t.startsWith('#') ? t : `#${t}`;
}

export function getPalette(themeId: string, accent?: string, gold?: string): Palette {
  const base = (BY_ID.get(themeId) ?? THEMES[0]).palette;
  let p = base;
  const a = hex6(accent);
  if (a) p = { ...p, primary: a, primarySoft: lighten(a, 0.25), pattern: a };
  const g = hex6(gold);
  if (g) p = { ...p, gold: g, goldSoft: lighten(g, 0.25) };
  return p;
}
