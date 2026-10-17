// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Pointing a standalone screen at a display server, from the screen's own panel.
 *
 * This is the half of adoption that works when the server cannot reach the screen — which is most
 * of the time the server is not in the building. A display server behind a Cloudflare tunnel has a
 * public address the screen can dial out to; the screen behind the masjid's NAT has none the
 * server could dial in to. So the direction has to reverse, and the address is typed here.
 *
 * ## Why this does not finish the job by itself
 *
 * Giving an address does not adopt the screen: it makes the screen enrol and show a pairing code,
 * which somebody then approves in that server's dashboard. That second step is not friction left
 * in by accident. Whoever holds this screen's password has proved they administer THIS SCREEN, and
 * nothing more — it says nothing about whether they may add a screen to that masjid's dashboard,
 * change what a congregation sees on it, or consume a licence. The server's own admin decides
 * that, by typing the code.
 *
 * The code is shown here as well as on the television, so nobody has to walk across the hall to
 * read it, and the panel stays signed-in and writable throughout: a mistyped address is corrected
 * in the box below rather than with a keyboard plugged into the Pi.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Field, Spinner, useToast, IconCheck } from '../ui';

export interface LinkState {
  server: string;
  adopted: boolean;
  code: string;
  connected: boolean;
  status: string;
}

/**
 * Everything the view needs, so that it needs nothing else.
 *
 * Split out from the section below for one reason: the states this page moves through are the
 * feature, and none of them could be rendered in a test while the component fetched its own data
 * and read a toast out of context. As a pure function of its props it renders under
 * `renderToStaticMarkup` with no network, no providers and no DOM — see ServerLink.test.tsx,
 * which is what caught that an approved screen went on asking for its code.
 */
export interface ServerLinkViewProps {
  /** null while the first poll is in flight */
  st: LinkState | null;
  address: string;
  busy: boolean;
  onAddress: (value: string) => void;
  onSave: (server: string) => void;
}

export function ServerLinkSection() {
  const toast = useToast();
  const [st, setSt] = useState<LinkState | null>(null);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);

  // Polled rather than fetched once: once an address is set, the interesting part — the pairing
  // code, and whether the server is answering at all — arrives from the agent's enrolment loop a
  // few seconds later, and somebody is watching this page for exactly that.
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .piLinkStatus()
        .then((r) => void (live && setSt(r)))
        .catch(() => {});
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  const save = async (server: string) => {
    setBusy(true);
    try {
      await api.piJoinServer(server);
      setAddress('');
      toast(server ? 'Connecting — a code will appear here in a moment.' : 'Disconnected. This screen is on its own again.');
      // Pull the new state straight away so the page turns over without waiting for the poll —
      // but never let THAT failing report the save as failed. The save has already happened, and
      // the poll three seconds later will catch up.
      await api.piLinkStatus().then(setSt).catch(() => {});
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save that address.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return <ServerLinkView st={st} address={address} busy={busy} onAddress={setAddress} onSave={(s) => void save(s)} />;
}

export function ServerLinkView({ st, address, busy, onAddress, onSave }: ServerLinkViewProps) {
  if (!st) {
    return (
      <p className="hint">
        <Spinner /> Checking…
      </p>
    );
  }

  /**
   * Approved, and about to hand over.
   *
   * Its own state, above the waiting one, for two reasons — and the second is not cosmetic.
   *
   * The code is SPENT the moment the server accepts it, but the agent keeps reporting it until it
   * restarts five or six seconds later. Left to the branch below, the page would go on saying
   * "enter this code" at the exact moment the thing worked, which reads as a failure to whoever
   * just typed it.
   *
   * And the Cancel button below must not be reachable here. Pressing it in that window writes an
   * empty server and drops the token the screen has just been given, so the screen stays
   * standalone while the display server keeps an adopted row for a device that will never call —
   * a screen that is permanently offline on one side and absent on the other.
   */
  if (st.server && st.adopted) {
    return (
      <div>
        <p style={{ marginBlockStart: 0 }}>
          <b>Accepted.</b> This screen is joining{' '}
          <b style={{ fontFamily: 'monospace' }}>{st.server}</b> now.
        </p>
        <p className="hint" style={{ margin: 0 }}>
          <Spinner /> It restarts once to hand over, which takes a few seconds. After that this
          page becomes a status page and everything about this screen is managed from that server.
        </p>
      </div>
    );
  }

  // Waiting to be approved. The code is the whole content of this state, so it leads.
  if (st.server) {
    return (
      <div>
        <p style={{ marginBlockStart: 0 }}>
          This screen is joining <b style={{ fontFamily: 'monospace' }}>{st.server}</b>.
        </p>
        {st.code ? (
          <>
            <p className="hint" style={{ marginBlockEnd: '0.3rem' }}>
              In that server&rsquo;s dashboard, go to <b>Screens → Add screen → Raspberry Pi</b> and
              enter this code:
            </p>
            <div
              style={{
                fontFamily: 'monospace',
                fontSize: '2rem',
                letterSpacing: '0.18em',
                marginBlock: '0.4rem 0.6rem',
              }}
            >
              {st.code}
            </div>
          </>
        ) : null}
        <p className="pill" style={st.connected ? undefined : { color: 'var(--color-warning)' }}>
          {st.connected ? (
            <>
              <IconCheck size={14} /> {st.status || 'Talking to the server'}
            </>
          ) : (
            <>{st.status || 'Trying to reach the server…'}</>
          )}
        </p>
        {!st.connected && (
          <p className="hint" style={{ marginBlockStart: '0.6rem' }}>
            Check the address is exactly what you would type into a browser here, including{' '}
            <code>http://</code> or <code>https://</code> and any port number. If the server is
            somewhere else on the internet, use the address you reach it on from here.
          </p>
        )}
        <button className="btn btn--ghost btn--sm" onClick={() => onSave('')} disabled={busy} style={{ marginBlockStart: '0.8rem' }}>
          {busy ? <><Spinner /> Working…</> : 'Cancel and stay standalone'}
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="muted" style={{ marginBlockStart: 0 }}>
        This screen runs on its own: its timetables, its settings and its password all live here.
        Point it at a display server and that server takes over — its timetables replace these, and
        this page becomes a status page.
      </p>
      <Field
        label="Display server address"
        hint="Exactly as you'd open it in a browser from here — e.g. http://192.168.1.18:7860, or the public address if it's not in the building."
      >
        <input
          className="input"
          value={address}
          onChange={(e) => onAddress(e.target.value)}
          placeholder="http://192.168.1.18:7860"
          style={{ fontFamily: 'monospace' }}
        />
      </Field>
      <button
        className="btn btn--primary btn--sm"
        onClick={() => onSave(address.trim())}
        disabled={busy || !address.trim()}
        style={{ marginBlockStart: '0.8rem' }}
      >
        {busy ? <><Spinner /> Connecting…</> : 'Connect to this server'}
      </button>
      <p className="hint" style={{ marginBlockStart: '0.6rem' }}>
        Nothing here is deleted. If you ever disconnect this screen again, its own timetables and
        password are still exactly as you left them.
      </p>
    </div>
  );
}
