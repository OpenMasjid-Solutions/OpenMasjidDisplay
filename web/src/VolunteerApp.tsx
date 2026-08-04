// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * VolunteerApp — the bone-simple, PIN-gated mobile page served on the volunteer
 * port. A volunteer unlocks with the PIN, sees every screen, and taps to switch
 * what each one shows. Same liquid-glass look as the dashboard.
 */
import { useEffect, useState } from 'react';
import { volApi, type VolunteerData } from './api';
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
      {phase === 'ready' && <VolBoard onLock={() => void volApi.logout().finally(refreshSession)} />}
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

function VolBoard({ onLock }: { onLock: () => void }) {
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
      if (content.kind === 'off') await volApi.set(tvId, { kind: 'off' });
      else await volApi.set(tvId, content);
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
    <div className="vol-wrap">
      <header className="vol-head">
        <div className="brand"><MasjidMark size={22} /> <b>Screens</b></div>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => void load()} aria-label="Refresh"><IconRefresh size={18} /></button>
        <button className="icon-btn" onClick={onLock} aria-label="Lock"><IconPower size={18} /></button>
      </header>

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
