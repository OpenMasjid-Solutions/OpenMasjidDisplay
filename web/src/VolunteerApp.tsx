// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * VolunteerApp — the bone-simple, PIN-gated mobile page served on the volunteer
 * port. A volunteer unlocks with the PIN, sees every screen, and taps to switch
 * what each one shows. Same liquid-glass look as the dashboard.
 */
import { useEffect, useState } from 'react';
import { volApi, type VolunteerData, type VolunteerReport } from './api';
import type { ContentRef } from './types';
import {
  ToastProvider,
  useToast,
  MasjidMark,
  Spinner,
  IconClock,
  IconCamera,
  IconCast,
  IconScreen,
  IconCheck,
  IconRefresh,
  IconPower,
} from './ui';

export function VolunteerApp() {
  return (
    <ToastProvider>
      <VolunteerRoot />
    </ToastProvider>
  );
}

type Phase = 'loading' | 'off' | 'pin' | 'ready';

function VolunteerRoot() {
  const [phase, setPhase] = useState<Phase>('loading');

  const refreshSession = () =>
    volApi
      .session()
      .then((s) => setPhase(!s.enabled ? 'off' : s.authed ? 'ready' : 'pin'))
      .catch(() => setPhase('off'));

  useEffect(() => {
    void refreshSession();
  }, []);

  return (
    <div className="vol">
      <div className="scene" aria-hidden="true" />
      {phase === 'loading' && <div className="vol-center"><Spinner /></div>}
      {phase === 'off' && <VolMessage title="Volunteer page is off" body="Ask an admin to turn it on in the control panel's Settings." />}
      {phase === 'pin' && <PinLogin onDone={() => setPhase('ready')} />}
      {phase === 'ready' && <VolReady onLock={() => void volApi.logout().finally(refreshSession)} />}
    </div>
  );
}

function VolMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="vol-center">
      <div className="vol-card glass-raised" style={{ textAlign: 'center', maxWidth: '22rem' }}>
        <div style={{ color: 'var(--color-primary)', display: 'flex', justifyContent: 'center', marginBlockEnd: '0.75rem' }}>
          <MasjidMark size={40} />
        </div>
        <h2 className="page-title" style={{ fontSize: '1.3rem' }}>{title}</h2>
        <p className="muted" style={{ marginBlockStart: '0.5rem' }}>{body}</p>
      </div>
    </div>
  );
}

function PinLogin({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  const press = (d: string) => setPin((p) => (p.length >= 8 ? p : p + d));
  const back = () => setPin((p) => p.slice(0, -1));
  const submit = async () => {
    if (pin.length < 4 || busy) return;
    setBusy(true);
    try {
      await volApi.login(pin);
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Wrong PIN.', 'error');
      setPin('');
      setBusy(false);
    }
  };

  return (
    <div className="vol-center">
      <div className="vol-card glass-raised" style={{ width: 'min(20rem, 100%)', textAlign: 'center' }}>
        <div style={{ color: 'var(--color-primary)', display: 'flex', justifyContent: 'center', marginBlockEnd: '0.5rem' }}>
          <MasjidMark size={40} />
        </div>
        <h2 className="page-title" style={{ fontSize: '1.25rem' }}>Volunteer access</h2>
        <p className="muted" style={{ marginBlock: '0.35rem 1rem' }}>Enter the PIN to continue.</p>
        <div className="pin-dots" aria-hidden="true">
          {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
            <span key={i} className={`pin-dot${i < pin.length ? ' is-on' : ''}`} />
          ))}
        </div>
        <div className="pin-pad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button key={d} type="button" className="pin-key glass" onClick={() => press(d)}>{d}</button>
          ))}
          <button type="button" className="pin-key pin-key--ghost" onClick={back} aria-label="Delete">⌫</button>
          <button type="button" className="pin-key glass" onClick={() => press('0')}>0</button>
          <button type="button" className="pin-key pin-key--ok" onClick={submit} disabled={pin.length < 4 || busy} aria-label="Unlock">
            {busy ? <Spinner /> : <IconCheck size={20} />}
          </button>
        </div>
      </div>
    </div>
  );
}

type Tab = 'screens' | 'report';

