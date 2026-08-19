// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useState, useEffect } from 'react';
import { api } from '../api';
import type { AppState, Tv, TvKind, ContentRef, TvStatus } from '../types';
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
  MasjidMark,
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
  status?: TvStatus;
  state: AppState;
  options: ReturnType<typeof contentOptions>;
  onSet: (c: ContentRef) => void;
  onResume: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopy: (url: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copiedPublic, setCopiedPublic] = useState(false);
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

function TvModal({
  tv,
  options,
  beta,
  onClose,
  onSaved,
}: {
  tv: Tv | null;
  options: ReturnType<typeof contentOptions>;
  beta: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(tv?.name ?? '');
  const [room, setRoom] = useState(tv?.room ?? '');
  const [content, setContent] = useState<ContentRef>(tv?.defaultContent ?? { kind: 'off' });
  const [kind, setKind] = useState<TvKind>(tv?.kind ?? 'rtsp');
  const [busy, setBusy] = useState(false);

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
      title={tv ? 'Edit screen' : 'Add a screen'}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save} disabled={busy}>{tv ? 'Save' : 'Add screen'}</button>
        </>
      }
    >
      <div className="grid2">
        <Field label="Screen name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Main hall TV" /></Field>
        <Field label="Room (optional)"><input className="input" value={room} onChange={(e) => setRoom(e.target.value)} placeholder="Main hall" /></Field>
      </div>
      {beta && (
        <Field
          label="How this screen receives the picture"
          hint="A decoder box pulls a video stream. A browser opens a web page and draws the timetable itself, which uses almost no network — but it can only show a timetable, not a camera."
        >
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value as TvKind)}>
            <option value="rtsp">Video stream (RTSP decoder box)</option>
            <option value="web">Web page (browser / Raspberry Pi) — beta</option>
          </select>
        </Field>
      )}
      {kind === 'web' && content.kind === 'source' && (
        <div className="form-error">
          A browser screen can only show a timetable. Cameras and HDMI sources are video, and this
          kind of screen has no video player — pick a timetable, or use a decoder box for this screen.
        </div>
      )}
      <Field label="Normally shows" hint="What this screen returns to when no schedule or manual choice applies.">
        <ContentPicker options={options} value={content} onChange={setContent} />
      </Field>
    </Modal>
  );
}
