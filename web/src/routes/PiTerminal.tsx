// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A real terminal on a Raspberry Pi screen.
 *
 * The screen is not reachable from here — it sits behind a masjid's NAT and holds a capability
 * rather than listening on a port — so this does not connect to it. It asks the display server for a
 * session, the server offers that session to the screen on its next poll, and the SCREEN dials back
 * out. Both sockets meet in the middle and bytes are copied. See server/src/piShell.ts.
 *
 * Two consequences show up in this file:
 *
 *  - **There is a wait at the start.** The screen learns about the session on its ordinary poll, so
 *    a second or two passes before anything appears. That wait is named on screen rather than left
 *    as a blank rectangle, because a blank terminal is indistinguishable from a broken one.
 *  - **The size is fixed for the life of the session.** It is sent when the session is minted and
 *    applied with `stty` inside the pty; there is no handle to resize it afterwards without a native
 *    module on the device. Resizing the window mid-session reflows the canvas but not the shell, so
 *    the terminal is measured once, on open.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Spinner } from '../ui';

type Phase = 'opening' | 'waiting' | 'live' | 'ended';

/** Where the panel's own WebSockets live, built from the page's URL so it works on the LAN and
 *  behind the platform's tunnel (where this app is served under /<appId>/) with nothing set. */
function wsBase(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}`;
}

export function PiTerminal({ deviceId, onFallback }: { deviceId: string; onFallback: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>('opening');
  const [note, setNote] = useState('');

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let term: any = null;
    let waitTimer: ReturnType<typeof setTimeout> | null = null;

    const stop = (why: string, ended = true) => {
      if (waitTimer) clearTimeout(waitTimer);
      waitTimer = null;
      if (disposed) return;
      setNote(why);
      if (ended) setPhase('ended');
    };

    (async () => {
      // Loaded on demand: a terminal emulator is a quarter of a megabyte, and most people opening
      // the panel never open one.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      await import('@xterm/xterm/css/xterm.css');
      if (disposed || !hostRef.current) return;

      term = new Terminal({
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        cursorBlink: true,
        // Matches the app's own inset surfaces rather than xterm's default black, so the window
        // reads as part of the panel.
        theme: { background: '#0b1626', foreground: '#e6f0fa', cursor: '#7dd3fc' },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      try {
        fit.fit();
      } catch {
        /* not measurable yet */
      }

      // Measured ONCE — see the note at the top of this file.
      const rows = Math.max(8, Math.min(200, term.rows || 24));
      const cols = Math.max(20, Math.min(400, term.cols || 80));

      let session: { id: string; claimMs: number };
      try {
        session = await api.piTerminalOpen(deviceId, rows, cols);
      } catch (e) {
        stop(e instanceof Error ? e.message : 'Could not ask the display server for a terminal.');
        return;
      }
      if (disposed) return;
      setPhase('waiting');

      ws = new WebSocket(`${wsBase()}/api/pi/shell/${encodeURIComponent(session.id)}`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        // Connected to the SERVER. The screen may not have dialled in yet, so this is not "live".
        waitTimer = setTimeout(() => {
          if (!disposed && phaseRef.current === 'waiting') {
            stop('This screen did not pick up the terminal. It may be offline, or running an agent too old to offer one — try Update under Maintenance.');
          }
        }, session.claimMs + 4000);
      };
      ws.onmessage = (ev) => {
        if (disposed) return;
        // The first byte from the far end is the only proof the screen actually attached.
        if (phaseRef.current !== 'live') {
          setPhase('live');
          setNote('');
          if (waitTimer) clearTimeout(waitTimer);
        }
        term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
      };
      ws.onclose = () => stop('Session closed.');
      ws.onerror = () => stop('The connection to the display server dropped.');

      term.onData((d: string) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(d);
      });
    })().catch((e) => stop(e instanceof Error ? e.message : 'Could not start a terminal.'));

    return () => {
      disposed = true;
      if (waitTimer) clearTimeout(waitTimer);
      try {
        ws?.close();
      } catch {
        /* already gone */
      }
      try {
        term?.dispose();
      } catch {
        /* already gone */
      }
    };
    // deviceId is the only real input; re-running on anything else would drop a live session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  // The effect closes over `phase`, so it reads it through a ref rather than a stale capture.
  const phaseRef = useRef<Phase>('opening');
  phaseRef.current = phase;

  return (
    <>
      <div className="pi-term" ref={hostRef} />
      <div className="pi-row" style={{ marginBlockStart: '0.5rem' }}>
        {phase === 'opening' && <span className="hint muted"><Spinner /> starting…</span>}
        {phase === 'waiting' && <span className="hint muted"><Spinner /> waiting for the screen to pick this up…</span>}
        {phase === 'live' && <span className="hint" style={{ color: 'var(--color-success)' }}>connected</span>}
        {note && <span className="hint muted">{note}</span>}
        {phase === 'ended' && (
          <button className="btn btn--ghost btn--sm" onClick={onFallback}>
            Run a single command instead
          </button>
        )}
      </div>
      <p className="hint muted pi-note">
        A root shell on the screen — the whole machine, including <code>reboot</code>. The session
        closes after ten idle minutes and cannot last more than an hour. Nothing typed here is
        written to any log.
      </p>
    </>
  );
}
