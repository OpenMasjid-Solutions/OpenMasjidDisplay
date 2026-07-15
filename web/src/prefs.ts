// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Per-browser presentation preferences (theme + wallpaper), persisted in
 * localStorage and applied live. This is NOT masjid config — it mirrors how
 * OpenMasjidOS treats appearance, so the panel can follow the viewer's OS
 * light/dark setting and, when running under OpenMasjidOS, inherit the
 * dashboard's theme + wallpaper via the OpenMasjidOS Fabric (the appearance half
 * of the platform↔app layer). See docs/FABRIC.md.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

export interface Prefs {
  theme: 'system' | 'dark' | 'light';
  wallpaper: string;
  /** Optional custom wallpaper image URL — overrides the preset when set. */
  wallpaperImage: string;
  /** Mirror OpenMasjidOS's theme + wallpaper (on by default under the platform). */
  followOmos: boolean;
}

const KEY = 'omd-prefs';
const DEFAULTS: Prefs = { theme: 'system', wallpaper: 'aurora', wallpaperImage: '', followOmos: true };

export const WALLPAPERS: Record<string, { label: string; preview: string }> = {
  aurora: { label: 'Aurora', preview: 'radial-gradient(circle at 30% 25%, #22D3EE, #0A1828 70%)' },
  ocean: { label: 'Ocean', preview: 'linear-gradient(150deg, #38BDF8, #2563EB 55%, #0a1838 100%)' },
  twilight: { label: 'Twilight', preview: 'linear-gradient(150deg, #C084FC, #7C3AED 55%, #0a0618 100%)' },
  berry: { label: 'Berry', preview: 'linear-gradient(150deg, #F472B6, #A21CAF 55%, #1a0518 100%)' },
  sunset: { label: 'Sunset', preview: 'linear-gradient(150deg, #FBBF24, #FB7185 55%, #1a0d08 100%)' },
  ember: { label: 'Ember', preview: 'linear-gradient(150deg, #FB923C, #DC2626 55%, #190806 100%)' },
  forest: { label: 'Forest', preview: 'linear-gradient(150deg, #4ADE80, #15803D 55%, #04140e 100%)' },
  night: { label: 'Night', preview: 'linear-gradient(150deg, #60A5FA, #1E3A8A 55%, #02060f 100%)' },
  graphite: { label: 'Graphite', preview: 'linear-gradient(150deg, #64748B, #334155 55%, #0b0f17 100%)' },
};

export function resolveTheme(theme: Prefs['theme']): 'dark' | 'light' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return theme;
}

export function applyTheme(theme: Prefs['theme']): void {
  document.documentElement.setAttribute('data-theme', resolveTheme(theme));
}

export function applyWallpaper(id: string): void {
  document.documentElement.setAttribute('data-wallpaper', WALLPAPERS[id] ? id : 'aurora');
}

const THEME_VALUES = ['system', 'dark', 'light'] as const;
function normTheme(v: unknown): Prefs['theme'] {
  return (THEME_VALUES as readonly string[]).includes(String(v)) ? (v as Prefs['theme']) : 'system';
}

/** Appearance handed over by OpenMasjidOS — we use theme + wallpaper only. */
interface OmosAppearance {
  theme?: string;
  wallpaper?: string;
  wallpaperImage?: string;
}

function appearancePatch(p: OmosAppearance): Partial<Prefs> {
  const out: Partial<Prefs> = {};
  if (p.theme != null) out.theme = normTheme(p.theme);
  if (typeof p.wallpaper === 'string') out.wallpaper = p.wallpaper;
  if (typeof p.wallpaperImage === 'string') out.wallpaperImage = p.wallpaperImage;
  return out;
}

/** Read the `#omos=…` appearance fragment OpenMasjidOS adds when it opens us
 *  (base64url JSON). Applied once, then the hash is cleared. */
