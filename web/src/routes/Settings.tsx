// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AppState, Settings, WhatsAppStatus, WhatsAppReason, WhatsAppLogEntry } from '../types';
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

      <WhatsAppPanel state={state} refetch={refetch} />

      <BetaPanel state={state} refetch={refetch} />

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

/** The sentence to show when this masjid cannot send. Each `reason` has a different fix, and
 *  none of them are this app's to guess at — so each gets its own words and points at the
 *  place the admin actually has to go. */
const WA_REASON_TEXT: Record<WhatsAppReason, string> = {
  ready: '',
  'not-configured': 'WhatsApp isn’t set up on this server yet. An admin can add it in OpenMasjidOS → Settings → WhatsApp.',
  'not-linked': 'WhatsApp is set up, but no phone is linked yet. Link one in OpenMasjidOS → Settings → WhatsApp.',
  unreachable: 'The WhatsApp gateway isn’t responding. Check it in OpenMasjidOS → Settings → WhatsApp.',
  'not-allowed': 'OpenMasjidOS hasn’t allowed this app to send WhatsApp messages. Update OpenMasjid Display there, then reopen this page.',
  'no-fabric': 'This works only when OpenMasjid Display is running under OpenMasjidOS.',
};

/**
 * Post the "Iqāmah times are changing" notice to the masjid's WhatsApp group.
 *
 * The platform does the sending — we never see the gateway, its key or the linked number —
 * and it paces every message through one queue shared by every installed app, which is the
 * whole defence for the masjid's number. So this panel is only ever choosing *what*, *where*
 * and *how early*, and it says "queued" rather than "sent" everywhere, because that is all
 * anyone here actually knows.
 */
