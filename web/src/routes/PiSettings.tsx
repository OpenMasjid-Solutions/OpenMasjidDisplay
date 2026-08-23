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
import { Modal, Spinner, IconDownload, IconPower, IconCheck, IconSparkle, IconCopy, IconTerminal, copyText, useToast } from '../ui';
import { WifiSection } from './WifiPanel';
import { PiTerminal } from './PiTerminal';
import { PiDisplaySection } from './PiDisplayPanel';
import { PiSystemSection } from './PiSystemPanel';

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
          style={{ width: `${Math.min(100, percent)}%`, background: over ? 'var(--color-warning)' : 'var(--color-primary)' }}
        />
      </span>
      <span className="hint muted pi-meter__text">{text}</span>
    </span>
  );
}

/** How long after asking for an install we keep saying "installing" — see the card's own note. */
const UPDATE_WINDOW_MS = 6 * 60_000;

/** How long to wait for a screen to answer a console command before saying so. Comfortably past
 *  the device's own 20s kill and the poll that carries the answer, and comfortably inside the
 *  120s life of a queued command — so "no answer" here means the screen, not the timing. */
const CONSOLE_WAIT_MS = 45_000;

/**
 * Keep this window's copy of the device fresh, faster than the page behind it does.
 *
 * The Screens page polls every ten seconds, which is right for a wall of cards: it is the cadence
 * the device checks in at. It is wrong for this window. "Live" logs were being ASKED for every six
 * seconds and only ARRIVING every ten, so the tail moved in lurches and sometimes appeared to stop;
 * and a console whose answer takes ten seconds to become visible is not a console.
 *
 * So the window polls its own row while it is open, and faster while something is actually pending.
 * The slower rate for the idle case is not politeness — the row carries the whole collected journal,
 * which is up to 180 KB, and re-fetching that twice a second to watch a static page is real traffic
 * through a masjid's tunnel.
 */
function useLiveDevice(initial: PiDeviceInfo, everyMs: number): PiDeviceInfo {
  const [fresh, setFresh] = useState<PiDeviceInfo | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .piDevices()
        .then((r) => {
          const d = r.devices.find((x) => x.id === initial.id);
          // A failed poll must not blank the window: keep showing the last good answer.
          if (alive && d) setFresh(d);
        })
        .catch(() => {});
    void load();
    const t = setInterval(() => void load(), everyMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [initial.id, everyMs]);
  return fresh ?? initial;
}

