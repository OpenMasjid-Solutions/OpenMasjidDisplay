// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Everything you can do TO a Raspberry Pi screen, in one window behind the gear.
 *
 * A screen card answers "what is this screen showing?", and that is the question somebody has on
 * the Screens page. What version its agent is running, whether it is on Wi-Fi, and whether to
 * reboot it are a different question — asked rarely, and by somebody who has come looking. Four
 * buttons and three lines of device facts on every card put the rare question in front of the
 * common one, and on a masjid with six screens it made the page unreadable.
 *
 * So the card keeps a single status line — alive, where, how attached, what version — because that
 * is glanceable and is the thing you scan a wall of cards for. Everything actionable is in here.
 *
 * Only Pi screens get the gear. A decoder screen and a browser screen have nothing behind it.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { PiDeviceInfo } from '../types';
import { Modal, Spinner, IconDownload, IconPower, IconCheck, IconSparkle, IconCopy, copyText, useToast } from '../ui';
import { WifiSection } from './WifiPanel';

/**
 * What to say about the log's age.
 *
 * Three states, and the middle one is the one that matters: between asking and the log arriving
 * there is a real gap — the device collects it on its own poll — and saying nothing there is what
 * made the Update button look broken twice. So the wait is named.
 */
function logStatus(device: { journalAt?: string; journal?: string }, askedAt: number): string {
  const waiting = askedAt > 0 && (!device.journalAt || new Date(device.journalAt).getTime() < askedAt);
  if (waiting) return 'waiting for the screen to send it…';
  if (!device.journalAt) return 'not collected yet';
  const mins = Math.round((Date.now() - new Date(device.journalAt).getTime()) / 60_000);
  if (mins < 1) return 'collected just now';
  return `collected ${mins} minute${mins === 1 ? '' : 's'} ago`;
}

/** "3d 4h", "2h 15m", "8m" — enough to answer "did it restart recently?" and no more. */
function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * A labelled bar. Over 100% is drawn full and coloured, rather than clamped silently — a board at
 * 150% of its cores is the state somebody opened this window to find, and a bar that cannot show it
 * is worse than a number.
 */
function Meter({ label, percent, text }: { label: string; percent: number; text: string }) {
  const over = percent > 90;
  return (
    <span className="pi-meter" title={`${label}: ${text}`}>
      <span className="pi-meter__label">{label}</span>
      <span className="pi-meter__track">
        <span
          className="pi-meter__fill"
          style={{ width: `${Math.min(100, percent)}%`, background: over ? 'var(--color-warn, #fbbf24)' : 'var(--color-primary)' }}
        />
      </span>
      <span className="hint muted pi-meter__text">{text}</span>
    </span>
  );
}

/** How long after asking for an install we keep saying "installing" — see the card's own note. */
const UPDATE_WINDOW_MS = 6 * 60_000;

