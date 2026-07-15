// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAppState } from './state';
import { api } from './api';
import { usePrefs, prefsStore, resolveTheme, useOmosAppearanceSync, useReadableTheme } from './prefs';
import {
  ToastProvider,
  MasjidMark,
  IconScreen,
  IconClock,
  IconCamera,
  IconCalendar,
  IconCog,
  IconMoon,
  IconSun,
  IconPower,
  IconUser,
  Spinner,
} from './ui';

declare const __APP_VERSION__: string;
import type { AppState } from './types';
import { Screens } from './routes/Screens';
import { Timetables, TimetableEditor } from './routes/Timetables';
import { Sources } from './routes/Sources';
import { Schedules } from './routes/Schedules';
import { SettingsPage } from './routes/Settings';

type Tab = 'screens' | 'timetables' | 'sources' | 'schedules' | 'settings';

const TABS: { id: Tab; label: string; Icon: (p: { size?: number }) => JSX.Element }[] = [
  { id: 'screens', label: 'Screens', Icon: IconScreen },
  { id: 'timetables', label: 'Timetables', Icon: IconClock },
  { id: 'sources', label: 'Sources', Icon: IconCamera },
  { id: 'schedules', label: 'Schedule', Icon: IconCalendar },
  { id: 'settings', label: 'Settings', Icon: IconCog },
];

export function App() {
  return (
    <ToastProvider>
      <Root />
    </ToastProvider>
  );
}

/** Full-page timetable editor, opened in its own browser tab via `?edit=<id>`. */
function EditorPage({ id, state, refetch }: { id: string; state: AppState; refetch: () => Promise<void> }) {
  const tt = state.timetables.find((t) => t.id === id) ?? null;
  const close = () => {
    window.close();
    window.location.href = window.location.pathname; // fallback if the tab can't self-close
  };
  return (
    <>
      <Scene />
      {tt ? (
        <TimetableEditor state={state} tt={tt} fullPage onClose={close} onSaved={refetch} />
      ) : (
        <div className="editor-page">
          <div className="editor-bar glass-raised">
            <b className="editor-title">Timetable not found</b>
            <span className="spacer" />
            <button className="btn btn--primary" onClick={close}>Close</button>
          </div>
        </div>
      )}
    </>
  );
}

function Root() {
  const { state, authed, hasPassword, ssoEnabled, ssoReachable, loading, refetch, onAuthed } = useAppState();
  const [tab, setTab] = useState<Tab>('screens');
  const [setupInstead, setSetupInstead] = useState(false);
  const editId = new URLSearchParams(window.location.search).get('edit');

  // On-scene text colour follows the WALLPAPER (not the light/dark toggle): the built-in
  // presets are dark → light on-scene text in both themes; a light custom wallpaper image
  // flips data-scene to "light" so the on-scene text (brand, clock, page heading) goes
  // dark. Glass-card text stays under the theme's control. Matches the sibling apps.
  const prefs = usePrefs();
  const sceneTone = useReadableTheme(prefs.wallpaperImage.trim() || undefined, 'dark');
  useEffect(() => {
    const html = document.documentElement;
    if (sceneTone === 'light') html.setAttribute('data-scene', 'light');
    else html.removeAttribute('data-scene');
  }, [sceneTone]);

  if (authed) {
    if (!state) return <Splash />;
    if (editId) return <EditorPage id={editId} state={state} refetch={refetch} />;
    return <Shell state={state} refetch={refetch} tab={tab} setTab={setTab} />;
  }
  if (loading) return <Splash />;
  // Not signed in. Standalone first run (or a chosen fallback) → create a password.
  if (!hasPassword && (setupInstead || !ssoEnabled)) return <Setup onDone={onAuthed} />;
  return (
    <Login
      onDone={onAuthed}
      ssoEnabled={ssoEnabled}
      ssoReachable={ssoReachable}
      hasPassword={hasPassword}
      onSetupInstead={!hasPassword ? () => setSetupInstead(true) : undefined}
    />
  );
}

