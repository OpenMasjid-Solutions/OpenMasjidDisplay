// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useState, useEffect } from 'react';
import { api } from '../api';
import type { AppState, Tv, TvKind, ContentRef, TvStatus, PiDeviceInfo } from '../types';
// The same helper the server tests, rather than a second copy of the rule living in the panel.
import { installCommand } from '../../../server/src/pi/lanHost';
import { contentOptions, ContentPicker, contentLabel } from '../content';
import {
  Modal,
  Field,
  IconScreen,
  IconPlus,
  IconEdit,
  IconTrash,
  IconCopy,
  IconCheck,
  IconRefresh,
  IconPower,
  IconDownload,
  MasjidMark,
  Spinner,
  copyText,
  useToast,
} from '../ui';

interface Props {
  state: AppState;
  refetch: () => Promise<void>;
}

export function Screens({ state, refetch }: Props) {
  const toast = useToast();
  const [edit, setEdit] = useState<Tv | 'new' | null>(null);
  const [confirm, setConfirm] = useState<Tv | null>(null);
  const [piById, setPiById] = useState<Map<string, PiDeviceInfo>>(new Map());
  const options = contentOptions(state);
  const statusById = new Map<string, TvStatus>(state.statuses.map((s) => [s.tvId, s]));

  const setContent = async (tv: Tv, content: ContentRef) => {
    try {
      await api.setTv(tv.id, content, null);
      await refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not switch the screen.', 'error');
    }
  };
  const resume = async (tv: Tv) => {
    try {
      await api.resumeTv(tv.id);
      await refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update the screen.', 'error');
    }
  };
  const remove = async (tv: Tv) => {
    try {
      await api.deleteTv(tv.id);
      setConfirm(null);
      await refetch();
      toast('Screen removed.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove the screen.', 'error');
    }
  };

  return (
    <div>
      {/* Pi screens are devices as well as screens, and the card is where somebody looks to see
          whether the thing on the shelf is alive. Fetched once here rather than per card. */}
      <PiDeviceFacts tvs={state.tvs} onLoaded={setPiById} />

      <div className="page-head row-between">
        <div>
          <h1 className="page-title">Screens</h1>
          <p className="page-sub">Choose what each screen shows. Changes happen within a few seconds.</p>
        </div>
        <button className="btn btn--primary" onClick={() => setEdit('new')}>
          <IconPlus size={16} /> Add screen
        </button>
      </div>

      {state.tvs.length === 0 ? (
        <div className="empty-state glass" style={{ borderRadius: 'var(--radius-card)' }}>
          <div className="empty-art"><MasjidMark size={64} /></div>
          <h3>No screens yet</h3>
          <p>Add a screen for each TV. You'll get a link to put into its RTSP decoder.</p>
          <button className="btn btn--primary" style={{ marginTop: '1rem' }} onClick={() => setEdit('new')}>
            <IconPlus size={16} /> Add your first screen
          </button>
        </div>
      ) : (
        <div className="screens-grid">
          {state.tvs.map((tv) => (
            <ScreenCard
              key={tv.id}
              tv={tv}
              device={piById.get(tv.piDeviceId ?? '')}
              status={statusById.get(tv.id)}
              state={state}
              options={options}
              onSet={(c) => setContent(tv, c)}
              onResume={() => resume(tv)}
              onEdit={() => setEdit(tv)}
              onDelete={() => setConfirm(tv)}
              onCopy={(url) => copyText(url).then(() => toast('Link copied.'))}
            />
          ))}
        </div>
      )}

      {edit && (
        <TvModal
          tv={edit === 'new' ? null : edit}
          options={options}
          beta={state.settings.webScreensBeta}
          refetch={refetch}
          onClose={() => setEdit(null)}
          onSaved={async () => {
            setEdit(null);
            await refetch();
          }}
        />
      )}

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={`Remove ${confirm?.name ?? 'screen'}?`}
        footer={
          <>
            <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn btn--danger" onClick={() => confirm && remove(confirm)}>Remove screen</button>
          </>
        }
      >
        <p className="muted">The screen's link will stop working. Timetables and sources are not affected.</p>
      </Modal>
    </div>
  );
}