export function PiSettings({
  device: initial,
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

  // ── the console ──
  const [consoleOpen, setConsoleOpen] = useState(false);
  /**
   * Which kind of session the window shows.
   *
   * 'terminal' is the real thing and what the button opens. 'single' is the one-shot console, kept
   * because it is the only one that works on a screen whose agent is too old to offer a terminal —
   * and an unclaimed session is exactly the symptom of that, so the terminal offers the swap itself.
   */
  const [sessionKind, setSessionKind] = useState<'terminal' | 'single'>('terminal');
  const [cmd, setCmd] = useState('');
  /** The scrollback, kept HERE rather than on the server. The device answers one command at a time
   *  and the store keeps one answer; the conversation only exists in the window having it. */
  const [term, setTerm] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const termRef = useRef<HTMLPreElement | null>(null);
  /**
   * The answer id already shown.
   *
   * Seeded from whatever the row arrived with, which matters: the store holds the last answer for
   * ever, so a window opened a week later would otherwise print a week-old command and its output
   * as though it had just been run.
   */
  const shownRef = useRef<string | null>(null);
  if (shownRef.current === null) shownRef.current = initial.shellResult?.id ?? '';

  const device = useLiveDevice(initial, live || running ? 2000 : 8000);

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

  /** An answer has arrived. Matched by id, not by "something changed": the row is re-fetched every
   *  couple of seconds and the same answer would otherwise be printed on every poll. */
  useEffect(() => {
    const r = device.shellResult;
    if (!r || !r.id || r.id === shownRef.current) return;
    shownRef.current = r.id;
    const took = r.ms >= 1000 ? `${(r.ms / 1000).toFixed(1)}s` : `${r.ms}ms`;
    setTerm((t) => [...t, r.out, r.code === 0 ? `[${took}]` : `[exit ${r.code ?? '?'} · ${took}]`].slice(-400));
    setRunning(false);
  }, [device.shellResult]);

  /** Say so when nothing comes back, rather than spinning for ever. A screen that is unplugged, or
   *  one whose agent is too old to know what a console command is, both look like this. */
  useEffect(() => {
    if (!running) return;
    const t = setTimeout(() => {
      setRunning(false);
      setTerm((prev) => [...prev, 'No answer from the screen. It may be offline, or running an agent too old for this.']);
    }, CONSOLE_WAIT_MS);
    return () => clearTimeout(t);
  }, [running]);

  useEffect(() => {
    const el = termRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [term]);

  /** Send one line. It is queued, like everything else here — the screen collects it on its poll. */
  const runCmd = async () => {
    const line = cmd.trim();
    if (!line || running) return;
    setHistory((h) => [...h.filter((x) => x !== line), line].slice(-50));
    setHistIdx(-1);
    setCmd('');
    setTerm((t) => [...t, `$ ${line}`].slice(-400));
    setRunning(true);
    try {
      await api.piCommand(device.id, 'shell', undefined, line);
    } catch (e) {
      setRunning(false);
      setTerm((t) => [...t, e instanceof Error ? e.message : 'Could not reach the display server.']);
    }
  };

  /** Up and down through what has been typed, because a console without that is a form. */
  const onConsoleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (!history.length) return;
    e.preventDefault();
    const next = e.key === 'ArrowUp' ? Math.min(history.length - 1, histIdx + 1) : histIdx - 1;
    setHistIdx(next);
    setCmd(next < 0 ? '' : history[history.length - 1 - next]);
  };

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
              <span className="hint" style={{ color: 'var(--color-warning)' }}>
                · installing…
              </span>
            ) : (
              <span
                className="hint"
                style={{ color: device.upToDate ? 'var(--color-success)' : 'var(--color-warning)' }}
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

      <PiDisplaySection device={device} screenName={screenName} />

      <PiSystemSection device={device} />

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
        <h3 className="pi-sec__title">Terminal</h3>
        <div className="pi-row">
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setSessionKind('terminal');
              setConsoleOpen(true);
            }}
          >
            <IconTerminal size={14} /> Open terminal
          </button>
        </div>
        <p className="hint muted pi-note">
          A real root shell on the screen, in its own window you can drag aside and keep open while
          you work here. Nothing connects to the screen: it is offered a session on its next check-in
          and dials back out, so this works through a masjid&rsquo;s router with nothing forwarded and
          no port open on the Pi.
        </p>
        <p className="hint muted pi-note">
          <strong>It is the whole machine.</strong> You can reboot it, install packages, read any log,
          edit any file. Treat it as you would a terminal on the server itself: the session closes
          after ten idle minutes, cannot last more than an hour, and nothing typed in it is written to
          any log — but while it is open there is nothing on that screen it cannot do.
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
                  ? `Already running ${device.agentVersion}. Running this again installs system updates and re-applies its setup.`
                  : "Install system updates and the current version of this app, and re-apply the screen's setup"
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
          <strong>Update</strong> does both halves at once: the operating system&rsquo;s own security
          updates, and then this app. In that order, and as one job — the installer fetches packages
          itself, so two updates at the same time would fight over the package lock. It takes a few
          minutes and the screen restarts itself when it is done.
        </p>
        <p className="hint muted pi-note">
          Nothing here is sent to the screen directly — it collects instructions on its own, every few
          seconds. So these say <em>asked</em>, never <em>done</em>.
        </p>
      </section>

      {/* Its own window, floating over this one rather than replacing a section of it: the whole
          reason to open a console on a screen is to try something and then look at the rest of the
          screen's state, and a panel that pushed Maintenance off the bottom made that a scroll each
          way. Being draggable is what makes the two usable together.

          Kept mounted inside this window, so the scrollback lives exactly as long as the settings
          window does — close the settings and the console goes with it. */}
      {consoleOpen && (
        <Modal
          open
          floating
          term
          wide
          title={`${screenName} — ${sessionKind === 'terminal' ? 'terminal' : 'single command'}`}
          onClose={() => setConsoleOpen(false)}
        >
          {sessionKind === 'terminal' ? (
            <PiTerminal deviceId={device.id} onFallback={() => setSessionKind('single')} />
          ) : (
            <>
              <pre className="pi-log pi-log--term" ref={termRef}>
                {term.length
                  ? term.join('\n')
                  : 'Runs one line on the screen and shows what it said.\n\nTry:  free -m\n      vcgencmd measure_temp\n      nmcli device status'}
              </pre>
              <div className="pi-row pi-console">
                <span className="pi-console__prompt" aria-hidden="true">
                  $
                </span>
                <input
                  className="input pi-console__input"
                  value={cmd}
                  onChange={(e) => setCmd(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void runCmd();
                    } else onConsoleKey(e);
                  }}
                  placeholder={running ? 'waiting for the screen…' : 'a command to run on this screen'}
                  aria-label="Command to run on this screen"
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  disabled={running}
                  autoFocus
                />
                <button className="btn btn--sm btn--primary" disabled={running || !cmd.trim()} onClick={() => void runCmd()}>
                  {running ? <Spinner /> : 'Run'}
                </button>
                {term.length > 0 && (
                  <button className="btn btn--ghost btn--sm" onClick={() => setTerm([])} title="Clear the scrollback">
                    Clear
                  </button>
                )}
              </div>
              <p className="hint muted pi-note">
                One command at a time, queued for the screen&rsquo;s next check-in — what a screen too
                old for a terminal can still do. Unlike the terminal, this runs as the screen&rsquo;s
                own limited account with no <code>sudo</code>, so <code>reboot</code> and anything else
                needing root will not work here. 20 seconds and 10,000 characters per command.
              </p>
            </>
          )}
        </Modal>
      )}
    </Modal>
  );
}
