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
 */
import { useState } from 'react';
import { api } from '../api';
import type { PiDeviceInfo } from '../types';
import { Field, Spinner, SignalBars, IconWifi, IconRefresh, IconNoLink, IconTrash, IconCheck, useToast } from '../ui';

type WifiAction = 'wifi-on' | 'wifi-off' | 'wifi-join' | 'wifi-forget' | 'wifi-rescan';

export function WifiSection({ device, badge }: { device: PiDeviceInfo; badge: React.ReactNode }) {
  const toast = useToast();
  const [chosen, setChosen] = useState('');
  const [psk, setPsk] = useState('');
  const [busy, setBusy] = useState<'' | WifiAction>('');

  const net = device.net;
  const nets = device.networks ?? [];
  const onCable = net?.link === 'ethernet';
  const result = device.wifiResult;
  const picked = nets.find((n) => n.ssid === chosen);
  const openNetwork = !!picked && !picked.secured;

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

  return (
    <>
      {!net?.hasWifi ? (
        <p className="hint">This screen has no Wi-Fi, so there is nothing to set up here.</p>
      ) : (
        <>
          <div className="row" style={{ gap: '0.6rem', alignItems: 'center', marginBlockEnd: '0.9rem', flexWrap: 'wrap' }}>
            {badge}
            <span className="hint muted" style={{ flex: 1, minWidth: '14rem' }}>
              {onCable
                ? 'On a cable, which is the safe time to do this: the cable keeps the screen reachable while the new network is tested.'
                : 'On Wi-Fi. Changing network from here is riskier — if the new one does not work there is no cable to fall back to.'}
            </span>
          </div>

          {/* The last attempt, in the device's own words. THREE states, not two: "joined but nothing
              proved the server reachable" is its own answer, and showing it as success is exactly
              how a screen gets stranded quietly. */}
          {result && (
            <p
              className="hint"
              style={{
                marginBlockEnd: '0.9rem',
                lineHeight: 1.5,
                color:
                  result.ok === true
                    ? 'var(--ok, #2bbf90)'
                    : result.ok === false
                      ? 'var(--danger, #e5736b)'
                      : 'var(--color-warn, #fbbf24)',
              }}
            >
              {result.ok === true
                ? `Connected, and this dashboard is reachable over Wi-Fi${result.detail ? ` (${result.detail})` : ''}. It is safe to unplug the cable.`
                : result.ok === false
                  ? `The last attempt did not work: ${result.detail || 'the screen did not say why'}.`
                  : `Joined${result.detail ? ` (${result.detail})` : ''}, but nothing has confirmed this dashboard is reachable over it. Leave the cable in.`}
            </p>
          )}

          <div className="row" style={{ gap: '0.5rem', marginBlockEnd: '1rem', flexWrap: 'wrap' }}>
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
              title={onCable ? 'Forget the saved network' : 'Only possible while a cable is carrying this screen'}
              onClick={() => void send('wifi-forget', undefined, 'Asked the screen to forget its saved network.')}
            >
              {busy === 'wifi-forget' ? <Spinner /> : <IconTrash size={14} />} Forget network
            </button>
          </div>

          <Field
            label="Networks this screen can see"
            hint={
              nets.length
                ? 'Strongest first. The screen reports this itself, so it is what the screen can reach — not what your laptop can.'
                : undefined
            }
          >
            {nets.length === 0 ? (
              <p className="hint">
                None reported yet. If Wi-Fi is off, turn it on above — the list arrives on the
                screen&rsquo;s next check-in, within a few seconds.
              </p>
            ) : (
              <div style={{ display: 'grid', gap: '0.3rem' }}>
                {nets.map((n) => (
                  <button
                    key={n.ssid}
                    type="button"
                    className={`btn btn--ghost btn--sm${chosen === n.ssid ? ' btn--primary' : ''}`}
                    style={{ justifyContent: 'flex-start', gap: '0.5rem' }}
                    onClick={() => {
                      setChosen(n.ssid);
                      setPsk('');
                    }}
                  >
                    <IconWifi size={14} />
                    <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.ssid}</span>
                    {n.active && (
                      <span className="hint" style={{ color: 'var(--ok, #2bbf90)' }}>
                        connected
                      </span>
                    )}
                    {!n.secured && <span className="hint muted">open</span>}
                    <SignalBars percent={n.signal} />
                  </button>
                ))}
              </div>
            )}
          </Field>

          {chosen && (
            <div style={{ marginBlockStart: '0.9rem' }}>
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
              <div className="row" style={{ gap: '0.6rem', marginBlockStart: '0.7rem', alignItems: 'center', flexWrap: 'wrap' }}>
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
                <span className="hint muted" style={{ flex: 1, minWidth: '14rem' }}>
                  The screen checks that this dashboard is still reachable over the new network before
                  keeping it, and undoes the change if it is not.
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