function VolReady({ onLock }: { onLock: () => void }) {
  const [tab, setTab] = useState<Tab>('screens');
  return (
    <div className="vol-wrap">
      <header className="vol-head">
        <div className="brand"><MasjidMark size={22} /></div>
        <div className="vol-tabs" role="tablist">
          <button type="button" className={`vol-tab${tab === 'screens' ? ' is-active' : ''}`} onClick={() => setTab('screens')}>
            <IconScreen size={15} /> Screens
          </button>
          <button type="button" className={`vol-tab${tab === 'report' ? ' is-active' : ''}`} onClick={() => setTab('report')}>
            <IconCamera size={15} /> Report
          </button>
        </div>
        <span className="spacer" />
        <button className="icon-btn" onClick={onLock} aria-label="Lock"><IconPower size={18} /></button>
      </header>
      {tab === 'screens' ? <VolScreens /> : <VolReport />}
    </div>
  );
}

function VolScreens() {
  const toast = useToast();
  const [data, setData] = useState<VolunteerData | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  const load = () =>
    volApi
      .tvs()
      .then((d) => { setData(d); setErr(false); })
      .catch(() => setErr(true));

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 6000);
    return () => clearInterval(t);
  }, []);

  const apply = async (tvId: string, content: ContentRef) => {
    try {
      await volApi.set(tvId, content);
      setOpen(null);
      await load();
      toast('Screen updated.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change the screen.', 'error');
    }
  };
  const resume = async (tvId: string) => {
    try {
      await volApi.resume(tvId);
      setOpen(null);
      await load();
      toast('Back to the schedule.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not reset the screen.', 'error');
    }
  };

  return (
    <>
      {!data && !err && <div className="vol-center"><Spinner /></div>}
      {err && <p className="muted" style={{ textAlign: 'center', padding: '2rem' }}>Couldn't load the screens. Pull to retry.</p>}
      {data && data.tvs.length === 0 && (
        <VolMessage title="No screens yet" body="An admin can add screens in the control panel." />
      )}
      <div className="vol-list">
        {data?.tvs.map((tv) => (
          <div key={tv.id} className="vol-tv glass-raised">
            <button className="vol-tv__head" onClick={() => setOpen(open === tv.id ? null : tv.id)}>
              <span className={`vol-dot${tv.ready ? ' is-live' : ''}`} aria-hidden="true" />
              <span className="vol-tv__info">
                <span className="vol-tv__name">{tv.name}{tv.room ? ` · ${tv.room}` : ''}</span>
                <span className="vol-tv__now">Showing: {tv.now.label}{tv.overridden ? ' (manual)' : ''}</span>
              </span>
              <span className="vol-tv__chev">{open === tv.id ? '▴' : '▾'}</span>
            </button>
            {open === tv.id && (
              <div className="vol-opts">
                {data.options.timetables.map((t) => (
                  <OptBtn key={`t${t.id}`} active={tv.now.kind === 'timetable' && tv.now.id === t.id} icon={<IconClock size={16} />} label={t.name} onClick={() => apply(tv.id, { kind: 'timetable', id: t.id })} />
                ))}
                {data.options.sources.map((s) => (
                  <OptBtn key={`s${s.id}`} active={tv.now.kind === 'source' && tv.now.id === s.id} icon={s.type === 'hdmi' ? <IconCast size={16} /> : <IconCamera size={16} />} label={s.name} onClick={() => apply(tv.id, { kind: 'source', id: s.id })} />
                ))}
                <OptBtn active={tv.now.kind === 'off'} icon={<IconScreen size={16} />} label="Show nothing" onClick={() => apply(tv.id, { kind: 'off' })} />
                {tv.overridden && (
                  <button className="btn btn--ghost btn--block" style={{ marginBlockStart: '0.4rem' }} onClick={() => resume(tv.id)}>
                    <IconRefresh size={15} /> Back to the schedule
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/** Downscale a chosen photo to a JPEG data URL so uploads stay small. */
function resizeToDataUrl(file: File, maxDim = 1400, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Could not process the image.'));
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    img.src = url;
  });
}

function VolReport() {
  const toast = useToast();
  const [timetables, setTimetables] = useState<{ id: string; name: string }[]>([]);
  const [reports, setReports] = useState<VolunteerReport[]>([]);
  const [plate, setPlate] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [reason, setReason] = useState('');
  const [allDisplays, setAllDisplays] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [image, setImage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    volApi.reports().then((d) => { setReports(d.reports); setTimetables(d.timetables); }).catch(() => {});
  useEffect(() => { void load(); }, []);

  const toggleDisplay = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const onPhoto = async (file: File | undefined) => {
    if (!file) return;
    try { setImage(await resizeToDataUrl(file)); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not read that image.', 'error'); }
  };

  const submit = async () => {
    if (busy) return;
    if (!plate.trim() && !description.trim()) return toast('Add a license plate or a description.', 'error');
    if (!location.trim()) return toast('Say where the car is.', 'error');
    if (!reason.trim()) return toast('Give a reason.', 'error');
    const targets = allDisplays || selected.length === 0 ? ['*'] : selected;
    setBusy(true);
    try {
      await volApi.addReport({ plate, description, location, reason, image: image || undefined, targets });
      setPlate(''); setDescription(''); setLocation(''); setReason(''); setImage('');
      toast('Reported — it will show on the screens.');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not post the report.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try { await volApi.removeReport(id); await load(); toast('Removed.'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not remove it.', 'error'); }
  };

  const targetLabel = (t: string[]) =>
    t.includes('*') ? 'All displays' : t.map((id) => timetables.find((x) => x.id === id)?.name ?? '?').join(', ');

  return (
    <div className="vol-list">
      <div className="vol-card glass-raised">
        <h2 className="page-title" style={{ fontSize: '1.15rem', marginBlockEnd: '0.6rem' }}>Report incorrect parking</h2>

        <label className="muted" style={{ display: 'block', marginBlockEnd: '0.25rem' }}>Show on</label>
        <div className="vol-chips">
          <button type="button" className={`vol-chip${allDisplays ? ' is-active' : ''}`} onClick={() => setAllDisplays(true)}>All displays</button>
          {timetables.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`vol-chip${!allDisplays && selected.includes(t.id) ? ' is-active' : ''}`}
              onClick={() => { setAllDisplays(false); toggleDisplay(t.id); }}
            >
              {t.name}
            </button>
          ))}
        </div>

        <div style={{ display: 'grid', gap: '0.55rem', marginBlockStart: '0.7rem' }}>
          <input className="input" placeholder="License plate (e.g. ABC 1234)" value={plate} onChange={(e) => setPlate(e.target.value)} />
          <input className="input" placeholder="Car — colour, make, model" value={description} onChange={(e) => setDescription(e.target.value)} />
          <input className="input" placeholder="Where is it? (e.g. Blocking the ramp)" value={location} onChange={(e) => setLocation(e.target.value)} />
          <input className="input" placeholder="Reason (e.g. Blocking a fire lane)" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBlockStart: '0.7rem' }}>
          <label className="btn btn--ghost" style={{ cursor: 'pointer' }}>
            <IconCamera size={16} /> {image ? 'Change photo' : 'Add photo'}
            <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void onPhoto(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {image && <img src={image} alt="" style={{ width: '3rem', height: '3rem', objectFit: 'cover', borderRadius: '0.5rem' }} />}
          {image && <button type="button" className="icon-btn" aria-label="Remove photo" onClick={() => setImage('')}>✕</button>}
        </div>

        <button className="btn btn--primary btn--block" style={{ marginBlockStart: '0.8rem' }} disabled={busy} onClick={submit}>
          {busy ? <Spinner /> : 'Post to the screens'}
        </button>
      </div>

      <h3 className="muted" style={{ margin: '0.4rem 0.2rem' }}>On the screens now</h3>
      {reports.length === 0 && <p className="muted" style={{ padding: '0 0.2rem' }}>Nothing reported right now.</p>}
      {reports.map((r) => (
        <div key={r.id} className="vol-tv glass-raised" style={{ padding: '0.7rem 0.85rem', display: 'flex', gap: '0.7rem', alignItems: 'center' }}>
          {r.hasImage && <img src={volApi.reportImageUrl(r.id)} alt="" style={{ width: '3.2rem', height: '3.2rem', objectFit: 'cover', borderRadius: '0.5rem', flex: '0 0 auto' }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{r.plate || r.description || 'Vehicle'}</div>
            <div className="muted" style={{ fontSize: '0.85rem' }}>{r.location} · {r.reason}</div>
            <div className="muted" style={{ fontSize: '0.75rem' }}>{targetLabel(r.targets)}</div>
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void remove(r.id)}>Remove</button>
        </div>
      ))}
    </div>
  );
}

function OptBtn({ active, icon, label, onClick }: { active: boolean; icon: JSX.Element; label: string; onClick: () => void }) {
  return (
    <button type="button" className={`vol-opt${active ? ' is-active' : ''}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {active && <IconCheck size={15} />}
    </button>
  );
}
