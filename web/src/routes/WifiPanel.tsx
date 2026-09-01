// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Move a Raspberry Pi screen onto a Wi-Fi network, from wherever the admin happens to be.
 *
 * The hard part is not the form, it is not stranding the screen. A Pi that joins the wrong network —
 * or the right network on an isolated guest VLAN — becomes unreachable, and unreachable from this
 * dashboard in particular, which is the only thing that could have undone it. Three things hold that
 * shut, and only the first is in this file:
 *
 *  - "Safe to unplug" is said ONLY on the strength of the device proving the display server is
 *    reachable over Wi-Fi. Never on a join alone: `nmcli` returns success once it is associated and
 *    holding a DHCP lease, which a captive portal and a client-isolated VLAN both satisfy.
 *  - The device does that proof itself and undoes the join if it fails — see the `wifi-join` branch
 *    in install.sh, which tests with `curl --interface wlan0` so the still-plugged-in cable cannot
 *    answer for the radio.
 *  - Turning the radio off is refused BY THE DEVICE unless a cable is carrying the screen. The
 *    button below is also disabled, but a disabled button is a courtesy, not a safeguard.
 *
 * Nothing here connects to the Pi. Every button leaves a request the screen collects on its own
 * poll, so the wording is always "asked", and the answer arrives on a later check-in.
 *
 * ## Why the list of networks is folded away
 *
 * A masjid is surrounded by its neighbours' Wi-Fi. Twelve to twenty networks is normal, and the list
 * was rendered open, so it pushed everything below it — the password field, and the join button it
 * leads to — off the bottom of the window. The list is only wanted at the moment somebody is
 * changing network, which is rare; what is wanted the rest of the time is the one line saying which
 * network this screen is on. So that line is always visible and the rest is behind a disclosure.
 */
import { useState } from 'react';
import { api } from '../api';
import type { PiDeviceInfo } from '../types';
import { Field, Spinner, SignalBars, IconWifi, IconRefresh, IconNoLink, IconTrash, IconCheck, useToast } from '../ui';

type WifiAction = 'wifi-on' | 'wifi-off' | 'wifi-join' | 'wifi-forget' | 'wifi-rescan';

/** What the device said about the last thing it was asked to do. Worded from `kind`, because the
 *  same three verdicts mean different things for a join and for a forget. */
function resultLine(r: NonNullable<PiDeviceInfo['wifiResult']>): { text: string; tone: 'ok' | 'bad' | 'warn' } {
  if (r.kind === 'forget') {
    return r.ok === true
      ? { text: r.detail || 'This screen no longer has a saved Wi-Fi network.', tone: 'ok' }
      : { text: r.detail || 'The saved network could not be removed.', tone: 'bad' };
  }
  if (r.ok === true) {
    return {
      text: `Connected, and this dashboard is reachable over Wi-Fi${r.detail ? ` (${r.detail})` : ''}. It is safe to unplug the cable.`,
      tone: 'ok',
    };
  }
  if (r.ok === false) {
    return { text: `The last attempt did not work: ${r.detail || 'the screen did not say why'}.`, tone: 'bad' };
  }
  return {
    text: `Joined${r.detail ? ` (${r.detail})` : ''}, but nothing has confirmed this dashboard is reachable over it. Leave the cable in.`,
    tone: 'warn',
  };
}

const TONE = { ok: 'var(--color-success)', bad: 'var(--color-danger)', warn: 'var(--color-warning)' };