function Scene() {
  const prefs = usePrefs();
  const v = prefs.wallpaperImage.trim();
  // Accept http(s) and data:image URLs; reject only characters that could break out
  // of url("…") (quotes, backslash, whitespace) — this is the whole backdrop.
  const safe = /^(https?:\/\/|data:image\/)/i.test(v) && !/["\\\s]/.test(v) ? v : '';
  if (safe) {
    // A standalone layer with NO preset gradient/aurora/pattern behind it, so a
    // custom wallpaper fully replaces the built-in one (never overlaid on top).
    return <div className="scene-img" aria-hidden="true" style={{ backgroundImage: `url("${safe}")` }} />;
  }
  return <div className="scene" aria-hidden="true" />;
}

function Splash() {
  return (
    <div className="auth-wrap">
      <Scene />
      <div className="row" style={{ gap: '0.75rem', color: 'var(--color-primary)' }}>
        <Spinner /> <span className="muted">Loading…</span>
      </div>
    </div>
  );
}

function Dock({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  return (
    <div className="dock-wrap">
      <nav className="dock glass-raised" aria-label="Sections">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`nav-item${tab === id ? ' is-active' : ''}`}
            onClick={() => setTab(id)}
            aria-current={tab === id ? 'page' : undefined}
            aria-label={label}
            title={label}
          >
            <Icon size={20} />
          </button>
        ))}
      </nav>
    </div>
  );
}

/** Live wall clock for the top-left of the dashboard (time + date), like the
 *  OpenMasjidOS / OpenMasjidDonations header clock. */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const iv = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(iv);
  }, []);
  const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const date = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return (
    <div className="topclock" aria-label={`${time}, ${date}`}>
      <span className="topclock-time">{time}</span>
      <span className="topclock-date">{date}</span>
    </div>
  );
}

/** Top-right account menu — theme, settings, version and sign-out (like the
 *  OpenMasjidOS dashboard's profile button). */