function ScreenCard({
  tv,
  device,
  status,
  state,
  options,
  onSet,
  onResume,
  onEdit,
  onDelete,
  onCopy,
}: {
  tv: Tv;
  /** the Raspberry Pi driving this screen, when it is one. Absent for every other kind. */
  device?: PiDeviceInfo;
  status?: TvStatus;
  state: AppState;
  options: ReturnType<typeof contentOptions>;
  onSet: (c: ContentRef) => void;
  onResume: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopy: (url: string) => void;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [copiedPublic, setCopiedPublic] = useState(false);
  const [sending, setSending] = useState<'' | 'restart' | 'update' | 'reboot' | 'reinstall'>('');

  /** Queue an instruction for the Pi. It is not sent — the device collects it, so say so. */
  const ask = async (deviceId: string, action: 'restart' | 'update' | 'reboot' | 'reinstall') => {
    setSending(action);
    try {
      await api.piCommand(deviceId, action);
      toast(
        action === 'restart'
          ? 'Asked the screen to restart. It will go blank for a few seconds.'
          : action === 'reboot'
            ? 'Asked the Raspberry Pi to reboot. It will be back in about a minute.'
            : action === 'reinstall'
              ? 'Asked the Pi to run setup again. This takes a few minutes and may need a reboot afterwards.'
            : 'Asked the screen to check for an update. It restarts itself if it finds one.',
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not reach the display server.', 'error');
    } finally {
      setSending('');
    }
  };
  const effective = status?.effective ?? tv.defaultContent;
  const ready = status?.streamReady ?? false;
  // The screen is lit and pulling, but its timetable stopped updating — the times on it
  // are wrong. That is worse than a dark screen, so it gets the louder badge.
  const stale = !!status?.contentStale;
  // The link uses whatever address this panel was opened with — the same address
  // a decoder on the network reaches this server at. Nothing to configure.
  // A browser screen's link is a page, not a stream. Built from the address this panel was
  // opened with — so on the LAN it is the LAN address, and opened through the platform's
  // tunnel it is already the public HTTPS one, which is what a remote television needs.
  const isWeb = tv.kind === 'web';
  // A Pi screen has NO address anybody connects to, and that is the entire point of it. It draws
  // the timetable itself and opens cameras itself, so the server never publishes a stream for it —
  // orchestrator.ts skips creating a MediaMTX path for kind:'pi' at three separate sites.
  //
  // The card used to print one anyway, because it fell through to the RTSP branch: a
  // rtsp://…/tv_xxxx that nothing serves and no player can open. Worse than useless — it invites
  // somebody to test it, fail, and conclude the screen is broken when it is working perfectly.
  const isPi = tv.kind === 'pi';
  // A browser screen's link is a page, not a stream. The LAN form is built from the address
  // this panel was opened with; the PUBLIC one (for a television that is not on this network)
  // comes from the server, which asks the platform whether it is actually routing this app —
  // guessing it here would hand someone a URL that silently does not resolve.
  const [publicScreenUrl, setPublicScreenUrl] = useState('');
  useEffect(() => {
    if (!isWeb) return;
    let live = true;
    void api.screenInfo(tv.id).then((r) => { if (live) setPublicScreenUrl(r.publicUrl); }).catch(() => {});
    return () => { live = false; };
  }, [isWeb, tv.id]);
  // A web screen has TWO useful addresses and they are not interchangeable. A television in
  // the building should use the local one — it stays on the LAN, needs no internet, and keeps
  // working if the line drops. A screen elsewhere (or a display hosted in the cloud) needs the
  // public one. Showing only whichever exists made the local address vanish the moment remote
  // access was turned on, which is exactly backwards for the screens that are on this network.
  const localUrl = `${location.origin}/s/${tv.webToken ?? ''}`;
  const url = isWeb ? localUrl : `rtsp://${location.hostname}:${state.rtsp.port}/${tv.id}`;
  const localHost = /^(localhost|127\.|0\.0\.0\.0|::1|\[)/.test(location.hostname);
  const sourceTag =
    status?.source === 'override' ? 'Manual' : status?.source === 'schedule' ? 'Scheduled' : 'Default';

  return (
    <div className="screen-card glass">
      <div className="screen-card__head">
        <span className={`status-dot${ready && !stale ? '' : ' status-dot--idle'}`} title={stale ? 'This screen is showing out-of-date times' : ready ? 'A screen is connected' : 'No screen connected yet'} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="screen-name">
            {tv.name}
            {stale ? (
              <span
                className="tag"
                style={{ marginInlineStart: '0.5rem', background: 'rgba(229,115,107,0.24)', color: '#e5736b', fontWeight: 700 }}
                title={
                  status?.staleReason === 'clock'
                    ? "This machine's clock is clearly wrong, so every prayer time on this screen is wrong. Set the clock (or fix its time sync) and the screen corrects itself. It is marked on the screen too."
                    : `This screen's timetable stopped updating${
                        // Only quote an age for a FROZEN screen. Under a wrong clock the renderer
                        // is fine and the age is ~0, which would read as "0 min ago".
                        status?.frameAgeMs && status.frameAgeMs >= 60000
                          ? ` about ${Math.round(status.frameAgeMs / 60000)} min ago`
                          : ''
                      }, so the prayer times on it are NOT current. It is marked on the screen itself too. Check the app log.`
                }
              >
                {status?.staleReason === 'clock' ? 'Clock is wrong' : 'Times out of date'}
              </span>
            ) : (
              effective.kind !== 'off' && !ready && (
                <span className="tag" style={{ marginInlineStart: '0.5rem', background: 'rgba(229,115,107,0.16)', color: '#e5736b' }} title={tv.kind === 'web' ? "This screen’s browser hasn’t checked in — the screen may be off, or the page was closed." : "This screen isn’t pulling its stream — the screen or its decoder may be off or disconnected."}>Offline</span>
              )
            )}
          </div>
          {tv.room && <div className="screen-room">{tv.room}</div>}
        </div>
        <button className="icon-btn" aria-label="Edit screen" onClick={onEdit}><IconEdit size={16} /></button>
        <button className="icon-btn" aria-label="Remove screen" onClick={onDelete}><IconTrash size={16} /></button>
      </div>

      <div className="screen-now glass-inset">
        <IconScreen size={16} />
        <span className="screen-now__label">{contentLabel(effective, state)}</span>
        <span className={`tag screen-now__src ${status?.source === 'schedule' ? 'tag--hdmi' : 'tag--cam'}`}>{sourceTag}</span>
      </div>

      <ContentPicker options={options} value={effective} onChange={onSet} />

      {status?.source === 'override' && (
        <button className="btn btn--ghost btn--sm" onClick={onResume}>
          <IconRefresh size={14} /> Back to schedule
        </button>
      )}

      {isPi ? (
        // What a person actually needs from a device on a shelf: is it alive, where is it, what is
        // it running — and the two things they will want to do to it. No link, because there is
        // nothing to connect to.
        <div className="rtsp-box" style={{ justifyContent: 'flex-start', gap: '0.7rem', flexWrap: 'wrap' }}>
          <span className={`status-dot${device?.online ? '' : ' status-dot--idle'}`} title={device?.online ? 'Checking in' : 'Not checking in'} />
          <span className="hint">Raspberry Pi</span>
          <span className="hint" style={{ fontFamily: 'monospace' }}>{device?.ip || 'address unknown'}</span>
          <span className="hint muted">agent {device?.agentVersion || '?'}</span>
          <span style={{ flex: 1 }} />
          {/* Nothing can connect TO the Pi, so these are requests it collects on its own poll —
              within about five seconds. The wording says asked, never done. */}
          <button
            className="btn btn--ghost btn--sm"
            disabled={!device || sending !== ''}
            title="Ask this screen to check for a newer version now"
            onClick={() => device && ask(device.id, 'update')}
          >
            {sending === 'update' ? <Spinner /> : <IconDownload size={14} />} Update
          </button>
          <button
            className="btn btn--ghost btn--sm"
            disabled={!device || sending !== ''}
            title="Ask this screen to restart its software"
            onClick={() => device && ask(device.id, 'restart')}
          >
            {sending === 'restart' ? <Spinner /> : <IconRefresh size={14} />} Restart
          </button>
          {/* A full power cycle of the board, not just the software. Rate limited on the device
              to one every ten minutes, because a reboot loop takes a screen off the wall for good
              and nobody is watching it. */}
          <button
            className="btn btn--ghost btn--sm"
            disabled={!device || sending !== ''}
            title="Restart the whole Raspberry Pi. Use this if restarting the software did not help."
            onClick={() => device && ask(device.id, 'reboot')}
          >
            {sending === 'reboot' ? <Spinner /> : <IconPower size={14} />} Reboot
          </button>
          {/* The only action that can change the service unit, the boot settings or the installed
              packages. Update replaces the agent file and nothing else, so a fix in any of those
              would otherwise need somebody with a keyboard in front of the Pi. */}
          <button
            className="btn btn--ghost btn--sm"
            disabled={!device || sending !== ''}
            title="Run setup again on this Pi. Applies changes that a normal update cannot, and takes a few minutes."
            onClick={() => device && ask(device.id, 'reinstall')}
          >
            {sending === 'reinstall' ? <Spinner /> : <IconDownload size={14} />} Re-run setup
          </button>
        </div>
      ) : (
        <div className="rtsp-box">
          <span className="rtsp-url" title={url}>{url}</span>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => {
              onCopy(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />} {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      )}
      {isWeb && (
        <div className="rtsp-box">
          <span className="rtsp-url" title={publicScreenUrl || 'Remote access is off'}>
            {publicScreenUrl || 'No public address — remote access is off in OpenMasjidOS'}
          </span>
          {publicScreenUrl && (
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => {
                onCopy(publicScreenUrl);
                setCopiedPublic(true);
                setTimeout(() => setCopiedPublic(false), 1500);
              }}
            >
              {copiedPublic ? <IconCheck size={14} /> : <IconCopy size={14} />} {copiedPublic ? 'Copied' : 'Copy remote link'}
            </button>
          )}
        </div>
      )}
      {isWeb && effective.kind === 'source' && state.sources.find((x) => x.id === effective.id)?.mode === 'normalize' && (
        <div className="hint" style={{ color: 'var(--color-warning)' }}>
          This camera is set to <b>Most compatible</b>, which re-encodes it — that is the expensive
          part of running this screen. A browser plays <b>Direct</b> straight through with almost no
          CPU, as long as the camera is H.264. Worth trying Direct on the Sources page first.
        </div>
      )}
      {isWeb ? (
        <div className="hint">
          Open one of these in a browser on the screen (a Raspberry Pi in kiosk mode, a smart TV, or any
          computer). It draws the timetable itself, so it uses almost no network after it loads.
          <br />
          Use the <b>first (local) link</b> for screens in the masjid — it stays on your network.
          {publicScreenUrl
            ? ' Use the second for a screen somewhere else, or one you host in the cloud.'
            : ' Turn on remote access in OpenMasjidOS to also get an address that works off-site.'}
        </div>
      ) : (
        localHost && (
          <div className="hint">
            You're viewing this on the server itself — open this panel from another device using this
            server's network address, and the link will use that address for your screens.
          </div>
        )
      )}
    </div>
  );
}


/**
 * Adding a Raspberry Pi screen: the command to run, and the code it puts on the television.
 *
 * This lives inside "Add a screen" rather than beside the grid, because that is what it is —
 * one of the three ways a screen can be added, not a separate feature. Adopting a Pi CREATES the
 * screen, which is why this panel owns the name field and the confirm button instead of the
 * modal's normal ones.
 *
 * The code — rather than the Pi's IP address — is what gets typed, because the Pi is behind the
 * masjid's network on an address that can change, and the display server may not even be in the
 * building. Typing what is on the screen also proves you can see that screen.
 */
/**
 * Keeps the Pi screens on this page supplied with what their devices are reporting.
 *
 * One request for the page rather than one per card, and it does not run at all unless a Pi
 * screen exists — a masjid with only decoder boxes should not be polling an endpoint about
 * hardware it does not have.
 */
function PiDeviceFacts({ tvs, onLoaded }: { tvs: Tv[]; onLoaded: (m: Map<string, PiDeviceInfo>) => void }) {
  const anyPi = tvs.some((t) => t.kind === 'pi');
  useEffect(() => {
    if (!anyPi) return;
    let live = true;
    const load = () =>
      api
        .piDevices()
        .then((r) => {
          if (live) onLoaded(new Map(r.devices.map((d) => [d.id, d])));
        })
        .catch(() => {});
    void load();
    // Same cadence the device checks in at, so online on the card means what it says.
    const t = setInterval(() => void load(), 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [anyPi]);
  return null;
}

function PiSetup({ refetch, onAdopted }: { refetch: () => Promise<void>; onAdopted: () => void }) {
  const toast = useToast();
  const [devices, setDevices] = useState<PiDeviceInfo[]>([]);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);

  // Built from the address this panel is open on, which is the address that just worked from a
  // browser on this network — so it is the one most likely to work from the Pi too. It is also
  // what the server bakes into the script it serves, because the script is fetched from exactly
  // this URL: point the panel at the tunnel and the Pi is set up through the tunnel, point it at
  // the LAN and the Pi stays on the LAN. Nothing to choose, and nothing to type wrong.
  //
  // On a LAN address over HTTPS the certificate is necessarily self-signed — no public authority
  // will issue for 192.168.x.x — so `curl` refuses it and the command needs -k for that first
  // fetch. That is called out below rather than slipped in, because pasting an unverified script
  // into `sudo sh` is not something anybody should do without being told.
  const { command: installCmd, insecureFirstHop } = installCommand(window.location.origin);

  // A failed poll must NOT clear the list. It used to, and the consequence was maddening rather
  // than subtle: the code and name inputs below were rendered only while a device was pending, so
  // one transient failure emptied the list, unmounted the input mid-keystroke, and the next poll
  // put a fresh empty one back. It read as the cursor jumping out of the box while you typed.
  const load = () => api.piDevices().then((r) => setDevices(r.devices)).catch(() => {});
  useEffect(() => {
    void load();
    // A Pi that is plugged in while this page is open should appear without a refresh — that
    // is exactly when someone is watching for it.
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, []);

  const pending = devices.filter((d) => !d.adopted);
  const adopted = devices.filter((d) => d.adopted);

  const adopt = async () => {
    setBusy(true);
    try {
      await api.piAdopt(code.trim(), name.trim());
      setCode('');
      setName('');
      await load();
      await refetch();
      toast('Screen added. It will start showing in a few seconds.');
      onAdopted();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not set that screen up.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const forget = async (d: PiDeviceInfo) => {
    try {
      await api.piForget(d.id);
      await load();
      toast('Forgotten. That screen will show a new code.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not forget it.', 'error');
    }
  };

  return (
    <div>
      <p className="muted" style={{ marginBlockEnd: '0.6rem' }}>
        A Raspberry Pi plugged into a television, showing the timetable and playing cameras by
        itself. Because the Pi opens the camera directly, the video never passes through this
        server — so cameras keep working at full frame rate even when the server is not in the
        building.
      </p>
      <p className="hint" style={{ marginBlockEnd: '0.5rem' }}>
        On a Raspberry Pi running Raspberry Pi OS Lite, run this once:
      </p>
      <div className="rtsp-box" style={{ marginBlockEnd: '0.5rem' }}>
        <span className="rtsp-url" title={installCmd} style={{ fontFamily: 'monospace' }}>{installCmd}</span>
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => {
            void copyText(installCmd).then(() => toast('Command copied.'));
            setCopiedCmd(true);
            setTimeout(() => setCopiedCmd(false), 1500);
          }}
        >
          {copiedCmd ? <IconCheck size={14} /> : <IconCopy size={14} />} {copiedCmd ? 'Copied' : 'Copy command'}
        </button>
      </div>
      {insecureFirstHop && (
        <p className="hint" style={{ marginBlockEnd: '0.5rem' }}>
          <b>Why <code>-k</code>?</b> You are on a local address, so this server&rsquo;s certificate is
          its own — no public authority can vouch for a name like this one, and <code>curl</code>
          refuses it without <code>-k</code>. Only this first download is unverified: the installer
          then takes a copy of the certificate and checks every later request against it, including
          its own updates.
        </p>
      )}
      <p className="hint" style={{ marginBlockEnd: '1rem' }}>
        The Pi will then show a code on the television. Enter it below.
      </p>

      {pending.length > 0 ? (
        <>
          <p className="muted" style={{ marginBottom: '0.8rem' }}>
            {pending.length === 1 ? 'A screen is' : `${pending.length} screens are`} waiting to be set up.
            Type the code showing on it.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 0.9rem', display: 'grid', gap: '0.4rem' }}>
            {pending.map((d) => (
              <li key={d.id} className="hint" style={{ display: 'flex', gap: '0.6rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span className={`status-dot${d.online ? '' : ' status-dot--idle'}`} />
                <b style={{ fontFamily: 'monospace', fontSize: '1.05rem', letterSpacing: '0.12em', color: 'var(--color-ink)' }}>{d.code}</b>
                <span>{d.hostname}</span>
                {d.ip && <span className="muted">· {d.ip}</span>}
                {d.model && <span className="muted">· {d.model}</span>}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted" style={{ marginBottom: '0.8rem' }}>
          {adopted.length
            ? 'No new screens are waiting. Run the command above on another Pi to add one.'
            : 'No screens are waiting yet. Once the command above finishes, the Pi appears here with a code.'}
        </p>
      )}

      {/* OUTSIDE the conditional above, deliberately.
          The list of waiting devices changes with every poll; what somebody is halfway through
          typing must not. Rendering these inside that branch meant a single empty poll unmounted
          the input mid-keystroke and remounted a fresh one — which reads as the cursor jumping out
          of the box while you type, and loses what you had typed.
          You can also now type a code that is on the television before the list has caught up. */}
      <div className="grid2">
        <Field label="Code from the screen">
          <input
            className="input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="K7M2QX"
            style={{ fontFamily: 'monospace', letterSpacing: '0.12em' }}
          />
        </Field>
        <Field label="Name this screen" hint="What you'll call it in the panel — e.g. Main hall.">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Main hall" />
        </Field>
      </div>
      <button className="btn btn--primary btn--sm" onClick={adopt} disabled={busy || code.trim().length < 4} style={{ marginBlockStart: '0.8rem' }}>
        {busy ? <><Spinner /> Setting up…</> : 'Set up this screen'}
      </button>

      {adopted.length > 0 && (
        <div style={{ marginBlockStart: pending.length ? '1.2rem' : '0.8rem' }}>
          <div className="label" style={{ marginBlockEnd: '0.4rem' }}>Set up</div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.35rem' }}>
            {adopted.map((d) => (
              <li key={d.id} className="hint" style={{ display: 'flex', gap: '0.6rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span className={`status-dot${d.online ? '' : ' status-dot--idle'}`} title={d.online ? 'Checking in' : 'Not checking in'} />
                <span>{d.hostname}</span>
                {d.ip && <span className="muted">· {d.ip}</span>}
                <span className="muted">· agent {d.agentVersion || '?'}</span>
                <button className="btn btn--ghost btn--sm" onClick={() => void forget(d)}>Forget</button>
              </li>
            ))}
          </ul>
          <p className="hint" style={{ marginBlockStart: '0.5rem' }}>
            Forgetting a Pi makes it show a new code so it can be set up again. The screen it was
            driving is kept.
          </p>
        </div>
      )}
    </div>
  );
}

function TvModal({
  tv,
  options,
  beta,
  onClose,
  onSaved,
  refetch,
}: {
  tv: Tv | null;
  options: ReturnType<typeof contentOptions>;
  beta: boolean;
  onClose: () => void;
  onSaved: () => void;
  refetch: () => Promise<void>;
}) {
  const toast = useToast();
  const [name, setName] = useState(tv?.name ?? '');
  const [room, setRoom] = useState(tv?.room ?? '');
  const [content, setContent] = useState<ContentRef>(tv?.defaultContent ?? { kind: 'off' });
  const [kind, setKind] = useState<TvKind>(tv?.kind ?? 'rtsp');
  const [busy, setBusy] = useState(false);

  // Adding a Pi is a different act from adding the other two: the screen does not exist until a
  // device has been adopted, and adoption is what creates it. So this branch owns the whole modal
  // body and its own confirm button, and the normal name/content fields are not shown — they
  // would be filled in and then thrown away.
  const addingPi = !tv && kind === 'pi';

  const save = async () => {
    setBusy(true);
    try {
      const body = { name: name.trim() || 'Screen', room: room.trim(), defaultContent: content, kind };
      if (tv) await api.updateTv(tv.id, body);
      else await api.createTv(body);
      onSaved();
      toast(tv ? 'Screen updated.' : 'Screen added.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save.', 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      windowed
      onClose={onClose}
      title={tv ? 'Edit screen' : addingPi ? 'Add a Raspberry Pi screen' : 'Add a screen'}
      footer={
        <>
          <button className="btn" onClick={onClose}>{addingPi ? 'Close' : 'Cancel'}</button>
          {!addingPi && (
            <button className="btn btn--primary" onClick={save} disabled={busy}>{tv ? 'Save' : 'Add screen'}</button>
          )}
        </>
      }
    >
      {/* The kind comes first when adding, because it changes what the rest of this dialog even
          asks for. It is fixed when editing: a screen's kind is bound to how it was set up, and a
          Pi screen in particular is bound to a specific device. */}
      {beta && !tv && (
        <Field
          label="How this screen receives the picture"
          hint="Pick this first — it changes what the rest of this asks for."
        >
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value as TvKind)}>
            <option value="rtsp">Video stream — a decoder box pulls RTSP from this server</option>
            <option value="web">Web page — a browser draws the timetable itself (beta)</option>
            <option value="pi">Raspberry Pi — draws the timetable AND plays cameras itself (beta)</option>
          </select>
        </Field>
      )}
      {beta && !tv && kind !== 'pi' && (
        <p className="hint" style={{ marginBlockStart: '-0.4rem', marginBlockEnd: '0.9rem' }}>
          {kind === 'rtsp'
            ? 'This server renders the picture and sends it as video — about 1.5 Mbit/s per screen, continuously.'
            : 'Almost no network: the page is sent the timetable and draws it locally. It cannot show a camera, because a web page here has no video player.'}
        </p>
      )}

      {addingPi ? (
        <PiSetup refetch={refetch} onAdopted={onSaved} />
      ) : (
      <>
      <div className="grid2">
        <Field label="Screen name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Main hall TV" /></Field>
        <Field label="Room (optional)"><input className="input" value={room} onChange={(e) => setRoom(e.target.value)} placeholder="Main hall" /></Field>
      </div>
      {kind === 'web' && content.kind === 'source' && (
        <div className="form-error">
          A browser screen can only show a timetable. Cameras and HDMI sources are video, and this
          kind of screen has no video player — pick a timetable, or use a decoder box for this screen.
        </div>
      )}
      <Field label="Normally shows" hint="What this screen returns to when no schedule or manual choice applies.">
        <ContentPicker options={options} value={content} onChange={setContent} />
      </Field>
      </>
      )}
    </Modal>
  );
}
