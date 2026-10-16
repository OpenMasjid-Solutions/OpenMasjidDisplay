// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * What a Raspberry Pi shows on its own address once a Display server has adopted it.
 *
 * One page, read-only, no sign-in. It exists for one day: the day the display server stops
 * answering. Until then an admin manages this screen from the dashboard and never opens this page;
 * on that day they walk up to the screen, open its address, and need to be told what it thinks is
 * happening and where it was being managed from.
 *
 * So the page leads with the two facts that matter in that moment — which server owns this screen,
 * and whether that server is answering — and says the rest plainly underneath. It deliberately
 * offers no buttons: everything about this screen lives on the server, and a control here would
 * either do nothing or change a copy nothing reads.
 */
import { useEffect, useState } from 'react';
import { Spinner, IconCheck } from '../ui';

interface Status {
  screenName: string;
  hostname: string;
  ip: string;
  model: string;
  agentVersion: string;
  server: string;
  serverReachable: boolean;
  lastContactAt: string | null;
  content: 'timetable' | 'camera' | 'off' | 'nothing';
  clockSuspect: boolean;
  displayOff: boolean;
}

const SHOWING: Record<Status['content'], string> = {
  timetable: 'A prayer timetable',
  camera: 'A camera',
  off: 'Nothing — the screen is switched off',
  nothing: 'Nothing yet',
};

/** "4 minutes ago", for the one timestamp this page shows. */
function ago(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 60) return `${secs} second${secs === 1 ? '' : 's'} ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function ManagedScreen() {
  const [st, setSt] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const load = async (): Promise<void> => {
      try {
        const r = await fetch('/api/pi/self', { cache: 'no-store' });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as Status;
        if (live) {
          setSt(j);
          setFailed(false);
        }
      } catch {
        if (live) setFailed(true);
      }
    };
    void load();
    // The page is read by somebody standing in front of the screen while something is wrong, so it
    // keeps itself current rather than needing a refresh.
    const t = setInterval(() => void load(), 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (!st) {
    return (
      <div className="panel glass" style={{ maxWidth: '46rem', margin: '2rem auto' }}>
        {failed ? (
          <p className="hint">
            This screen’s software is not answering. It may be restarting — this page will keep
            trying.
          </p>
        ) : (
          <p className="hint">
            <Spinner /> Asking this screen how it is getting on…
          </p>
        )}
      </div>
    );
  }

  const rows: [string, string][] = [
    ['Showing', SHOWING[st.content] + (st.displayOff ? ' (output off)' : '')],
    ['This screen’s address', st.ip ? `http://${st.ip}` : 'unknown'],
    ['Name on the dashboard', st.screenName || 'not named yet'],
    ['Computer name', st.hostname || 'unknown'],
    ['Board', st.model || 'unknown'],
    ['Screen software', st.agentVersion],
  ];

  return (
    <div style={{ maxWidth: '46rem', margin: '2rem auto', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* The headline: who owns this screen, and can it be reached. Everything else is detail. */}
      <div className="panel glass">
        <h2 className="section-title" style={{ marginTop: 0 }}>
          {st.screenName || 'This screen'}
        </h2>
        <p style={{ marginBottom: '0.75rem' }}>
          This screen is <b>managed by a Display server</b>. Its prayer times, its settings and what
          it shows all live there — there is nothing to change on this page.
        </p>
        <p className="hint" style={{ marginBottom: '1rem' }}>
          {st.server ? (
            <>
              Manage it at{' '}
              <a href={st.server} target="_blank" rel="noreferrer noopener">
                {st.server}
              </a>
              , under <b>Screens</b>.
            </>
          ) : (
            'It has not been told which server manages it.'
          )}
        </p>

        {/* The one thing worth a colour. A screen whose server has gone quiet may be showing a
            decision that was changed hours ago, and that is exactly what somebody opening this
            page is trying to find out. */}
        <p className="pill" style={st.serverReachable ? undefined : { color: 'var(--color-warning)' }}>
          {st.serverReachable ? (
            <>
              <IconCheck size={14} /> In contact with the server
            </>
          ) : (
            <>Not in contact with the server</>
          )}
        </p>
        {!st.serverReachable && (
          <p className="hint" style={{ marginBlockStart: '0.6rem' }}>
            {st.lastContactAt
              ? `It last heard from the server ${ago(st.lastContactAt)}. What is on the television may be out of date.`
              : 'It has not reached the server since it started. What is on the television is whatever it drew last.'}
          </p>
        )}
      </div>

      {st.clockSuspect && (
        <div className="panel glass">
          <h3 className="section-title" style={{ marginTop: 0 }}>This screen does not know the date</h3>
          <p className="hint" style={{ margin: 0 }}>
            A Raspberry Pi has no battery-backed clock, so after a power cut it does not know the
            time until it reaches the internet. Rather than show prayer times that would be
            confidently wrong, it is refusing to show any. It fixes itself within a minute of being
            online.
          </p>
        </div>
      )}

      <div className="panel glass">
        <h3 className="section-title" style={{ marginTop: 0 }}>About this screen</h3>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.45rem 1.2rem', margin: 0 }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt className="muted" style={{ whiteSpace: 'nowrap' }}>
                {k}
              </dt>
              <dd style={{ margin: 0 }}>{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      <p className="hint" style={{ textAlign: 'center' }}>
        To manage this screen on its own instead, run the standalone installer on it again. Its old
        timetables and password are still here.
      </p>
    </div>
  );
}