function ProfileMenu({
  dark,
  onToggleTheme,
  onSettings,
  onLogout,
}: {
  dark: boolean;
  onToggleTheme: () => void;
  onSettings: () => void;
  onLogout?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="profile" ref={ref}>
      <button
        className="profile-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        <IconUser size={18} />
      </button>
      {open && (
        <div className="profile-menu glass-raised" role="menu">
          <button className="menu-item" role="menuitem" onClick={onToggleTheme}>
            {dark ? <IconSun size={17} /> : <IconMoon size={17} />}
            <span>{dark ? 'Light mode' : 'Dark mode'}</span>
          </button>
          <button className="menu-item" role="menuitem" onClick={() => { onSettings(); setOpen(false); }}>
            <IconCog size={17} />
            <span>Settings</span>
          </button>
          {onLogout && (
            <button className="menu-item" role="menuitem" onClick={onLogout}>
              <IconPower size={17} />
              <span>Sign out</span>
            </button>
          )}
          <div className="menu-sep" aria-hidden="true" />
          <div className="menu-version">
            OpenMasjid Display v{__APP_VERSION__}
            {' · '}
            {/* AGPL-3.0 §13: offer the running version's source to every operator. */}
            <a
              href={`https://github.com/OpenMasjid-Solutions/OpenMasjidDisplay/tree/v${__APP_VERSION__}`}
              target="_blank"
              rel="noreferrer"
              className="menu-source-link"
            >
              Source code (AGPL-3.0)
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function Shell({
  state,
  refetch,
  tab,
  setTab,
}: {
  state: AppState;
  refetch: () => Promise<void>;
  tab: Tab;
  setTab: (t: Tab) => void;
}) {
  const prefs = usePrefs();
  useOmosAppearanceSync(state.omosBase);
  const dark = resolveTheme(prefs.theme) === 'dark';
  // A manual toggle is an explicit choice → stop mirroring OpenMasjidOS.
  const toggleTheme = () => prefsStore.patch({ theme: dark ? 'light' : 'dark', followOmos: false });
  const logout = async () => {
    try {
      await api.logout();
    } finally {
      location.reload();
    }
  };

  return (
    <div className="shell">
      <Scene />
      <header className="topbar">
        <a className="brand" href="/" aria-label="OpenMasjid Display — home">
          <MasjidMark size={22} />
          <b>OpenMasjid&nbsp;Display</b>
        </a>
        <div className="spacer" />
        <Clock />
        <ProfileMenu
          dark={dark}
          onToggleTheme={toggleTheme}
          onSettings={() => setTab('settings')}
          onLogout={state.authRequired ? logout : undefined}
        />
      </header>

      <main className="main">
        {tab === 'screens' && <Screens state={state} refetch={refetch} />}
        {tab === 'timetables' && <Timetables state={state} refetch={refetch} />}
        {tab === 'sources' && <Sources state={state} refetch={refetch} />}
        {tab === 'schedules' && <Schedules state={state} refetch={refetch} />}
        {tab === 'settings' && <SettingsPage state={state} refetch={refetch} />}
      </main>

      <Dock tab={tab} setTab={setTab} />
    </div>
  );
}

function Login({
  onDone,
  ssoEnabled,
  ssoReachable,
  hasPassword,
  onSetupInstead,
}: {
  onDone: () => void;
  ssoEnabled: boolean;
  ssoReachable: boolean;
  hasPassword: boolean;
  onSetupInstead?: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Under OpenMasjidOS with no local password: normally there's nothing to type —
  // open the app from the dashboard (which carries the platform session). But if the
  // platform is unreachable (a restore onto a new box, OS briefly down), SSO can't
  // complete — so guide the admin to the always-available local-password recovery
  // instead of letting "continue" loop silently.
  if (ssoEnabled && !hasPassword) {
    const unreachable = !ssoReachable;
    return (
      <div className="auth-wrap">
        <Scene />
        <div className="auth-card glass-raised">
          <div className="auth-logo"><MasjidMark size={44} /></div>
          <h1 className="page-title" style={{ textAlign: 'center' }}>OpenMasjid Display</h1>
          {unreachable ? (
            <p className="page-sub" style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
              Can’t reach OpenMasjidOS right now, so automatic sign-in isn’t available.
              Try again in a moment, or set a password to get in.
            </p>
          ) : (
            <p className="page-sub" style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
              This panel uses your OpenMasjidOS sign-in. Open it from your OpenMasjidOS
              dashboard to continue.
            </p>
          )}
          {unreachable ? (
            <>
              {onSetupInstead && (
                <button className="btn btn--primary btn--block" onClick={onSetupInstead}>
                  Set a password to get in
                </button>
              )}
              <button
                type="button"
                className="btn btn--ghost btn--block"
                style={{ marginTop: '0.6rem' }}
                onClick={onDone}
              >
                Retry sign-in
              </button>
            </>
          ) : (
            <>
              <button className="btn btn--primary btn--block" onClick={onDone}>
                I’ve signed in — continue
              </button>
              {onSetupInstead && (
                <button
                  type="button"
                  className="btn btn--ghost btn--block"
                  style={{ marginTop: '0.6rem' }}
                  onClick={onSetupInstead}
                >
                  Set a password instead
                </button>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.');
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <Scene />
      <form className="auth-card glass-raised" onSubmit={submit}>
        <div className="auth-logo"><MasjidMark size={44} /></div>
        <h1 className="page-title" style={{ textAlign: 'center' }}>OpenMasjid Display</h1>
        <p className="page-sub" style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
          Enter the control-panel password to continue.
        </p>
        <input
          className="input"
          type="password"
          autoFocus
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="form-error">{error}</div>}
        <button className="btn btn--primary btn--block" style={{ marginTop: '0.8rem' }} disabled={busy}>
          {busy ? <Spinner /> : 'Sign in'}
        </button>
        {ssoEnabled && (
          <p className="hint" style={{ textAlign: 'center', marginBlockStart: '0.8rem' }}>
            Tip: open this app from your OpenMasjidOS dashboard to sign in automatically.
          </p>
        )}
      </form>
    </div>
  );
}

function Setup({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 4) {
      setError('Please use at least 4 characters.');
      return;
    }
    if (password !== confirm) {
      setError('The two passwords don’t match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.setup(password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not finish setup.');
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <Scene />
      <form className="auth-card glass-raised" onSubmit={submit}>
        <div className="auth-logo"><MasjidMark size={44} /></div>
        <h1 className="page-title" style={{ textAlign: 'center' }}>Welcome</h1>
        <p className="page-sub" style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
          Create a password for your control panel. You'll set everything else up inside.
        </p>
        <input
          className="input"
          type="password"
          autoFocus
          placeholder="Choose a password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ marginBottom: '0.6rem' }}
        />
        <input
          className="input"
          type="password"
          placeholder="Confirm password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {error && <div className="form-error">{error}</div>}
        <button className="btn btn--primary btn--block" style={{ marginTop: '0.8rem' }} disabled={busy}>
          {busy ? <Spinner /> : 'Create & continue'}
        </button>
      </form>
    </div>
  );
}
