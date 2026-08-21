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
import { useState } from 'react';
import { api } from '../api';
import type { PiDeviceInfo } from '../types';
import { Modal, Spinner, IconDownload, IconPower, IconCheck, useToast } from '../ui';
import { WifiSection } from './WifiPanel';

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
  const [sending, setSending] = useState<'' | 'reboot' | 'reinstall'>('');

  const updating = !!device.updateAskedAt && Date.now() - device.updateAskedAt < UPDATE_WINDOW_MS && !device.upToDate;

  /** Queue an instruction. Nothing connects TO the Pi — it collects this on its own poll. */
  const ask = async (action: 'reboot' | 'reinstall') => {
    setSending(action);
    try {
      await api.piCommand(device.id, action);
      toast(
        action === 'reboot'
          ? 'Asked the Raspberry Pi to reboot. It will be back in about a minute.'
          : 'Asked the screen to update. It takes a few minutes and restarts itself when it is done.',
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not reach the display server.', 'error');
    } finally {
      setSending('');
    }
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
      <section style={{ marginBlockEnd: '1.4rem' }}>
        <h3 className="section-title-inline" style={{ marginBlockEnd: '0.6rem' }}>
          This screen
        </h3>
        <div className="row" style={{ gap: '0.7rem', alignItems: 'center', flexWrap: 'wrap' }}>
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
        <div className="row" style={{ gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap', marginBlockStart: '0.4rem' }}>
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

      <section style={{ marginBlockEnd: '1.4rem' }}>
        <h3 className="section-title-inline" style={{ marginBlockEnd: '0.6rem' }}>
          Network
        </h3>
        <WifiSection device={device} badge={badge} />
      </section>

      <section>
        <h3 className="section-title-inline" style={{ marginBlockEnd: '0.6rem' }}>
          Maintenance
        </h3>
        <div className="row" style={{ gap: '0.6rem', flexWrap: 'wrap' }}>
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
        <p className="hint muted" style={{ marginBlockStart: '0.5rem', lineHeight: 1.5 }}>
          Nothing here is sent to the screen directly — it collects instructions on its own, every few
          seconds. So these say <em>asked</em>, never <em>done</em>.
        </p>
      </section>
    </Modal>
  );
}
