// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AppState, Settings } from '../types';
import { Field, Toggle, Spinner, IconCheck, useToast } from '../ui';
import { usePrefs, prefsStore, WALLPAPERS, fetchOmosAppearance } from '../prefs';
import { timezoneOptions } from '../timezones';

interface Props {
  state: AppState;
  refetch: () => Promise<void>;
}

export function SettingsPage({ state, refetch }: Props) {
  const toast = useToast();
  const prefs = usePrefs();
  const [quality, setQuality] = useState<Settings['defaultQuality']>(state.settings.defaultQuality);
  const [tz, setTz] = useState(state.settings.scheduleTimezone);
  const [busy, setBusy] = useState(false);

  // Only "follow" when we actually run under OpenMasjidOS (there's a base URL).
  const canFollow = !!state.omosBase;
  const following = canFollow && prefs.followOmos;

  const save = async () => {
    setBusy(true);
    try {
      await api.saveSettings({ defaultQuality: quality, scheduleTimezone: tz.trim() });
      await refetch();
      toast('Settings saved.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Settings</h1>
        <p className="page-sub">Defaults and appearance for this control panel.</p>
      </div>

      <div className="panel glass">
        <h3 className="section-title" style={{ marginTop: 0 }}>Defaults</h3>
        <div className="grid2">
          <Field label="Default picture quality" hint="Used for new timetables. 720p is best for a Raspberry Pi.">
            <select className="select" value={quality} onChange={(e) => setQuality(e.target.value as Settings['defaultQuality'])}>
              <option value="720p">720p</option>
              <option value="1080p">1080p (Full HD)</option>
            </select>
          </Field>
          <Field label="Schedule time zone" hint="Used to run schedule rules.">
            <select className="select" value={tz} onChange={(e) => setTz(e.target.value)}>
              {timezoneOptions(tz).map((z) => <option key={z.id || 'server'} value={z.id}>{z.label}</option>)}
            </select>
          </Field>
        </div>
      </div>

      <div className="panel glass">
        <h3 className="section-title" style={{ marginTop: 0 }}>Appearance</h3>
        <p className="muted" style={{ marginBottom: '1rem' }}>
          {canFollow
            ? 'Saved on this device. It can follow your OpenMasjidOS light/dark theme and wallpaper automatically.'
            : "Saved on this device. The theme can follow your device's light/dark setting."}
        </p>

        {canFollow && (
          <Field label="Appearance source">
            <div className="chips">
              <button
                type="button"
                className={`chip${following ? ' is-active' : ''}`}
                onClick={() => {
                  prefsStore.patch({ followOmos: true });
                  void fetchOmosAppearance(state.omosBase);
                }}
              >
                Match OpenMasjidOS
              </button>
              <button
                type="button"
                className={`chip${!following ? ' is-active' : ''}`}
                onClick={() => prefsStore.patch({ followOmos: false })}
              >
                Choose my own
              </button>
            </div>
          </Field>
        )}

        {following ? (
          <p className="hint">
            Following your OpenMasjidOS theme and wallpaper. Choose “Choose my own” to set them here instead.
          </p>
        ) : (
          <>
            <Field label="Theme">
              <div className="chips">
                {(['system', 'light', 'dark'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`chip${prefs.theme === t ? ' is-active' : ''}`}
                    onClick={() => prefsStore.patch({ theme: t, followOmos: false })}
                  >
                    {t === 'system' ? 'Match device' : t === 'light' ? 'Light' : 'Dark'}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Wallpaper" hint="Pick the same one you use in OpenMasjidOS.">
              <div className="wallpaper-row">
                {Object.entries(WALLPAPERS).map(([id, w]) => (
                  <button
                    key={id}
                    type="button"
                    title={w.label}
                    className={`wallpaper${prefs.wallpaper === id && !prefs.wallpaperImage ? ' is-active' : ''}`}
                    style={{ background: w.preview }}
                    onClick={() => prefsStore.patch({ wallpaper: id, wallpaperImage: '', followOmos: false })}
                  />
                ))}
              </div>
            </Field>
            <Field label="Custom wallpaper image URL (optional)" hint="Paste the same image URL you use in OpenMasjidOS; leave blank to use a preset.">
              <input
                className="input"
                value={prefs.wallpaperImage}
                onChange={(e) => prefsStore.patch({ wallpaperImage: e.target.value, followOmos: false })}
                placeholder="https://…/wallpaper.jpg"
              />
            </Field>
          </>
        )}
      </div>

      <VolunteerPanel state={state} refetch={refetch} />

      <NotificationsPanel />

      <div className="panel glass">
        <h3 className="section-title" style={{ marginTop: 0 }}>Connecting a screen</h3>
        <p className="muted" style={{ marginBottom: '1rem' }}>
          Each screen's link uses the address you opened this panel with — there's nothing to configure.
        </p>
        <ol className="muted" style={{ paddingInlineStart: '1.2rem', lineHeight: 1.7, margin: 0 }}>
          <li>On the <b>Screens</b> page, add a screen and copy its link.</li>
          <li>In your TV's RTSP decoder, paste the link and set the transport to <b>TCP</b>.</li>
          <li>Pick what the screen shows — a timetable, a camera, or an HDMI source.</li>
        </ol>
      </div>

      <button className="btn btn--primary" onClick={save} disabled={busy}><IconCheck size={16} /> Save settings</button>
    </div>
  );
}

type NotifyTest = { baseUrlSet: boolean; hasSecret: boolean; baseUrlLoopback: boolean; baseUrl: string; appId: string; delivered: boolean; reason?: string };

/** Map a notify-test result to one clear, friendly sentence + ok/err. */
function notifyAdvice(r: NotifyTest): { ok: boolean; msg: string } {
  if (r.delivered) return { ok: true, msg: 'Sent! Check your Slack / Discord / webhook for the test message.' };
  if (!r.baseUrlSet || !r.hasSecret)
    return { ok: false, msg: 'This app hasn’t received its OpenMasjidOS credentials yet. First update OpenMasjidOS itself to the latest version, then update OpenMasjid Display from the dashboard (or remove and reinstall it) — that’s what grants it permission to send alerts.' };
  if (r.baseUrlLoopback)
    return { ok: false, msg: 'The platform address is set to “localhost”, which this app can’t reach from its own container. On the OpenMasjidOS side, set OPENMASJID_BASE_URL to the server’s network address.' };
  if (r.reason === 'disabled')
    return { ok: false, msg: 'OpenMasjidOS notifications aren’t turned on. In OpenMasjidOS → Settings → Notifications, add a Slack / Discord / webhook destination.' };
  if (r.reason === 'http_403')
    return { ok: false, msg: 'OpenMasjidOS hasn’t granted this app permission to send notifications. Update or reinstall OpenMasjid Display in OpenMasjidOS so it re-reads its permissions.' };
  if (r.reason === 'rate_limited') return { ok: false, msg: 'Too many messages just now — wait a minute and try again.' };
  if (r.reason === 'unreachable')
    return { ok: false, msg: 'Couldn’t reach OpenMasjidOS from this app. Check they’re on the same network and the platform is running.' };
  return { ok: false, msg: `Couldn’t send (reason: ${r.reason ?? 'unknown'}).` };
}

/** Diagnose Fabric notifications — alerts (e.g. a screen going offline) relay through
 *  OpenMasjidOS to the masjid's configured webhook; this sends a test and explains. */
function NotificationsPanel() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [advice, setAdvice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [detail, setDetail] = useState<NotifyTest | null>(null);

  const test = async () => {
    setBusy(true);
    setAdvice(null);
    setDetail(null);
    try {
      const r = await api.testNotification();
      setDetail(r);
      setAdvice(notifyAdvice(r));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not run the test.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel glass">
      <h3 className="section-title" style={{ marginTop: 0 }}>Notifications</h3>
      <p className="muted" style={{ marginBottom: '1rem' }}>
        OpenMasjid Display alerts you when a screen stops pulling its video stream (and again when it’s back) —
        no setup needed. The message is sent through OpenMasjidOS to the webhook you set in
        <b> OpenMasjidOS → Settings → Notifications</b> (Slack, Discord, or a custom URL).
      </p>
      <div className="row" style={{ gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn--ghost btn--sm" onClick={test} disabled={busy}>{busy ? <><Spinner /> Sending…</> : 'Send a test notification'}</button>
        {advice && (
          <span className="hint" style={{ color: advice.ok ? 'var(--ok, #2bbf90)' : 'var(--danger, #e5736b)', maxWidth: 560 }}>
            {advice.ok ? '✓ ' : '✗ '}{advice.msg}
          </span>
        )}
      </div>
      {detail && (
        <div className="hint" style={{ marginBlockStart: '0.6rem', fontFamily: 'monospace', fontSize: '0.82rem', opacity: 0.85, lineHeight: 1.6 }}>
          What OpenMasjidOS gave this app:<br />
          • Platform URL: {detail.baseUrl || '(not set)'}<br />
          • App ID: {detail.appId || '(not set)'}<br />
          • App secret: {detail.hasSecret ? 'present' : 'missing'}
          {detail.reason ? <> · relay reason: {detail.reason}</> : null}
        </div>
      )}
    </div>
  );
}

/** Turn the simple mobile volunteer page on/off and set its 4-digit PIN. */
function VolunteerPanel({ state, refetch }: Props) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(state.settings.volunteerEnabled);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const pinSet = state.volunteer.pinSet;
  const volUrl = `http://${window.location.hostname}:${state.volunteer.port}`;
  // Public address behind the OS remote-access tunnel (the volunteer page now rides the main
  // port under /volunteer). Empty unless remote access is on.
  const [publicUrl, setPublicUrl] = useState('');
  const [remote, setRemote] = useState(state.settings.volunteerRemote);
  const loadInfo = () => api.volunteerInfo().then((r) => setPublicUrl(r.publicUrl)).catch(() => setPublicUrl(''));
  useEffect(() => { void loadInfo(); }, []);

  const save = async (nextEnabled: boolean) => {
    setBusy(true);
    try {
      // Only send the PIN if the admin typed a new one.
      const pinArg = pin.trim() === '' ? undefined : pin.trim();
      await api.saveVolunteerConfig(nextEnabled, pinArg);
      setEnabled(nextEnabled);
      setPin('');
      await refetch();
      toast('Volunteer page updated.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save.', 'error');
      setEnabled(state.settings.volunteerEnabled); // revert the toggle on failure
    } finally {
      setBusy(false);
    }
  };

  const saveRemote = async (v: boolean) => {
    setRemote(v); // optimistic
    try {
      await api.saveSettings({ volunteerRemote: v });
      await refetch();
      await loadInfo(); // the public URL is gated on this setting server-side
      toast(v ? 'Volunteer page is now reachable over remote access.' : 'Volunteer page is now local-network only.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save.', 'error');
      setRemote(state.settings.volunteerRemote); // revert on failure
    }
  };

  return (
    <div className="panel glass">
      <h3 className="section-title" style={{ marginTop: 0 }}>Volunteer page (mobile)</h3>
      <p className="muted" style={{ marginBottom: '1rem' }}>
        A bone-simple phone page for volunteers: unlock with a short PIN, see every screen, and switch what
        each one shows with a tap. It runs on its own address so you can share just that.
      </p>

      <div className="toggle-row row-between" style={{ marginBlockEnd: '0.9rem' }}>
        <span className="label" style={{ margin: 0 }}>
          Enable the volunteer page
          {!pinSet && <span className="hint"> — set a PIN first</span>}
        </span>
        <Toggle checked={enabled} onChange={(v) => save(v)} label="Enable the volunteer page" />
      </div>

      <div className="toggle-row row-between" style={{ marginBlockEnd: '0.9rem' }}>
        <span className="label" style={{ margin: 0 }}>
          Reachable over remote access
          <span className="hint"> — also serves it on the control-panel address so your OpenMasjidOS tunnel can reach it. Turn off to keep it on the local network only.</span>
        </span>
        <Toggle checked={remote} onChange={(v) => saveRemote(v)} label="Reachable over remote access" />
      </div>

      <div className="grid2">
        <Field label={pinSet ? 'Change PIN (4–8 digits)' : 'Set a PIN (4–8 digits)'} hint="Leave blank to keep the current PIN.">
          <input
            className="input"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            placeholder={pinSet ? '••••' : 'e.g. 1234'}
          />
        </Field>
        <Field label="Volunteer page address" hint="Open this on a phone on the same network. It also works at /volunteer on the control-panel address.">
          <input className="input" readOnly value={volUrl} onFocus={(e) => e.currentTarget.select()} />
        </Field>
      </div>

      {publicUrl && (
        <Field label="Public web address (remote access)" hint="Reachable over the internet through your OpenMasjidOS tunnel — volunteers can open it from anywhere. It's still PIN-protected.">
          <input className="input" readOnly value={publicUrl} onFocus={(e) => e.currentTarget.select()} />
        </Field>
      )}

      <button className="btn btn--primary" style={{ marginBlockStart: '0.4rem' }} onClick={() => save(enabled)} disabled={busy || (pin.trim() === '' && !pinSet)}>
        <IconCheck size={16} /> {pin.trim() ? 'Save PIN' : 'Save'}
      </button>
    </div>
  );
}