function WhatsAppPanel({ state, refetch }: Props) {
  const toast = useToast();
  const wa = state.settings.whatsapp;
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(wa.iqamahChange);
  const [groupId, setGroupId] = useState(wa.groupId);
  const [ttId, setTtId] = useState(wa.timetableId);
  const [daysBefore, setDaysBefore] = useState(wa.daysBefore);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setStatus(await api.whatsappStatus());
    } catch {
      // A failed lookup is indistinguishable to an admin from a gateway that is down, so say
      // the same thing rather than surfacing a request error they cannot act on.
      setStatus({ available: false, reason: 'unreachable', media: false, maxMediaBytes: 0, groups: [], preview: null, previewNote: null, log: [] });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const save = async () => {
    // Switching it on with nowhere to send is the one combination that looks configured and
    // silently does nothing, so it is refused rather than saved.
    if (enabled && !groupId) {
      toast('Choose a WhatsApp group first.', 'error');
      return;
    }
    setBusy(true);
    try {
      const label = status?.groups.find((g) => g.id === groupId)?.label ?? wa.groupLabel;
      await api.saveSettings({ whatsapp: { iqamahChange: enabled, groupId, groupLabel: groupId ? label : '', timetableId: ttId, daysBefore } });
      await refetch();
      await load();
      toast('WhatsApp settings saved.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const sendNow = async () => {
    setSending(true);
    try {
      const r = await api.whatsappSendNow();
      await load();
      toast(`${r.asImage ? 'Image' : 'Message'} queued. WhatsApp messages are paced, so it may take a few minutes to arrive.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not queue the message.', 'error');
    } finally {
      setSending(false);
    }
  };

  const groups = status?.groups ?? [];
  // Approval can be withdrawn in OpenMasjidOS at any time. If that happened to the group we
  // were using, keep naming it rather than showing a blank select — the admin needs to see
  // what is now missing, not an empty box.
  const chosenMissing = !!groupId && !groups.some((g) => g.id === groupId);

  return (
    <div className="panel glass">
      <h3 className="section-title" style={{ marginTop: 0 }}>WhatsApp</h3>
      <p className="muted" style={{ marginBottom: '1rem' }}>
        Post your <b>Iqāmah change notice</b> to a WhatsApp group automatically, a few days before it takes effect.
        The message is sent by OpenMasjidOS through the masjid’s own gateway — set it up in
        <b> OpenMasjidOS → Settings → WhatsApp</b>, and approve there which groups apps may post into.
      </p>

      {loading ? (
        <div className="hint"><Spinner /> Checking WhatsApp…</div>
      ) : !status?.available ? (
        <div className="hint" style={{ color: 'var(--color-warning)', maxWidth: 620 }}>
          {WA_REASON_TEXT[status?.reason ?? 'unreachable']}
        </div>
      ) : groups.length === 0 && !chosenMissing ? (
        <div className="hint" style={{ maxWidth: 620 }}>
          No groups have been approved for this app yet. In <b>OpenMasjidOS → Settings → WhatsApp → Groups</b>,
          press <b>Find my groups</b> and approve the one you want announcements posted to.
        </div>
      ) : (
        <>
          <div className="toggle-row row-between" style={{ marginBlockEnd: '0.9rem' }}>
            <span className="label" style={{ margin: 0 }}>Post the Iqāmah change to a group</span>
            <Toggle checked={enabled} onChange={setEnabled} label="Post the Iqamah change to a WhatsApp group" />
          </div>

          <div className="grid2">
            <Field label="Group" hint="Only groups an admin approved in OpenMasjidOS appear here.">
              <select className="select" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">Choose a group…</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                {chosenMissing && <option value={groupId}>{wa.groupLabel || groupId} (no longer approved)</option>}
              </select>
            </Field>

            <Field label="Timetable" hint="Whose Iqāmah changes to announce. One only — announcing from every timetable would send the same change several times.">
              <select className="select" value={ttId} onChange={(e) => setTtId(e.target.value)}>
                <option value="">{state.timetables[0]?.name ?? 'First timetable'} (default)</option>
                {state.timetables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>

            <Field label="When to post" hint="A change added later than this — even on the day — is posted within a minute of you saving it.">
              <select className="select" value={daysBefore} onChange={(e) => setDaysBefore(Number(e.target.value))}>
                <option value={0}>On the day it takes effect</option>
                {[1, 2, 3, 4, 5, 7, 10, 14].map((d) => (
                  <option key={d} value={d}>{d} day{d === 1 ? '' : 's'} before</option>
                ))}
              </select>
            </Field>
          </div>

          {chosenMissing && (
            <div className="hint" style={{ color: 'var(--color-warning)', marginBlockStart: '0.6rem', maxWidth: 620 }}>
              That group is no longer approved in OpenMasjidOS, so nothing can be posted to it. Approve it again there, or choose another.
            </div>
          )}

          <div className="row" style={{ gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap', marginBlockStart: '1rem' }}>
            <button className="btn btn--primary btn--sm" onClick={save} disabled={busy}>
              {busy ? <><Spinner /> Saving…</> : <><IconCheck size={16} /> Save WhatsApp settings</>}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={sendNow} disabled={sending || !wa.groupId || !status.preview}>
              {sending ? <><Spinner /> Queueing…</> : 'Send now'}
            </button>
            {status.preview && (
              <button className="btn btn--ghost btn--sm" onClick={() => setShowPreview((v) => !v)}>
                {showPreview ? 'Hide message' : status.media ? 'Show the caption' : 'Show the message'}
              </button>
            )}
          </div>

          <p className="hint" style={{ marginBlockStart: '0.6rem', maxWidth: 620 }}>
            {status.media ? (
              <>
                The <b>announcement image</b> is posted, with a short caption naming what changed — the same picture
                as the <i>Download announcement image</i> button on the Salah times tab.
              </>
            ) : (
              <>
                This version of OpenMasjidOS can’t send pictures over WhatsApp, so the notice goes as <b>text</b> —
                the same times, written out. Updating OpenMasjidOS will send the image instead.
              </>
            )}{' '}
            Messages are <b>queued, not sent</b>: OpenMasjidOS spaces them out to protect the masjid’s number, so
            delivery takes a few minutes, and longer inside the quiet hours set there. Each change is posted once
            automatically; use <b>Send now</b> if you edit a time afterwards and need to correct it.
          </p>

          {status.previewNote && !status.preview && (
            <div className="hint" style={{ marginBlockStart: '0.6rem' }}>{status.previewNote}</div>
          )}

          {showPreview && status.preview && (
            <pre
              className="glass-inset"
              style={{ marginBlockStart: '0.8rem', padding: '0.9rem 1rem', borderRadius: 'var(--radius-card)', whiteSpace: 'pre-wrap', fontSize: '0.85rem', lineHeight: 1.7, maxWidth: 620, overflowX: 'auto' }}
            >
              {status.preview}
            </pre>
          )}

          {status.log.length > 0 && <WhatsAppLog entries={status.log} groups={groups} fallbackLabel={wa.groupLabel} />}
        </>
      )}
    </div>
  );
}

/**
 * What became of each notice. Event, group and time only — never the message, which is a rule
 * worth keeping unconditional rather than re-argued per message.
 *
 * Four states, and the distinction that matters to whoever is reading this is between "waiting"
 * and "it did not go". A notice the platform later failed used to be indistinguishable from one
 * still on its way, which is precisely why an image that never arrived was so hard to chase.
 */
const WA_STATE: Record<WhatsAppLogEntry['outcome'], { mark: string; colour: string; word: string; title: string }> = {
  sent: { mark: '✓', colour: 'var(--color-success)', word: 'sent', title: 'The platform handed this to WhatsApp. WhatsApp gives no delivery receipt, so this is not proof it was read.' },
  queued: { mark: '·', colour: 'var(--color-ink-muted)', word: 'waiting', title: 'Accepted by OpenMasjidOS and not sent yet — usually a few seconds. It stays "waiting" if your OpenMasjidOS is too old to be asked (0.51.1 and up can answer).' },
  failed: { mark: '✗', colour: 'var(--color-danger)', word: 'did not send', title: 'OpenMasjidOS could not send this. It will be tried again automatically a few times.' },
  expired: { mark: '✗', colour: 'var(--color-danger)', word: 'expired', title: 'OpenMasjidOS gave up on this one before it could be sent.' },
};

function WhatsAppLog({ entries, groups, fallbackLabel }: { entries: WhatsAppLogEntry[]; groups: { id: string; label: string }[]; fallbackLabel: string }) {
  const name = (id: string) => groups.find((g) => g.id === id)?.label || fallbackLabel || id;
  return (
    <div style={{ marginBlockStart: '1.2rem' }}>
      <div className="label" style={{ marginBlockEnd: '0.4rem' }}>Recent announcements</div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.35rem' }}>
        {entries.map((e, i) => (
          <li key={`${e.at}-${i}`} className="hint" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
            {/* An outcome this app has never written — a store restored from a newer build —
                falls back to "waiting" rather than rendering an empty box. */}
            {(() => {
              const s = WA_STATE[e.outcome] ?? WA_STATE.queued;
              return (
                <>
                  <span style={{ color: s.colour }} title={s.title}>
                    {s.mark}
                  </span>
                  <span>{new Date(e.at).toLocaleString()}</span>
                  <span className="muted">·</span>
                  <span>Iqāmah change from {e.effectiveFrom}</span>
                  <span className="muted">·</span>
                  <span>{name(e.recipient)}</span>
                  <span className="muted">· {e.asImage ? 'image' : 'text'}</span>
                  <span style={{ color: s.colour }} title={s.title}>
                    · {s.word}
                  </span>
                </>
              );
            })()}
            {e.manual && <span className="muted">· sent by hand</span>}
            {e.error && <span style={{ color: 'var(--color-danger)' }}>· {e.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Beta features — things that work but have not been through a season in a real masjid yet.
 *
 * Kept behind a switch rather than shipped on: a masjid whose screens are working should not
 * be offered a second way of driving them until they choose to try it.
 */
function BetaPanel({ state, refetch }: Props) {
  const toast = useToast();
  const [webScreens, setWebScreens] = useState(state.settings.webScreensBeta);

  const save = async (v: boolean) => {
    setWebScreens(v); // optimistic
    try {
      await api.saveSettings({ webScreensBeta: v });
      await refetch();
      toast(v ? 'Browser screens are now offered when you add a screen.' : 'Browser screens are no longer offered.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save.', 'error');
      setWebScreens(state.settings.webScreensBeta);
    }
  };

  return (
    <div className="panel glass">
      <h3 className="section-title" style={{ marginTop: 0 }}>Beta features</h3>
      <p className="muted" style={{ marginBottom: '1rem' }}>
        Finished, but new. Try them if they solve a problem you have; leave them off otherwise.
      </p>
      <div className="toggle-row row-between">
        <span className="label" style={{ margin: 0 }}>Screens that are a web page</span>
        <Toggle checked={webScreens} onChange={save} label="Offer browser screens when adding a screen" />
      </div>
      <p className="hint" style={{ marginBlockStart: '0.6rem', maxWidth: 640 }}>
        Adds a second kind of screen: instead of a decoder box pulling a video stream, the screen opens
        a <b>web page</b> in any browser — a Raspberry Pi in kiosk mode, a smart TV, or a spare
        computer. It draws the timetable itself from a few hundred bytes of data rather than receiving
        video, so it uses a tiny fraction of the network, and it works over the internet through your
        OpenMasjidOS remote access. <b>It can only show a timetable</b> — cameras and HDMI sources are
        video and still need a decoder box. Turning this off later leaves any screens you already made
        working; it only stops offering the option for new ones.
      </p>
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