function readOmosFragment(): OmosAppearance | null {
  const m = location.hash.match(/omos=([^&]+)/);
  if (!m) return null;
  try {
    let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const p = JSON.parse(new TextDecoder().decode(bytes)) as OmosAppearance;
    history.replaceState(null, '', location.pathname + location.search);
    return p;
  } catch {
    return null;
  }
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

let state: Prefs = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode — just won't persist */
  }
}

export const prefsStore = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  patch(part: Partial<Prefs>) {
    state = { ...state, ...part };
    persist();
    if (part.theme !== undefined) applyTheme(state.theme);
    if (part.wallpaper !== undefined) applyWallpaper(state.wallpaper);
    for (const l of listeners) l();
  },
  /** Apply persisted prefs on first load, inherit any OpenMasjidOS hand-off, and
   *  follow OS theme changes live. */
  hydrate() {
    const omos = readOmosFragment();
    if (omos) {
      // Opened from OpenMasjidOS → adopt its look and (re)enable following.
      state = { ...state, ...appearancePatch(omos), followOmos: true };
      persist();
    }
    applyTheme(state.theme);
    applyWallpaper(state.wallpaper);
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (state.theme === 'system') applyTheme('system');
    });
  },
};

export function usePrefs(): Prefs {
  return useSyncExternalStore(prefsStore.subscribe, prefsStore.get, prefsStore.get);
}

/** One-shot pull of OpenMasjidOS's current appearance (the A2 endpoint). */
export async function fetchOmosAppearance(omosBase: string): Promise<void> {
  if (!omosBase) return;
  try {
    const res = await fetch(`${omosBase}/api/public/appearance`, { credentials: 'omit' });
    if (!res.ok) return;
    if (!prefsStore.get().followOmos) return;
    prefsStore.patch(appearancePatch((await res.json()) as OmosAppearance));
  } catch {
    /* platform offline or cross-origin blocked — keep the current look */
  }
}

// ── Background-aware readability ──────────────────────────────────────────────
// Sample a background image's average luminance so text on top of it stays readable
// (dark text on light images, light text on dark). Works for same-origin / CORS-enabled
// images and data: URLs; if the canvas is tainted (host sent no CORS header) we can't
// read the pixels, so we fall back to the caller's default theme.
const lumCache = new Map<string, 'light' | 'dark'>();

function sampleLuminance(url: string): Promise<'light' | 'dark' | null> {
  const cached = lumCache.get(url);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const n = 16;
        const canvas = document.createElement('canvas');
        canvas.width = n;
        canvas.height = n;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, n, n);
        const { data } = ctx.getImageData(0, 0, n, n);
        let sum = 0;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          count++;
        }
        const avg = count ? sum / count : 0; // 0..255
        const res: 'light' | 'dark' = avg > 140 ? 'light' : 'dark';
        lumCache.set(url, res);
        resolve(res);
      } catch {
        resolve(null); // tainted canvas — image host sent no CORS header
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** The theme ('light'|'dark') that reads best over a background image. Returns
 *  `fallback` when there's no image or it can't be sampled (cross-origin). */
export function useReadableTheme(imageUrl: string | undefined, fallback: 'light' | 'dark'): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(fallback);
  useEffect(() => {
    if (!imageUrl) {
      setTheme(fallback);
      return;
    }
    let live = true;
    void sampleLuminance(imageUrl).then((r) => {
      if (live) setTheme(r ?? fallback);
    });
    return () => {
      live = false;
    };
  }, [imageUrl, fallback]);
  return theme;
}

/** While "follow OpenMasjidOS" is on, keep theme + wallpaper in sync with the
 *  dashboard (poll periodically and whenever the panel regains focus). */
export function useOmosAppearanceSync(omosBase: string | undefined): void {
  const { followOmos } = usePrefs();
  useEffect(() => {
    if (!omosBase || !followOmos) return;
    void fetchOmosAppearance(omosBase);
    const iv = window.setInterval(() => void fetchOmosAppearance(omosBase), 45_000);
    const onFocus = () => void fetchOmosAppearance(omosBase);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener('focus', onFocus);
    };
  }, [omosBase, followOmos]);
}