export function WifiSection({ device, badge }: { device: PiDeviceInfo; badge: React.ReactNode }) {
  const toast = useToast();
  const [chosen, setChosen] = useState('');
  const [psk, setPsk] = useState('');
  const [busy, setBusy] = useState<'' | WifiAction>('');
  /** Folded away until somebody is actually changing network — see the note at the top. */
  const [listOpen, setListOpen] = useState(false);

  const net = device.net;
  const nets = device.networks ?? [];
  const onCable = net?.link === 'ethernet';
  const result = device.wifiResult;
  const picked = nets.find((n) => n.ssid === chosen);
  const openNetwork = !!picked && !picked.secured;
  const active = nets.find((n) => n.active);

  const send = async (action: WifiAction, wifi?: { ssid: string; psk: string }, said?: string) => {
    setBusy(action);
    try {
      await api.piCommand(device.id, action, wifi);
      toast(said ?? 'Asked the screen. It will pick this up in a few seconds.');
      if (action === 'wifi-join') setPsk('');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not reach the display server.', 'error');
    } finally {
      setBusy('');
    }
  };

  if (!net?.hasWifi) return <p className="hint">This screen has no Wi-Fi, so there is nothing to set up here.</p>;

  const line = result ? resultLine(result) : null;

  return (
    <>
      {/* How this screen is attached, and what that means for changing it. One line, always
          visible: it is the answer to the question somebody opened this section with. */}
      <div className="pi-wifi__state">
        {badge}
        <span className="hint muted">
          {onCable
            ? 'On a cable — the safe time to change network, because the cable keeps this screen reachable while the new one is tested.'
            : 'On Wi-Fi. Changing network from here is riskier: if the new one does not work there is no cable to fall back to.'}
        </span>
      </div>

      {/* The last attempt, in the device's own words. THREE states for a join, not two: "joined but
          nothing proved the server reachable" is its own answer, and showing it as success is
          exactly how a screen gets stranded quietly. */}
      {line && (
        <p className="hint pi-wifi__result" style={{ color: TONE[line.tone] }}>
          {line.text}
        </p>
      )}

      <div className="pi-row pi-wifi__acts">
        <button className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => void send('wifi-on', undefined, 'Asked the screen to switch its Wi-Fi on.')}>
          {busy === 'wifi-on' ? <Spinner /> : <IconWifi size={14} />} Turn Wi-Fi on
        </button>
        <button className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => void send('wifi-rescan', undefined, 'Asked the screen to look for networks again.')}>
          {busy === 'wifi-rescan' ? <Spinner /> : <IconRefresh size={14} />} Search again
        </button>
        <button
          className="btn btn--ghost btn--sm"
          disabled={!!busy || !onCable}
          title={onCable ? 'Switch the radio off — the cable will carry this screen' : 'Only possible while a cable is carrying this screen'}
          onClick={() => void send('wifi-off', undefined, 'Asked the screen to switch its Wi-Fi off.')}
        >
          {busy === 'wifi-off' ? <Spinner /> : <IconNoLink size={14} />} Turn Wi-Fi off
        </button>
        <button
          className="btn btn--ghost btn--sm"
          disabled={!!busy || !onCable}
          title={
            onCable
              ? 'Delete every Wi-Fi network this screen has saved, so it stops joining them'
              : 'Only possible while a cable is carrying this screen'
          }
          onClick={() => void send('wifi-forget', undefined, 'Asked the screen to forget its saved networks.')}
        >
          {busy === 'wifi-forget' ? <Spinner /> : <IconTrash size={14} />} Forget network
        </button>
      </div>

      {/* Closed by default. The summary carries the one fact worth having at a glance — which
          network this screen is on — so opening it is only ever needed to CHANGE something. */}
      <div className={`pi-fold${listOpen ? ' is-open' : ''}`}>
        <button type="button" className="pi-fold__head" aria-expanded={listOpen} onClick={() => setListOpen((v) => !v)}>
          <span className="pi-fold__chev" aria-hidden="true" />
          <span className="pi-fold__title">Networks this screen can see</span>
          {active ? (
            <span className="pi-fold__now">
              <IconWifi size={13} /> {active.ssid}
            </span>
          ) : (
            <span className="hint muted">not on Wi-Fi</span>
          )}
          <span className="pi-fold__count">{nets.length || '—'}</span>
        </button>

        {listOpen && (
          <div className="pi-fold__body">
            {nets.length === 0 ? (
              <p className="hint">
                None reported yet. If Wi-Fi is off, turn it on above — the list arrives on the
                screen&rsquo;s next check-in, within a few seconds.
              </p>
            ) : (
              <>
                <p className="hint muted pi-note" style={{ marginBlockStart: 0, marginBlockEnd: '0.55rem' }}>
                  Strongest first, and reported by the screen itself — so this is what the screen can
                  reach, not what your laptop can.
                </p>
                <div className="pi-nets">
                  {nets.map((n) => (
                    <button
                      key={n.ssid}
                      type="button"
                      className={`pi-net${chosen === n.ssid ? ' is-chosen' : ''}`}
                      onClick={() => {
                        setChosen(n.ssid);
                        setPsk('');
                      }}
                    >
                      <IconWifi size={14} />
                      <span className="pi-net__ssid">{n.ssid}</span>
                      {n.active && <span className="pi-net__tag pi-net__tag--on">connected</span>}
                      {!n.secured && <span className="pi-net__tag">open</span>}
                      <SignalBars percent={n.signal} />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {chosen && (
        <div className="pi-wifi__join">
          <Field
            label={`Password for "${chosen}"`}
            hint={
              openNetwork
                ? 'This network is open, so no password is needed.'
                : 'Sent to the screen once so it can join, and not kept in the dashboard afterwards.'
            }
          >
            <input
              className="input"
              type="password"
              autoComplete="off"
              value={psk}
              disabled={openNetwork}
              onChange={(e) => setPsk(e.target.value)}
              placeholder={openNetwork ? 'Not needed' : 'The Wi-Fi password'}
            />
          </Field>
          <div className="pi-row" style={{ marginBlockStart: '0.6rem' }}>
            <button
              className="btn btn--primary btn--sm"
              disabled={!!busy}
              onClick={() =>
                void send(
                  'wifi-join',
                  { ssid: chosen, psk: openNetwork ? '' : psk },
                  `Asked the screen to join "${chosen}". It will report back in a few seconds.`,
                )
              }
            >
              {busy === 'wifi-join' ? <Spinner /> : <IconCheck size={14} />} Connect
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => setChosen('')}>
              Cancel
            </button>
            <span className="hint muted" style={{ flex: 1, minWidth: '14rem' }}>
              The screen checks that this dashboard is still reachable over the new network before
              keeping it, and undoes the change if it is not.
            </span>
          </div>
        </div>
      )}
    </>
  );
}