export function PiSettings({
  device,
  screenName,
  badge,
  onClose,
}: {
  device: PiDeviceInfo;
  screenName: string;
  /** the same link indicator the card draws, so the two cannot disagree */
  badge: React.ReactNode;
  onClose: () => void;
}) {
  const toast = useToast();
  const [sending, setSending] = useState<'' | 'reboot' | 'reinstall' | 'logs'>('');
  const [showLog, setShowLog] = useState(false);
  /** When we asked, so the viewer can say "waiting" instead of showing a stale log as current. */
  const [askedAt, setAskedAt] = useState(0);
  /** Keep asking, so the log reads like a terminal rather than a snapshot. */
  const [live, setLive] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);

  const updating = !!device.updateAskedAt && Date.now() - device.updateAskedAt < UPDATE_WINDOW_MS && !device.upToDate;

  /** Queue an instruction. Nothing connects TO the Pi — it collects this on its own poll. */
  const ask = async (action: 'reboot' | 'reinstall' | 'logs') => {
    setSending(action);
    try {
      await api.piCommand(device.id, action);
      toast(
        action === 'reboot'
          ? 'Asked the Raspberry Pi to reboot. It will be back in about a minute.'
          : action === 'logs'
            ? 'Asked the screen for its log. It arrives in a few seconds.'
            : 'Asked the screen to update. It takes a few minutes and restarts itself when it is done.',
      );
      if (action === 'logs') {
        setAskedAt(Date.now());
        setShowLog(true);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not reach the display server.', 'error');
    } finally {
      setSending('');
    }
  };

  /**
   * While Live is on, re-ask every few seconds.
   *
   * This is a polling device: nothing can be pushed to it, and it collects instructions on its own
   * loop. So "live" is honestly a fast repeat rather than a stream — the cadence below is a little
   * slower than the device's own poll, because asking faster than it can answer only queues work.
   *
   * It stops when the window closes, because the effect is torn down with it. A timer that outlived
   * the window would keep a masjid's screen collecting logs for nobody.
   */
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      setAskedAt(Date.now());
      void api.piCommand(device.id, 'logs').catch(() => {
        /* a missed tick is not worth a toast every six seconds */
      });
    }, 6000);
    return () => clearInterval(t);
  }, [live, device.id]);

  /** Follow the tail, the way a terminal does — but only when already at the bottom, so reading
   *  back through it is not yanked away on the next tick. */
  useEffect(() => {
    const el = logRef.current;
    if (!el || !showLog) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [device.journal, showLog]);

  return (
    <Modal
      open
      windowed
      onClose={onClose}
      title={`${screenName} — Raspberry Pi`}
      footer={
        <button className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <section className="pi-sec">
        <h3 className="pi-sec__title">This screen</h3>
        <div className="pi-row">
          <span
            className={`status-dot${device.online ? '' : ' status-dot--idle'}`}
            title={device.online ? 'Checking in' : 'Not checking in'}
          />
          <span className="hint">{device.model || 'Raspberry Pi'}</span>
          <span className="hint" style={{ fontFamily: 'monospace' }}>
            {device.ip || 'address unknown'}
          </span>
          {badge}
        </div>
        <div className="pi-row">
          <span className="hint muted">agent {device.agentVersion || '?'}</span>
          {device.agentVersion ? (
            updating ? (
              <span className="hint" style={{ color: 'var(--color-warn, #fbbf24)' }}>
                · installing…
              </span>
            ) : (
              <span
                className="hint"
                style={{ color: device.upToDate ? 'var(--color-ok, #4ade80)' : 'var(--color-warn, #fbbf24)' }}
              >
                {device.upToDate ? '· up to date' : '· update available'}
              </span>
            )
          ) : null}
        </div>
      </section>

      <section className="pi-sec">
        <h3 className="pi-sec__title">Load</h3>
        {device.stats ? (
          <div className="pi-row">
            <Meter label="CPU" percent={device.stats.cpuPercent} text={`${device.stats.cpuPercent}% of ${device.stats.cores} cores`} />
            <Meter label="Memory" percent={device.stats.memPercent} text={`${device.stats.memUsedMb} of ${device.stats.memTotalMb} MB`} />
            {device.stats.tempC > 0 && (
              <span className="hint muted">{device.stats.tempC}&deg;C</span>
            )}
            <span className="hint muted">up {formatUptime(device.stats.uptimeSec)}</span>
          </div>
        ) : (
          <p className="hint muted">Not reported yet — it arrives with the screen&rsquo;s next check-in.</p>
        )}
      </section>

      <section className="pi-sec">
        <h3 className="pi-sec__title">Network</h3>
        <WifiSection device={device} badge={badge} />
      </section>

      <section className="pi-sec">
        <h3 className="pi-sec__title">Log</h3>
        <div className="pi-row">
          <button className="btn btn--ghost btn--sm" disabled={sending !== ''} onClick={() => void ask('logs')}>
            {sending === 'logs' ? <Spinner /> : <IconSparkle size={14} />} {device.journal ? 'Refresh log' : 'Get the log'}
          </button>
          <button
            className={`btn btn--sm${live ? ' btn--primary' : ' btn--ghost'}`}
            onClick={() => {
              setLive((v) => !v);
              if (!live) {
                setShowLog(true);
                void ask('logs');
              }
            }}
            title="Keep asking, so the log updates by itself"
          >
            {live ? 'Live · stop' : 'Live'}
          </button>
          {device.journal && (
            <>
              <button className="btn btn--ghost btn--sm" onClick={() => setShowLog((v) => !v)}>
                {showLog ? 'Hide' : 'Show'}
              </button>
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => void copyText(device.journal ?? '').then(() => toast('Log copied.'))}
                title="Copy the whole log, to paste into an email"
              >
                <IconCopy size={14} /> Copy
              </button>
            </>
          )}
          {/* Staleness stated, always. A log collected ten minutes ago read as current is worse than
              no log: somebody debugs the wrong moment and concludes the fault has moved. */}
          <span className="hint muted">{logStatus(device, askedAt)}</span>
        </div>
        {showLog && (
          <pre className="pi-log pi-log--term" ref={logRef}>
            {device.journal || 'Nothing yet. The screen sends this when asked, within a few seconds.'}
          </pre>
        )}
        <p className="hint muted pi-note">
          This is the screen&rsquo;s own record of what it has been doing — which camera it opened, why
          one failed, what happened during setup. Any passwords in it are removed on the screen before
          it is sent.
        </p>
      </section>

      <section className="pi-sec">
        <h3 className="pi-sec__title">Maintenance</h3>
        <div className="pi-row">
          {/* ONE update button. It runs the whole installer, so it replaces the agent AND re-applies
              the boot settings and the service unit — there used to be a separate "Re-run setup" for
              the latter, and choosing between them was impossible because both answers to "my screen
              needs the newest thing" were correct. */}
          <button
            className="btn btn--ghost btn--sm"
            disabled={sending !== '' || updating}
            title={
              updating
                ? 'This screen is installing now. It takes a few minutes and restarts itself when it is done.'
                : device.upToDate
                  ? `Already running ${device.agentVersion}. Running this again re-applies its setup.`
                  : 'Install the current version on this screen and re-apply its setup'
            }
            onClick={() => void ask('reinstall')}
          >
            {sending === 'reinstall' || updating ? <Spinner /> : <IconDownload size={14} />}{' '}
            {updating ? 'Updating…' : 'Update'}
          </button>

          {/* A full power cycle of the board. Rate limited ON THE DEVICE to one every ten minutes,
              because a reboot loop takes a screen off the wall for good and nobody is watching. */}
          <button
            className="btn btn--ghost btn--sm"
            disabled={sending !== ''}
            title="Restart the whole Raspberry Pi"
            onClick={() => void ask('reboot')}
          >
            {sending === 'reboot' ? <Spinner /> : <IconPower size={14} />} Reboot
          </button>

          {device.upToDate && !updating && (
            <span className="hint muted" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
              <IconCheck size={13} /> nothing to install
            </span>
          )}
        </div>
        <p className="hint muted pi-note">
          Nothing here is sent to the screen directly — it collects instructions on its own, every few
          seconds. So these say <em>asked</em>, never <em>done</em>.
        </p>
      </section>
    </Modal>
  );
}
