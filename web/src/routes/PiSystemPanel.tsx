// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The board's own settings — the ones that drift and then cause faults nothing else explains.
 *
 * The timezone is the reason this section exists. A screen on the wrong zone shows every prayer time
 * an hour out, confidently and with no error anywhere, and the only way to find it was to shell in
 * and run `timedatectl`. It is also the single most consequential setting on the whole device, and
 * until now it was the one thing here that could only be set by whoever first wrote the SD card.
 *
 * The rest earn their place the same way: a hall of screens all called "raspberry" cannot be
 * identified in a router, Debian's own security updates were nobody's job, and a board that has been
 * up for eleven months is fixed by a reboot at 3am rather than by anything anybody wants to debug
 * remotely.
 *
 * Every one of these runs as root on the device, through the closed verb set — the panel never sends
 * a command, it names one. See PI_COMMANDS.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { PiDeviceInfo } from '../types';
import { Spinner, IconDownload, Toggle, useToast } from '../ui';

/**
 * The zones a masjid is actually in, offered by name.
 *
 * Not the full IANA list: it is six hundred entries and a select of that size is worse than a text
 * field. Anything not here can still be typed, and the device checks the name against its own
 * /usr/share/zoneinfo — so a typo is refused by the thing that would have to honour it.
 */
const ZONES = [
  'UTC',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Istanbul',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'Asia/Dubai',
  'Asia/Riyadh',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Jakarta',
  'Asia/Kuala_Lumpur',
  'Australia/Sydney',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
];

export function PiSystemSection({ device }: { device: PiDeviceInfo }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');

  const [tz, setTz] = useState(device.timezone || '');
  const [host, setHost] = useState(device.hostname || '');
  const reb = device.rebootSchedule;
  const [rebOn, setRebOn] = useState(!!reb?.enabled);
  const [rebAt, setRebAt] = useState(reb?.at || '03:30');

  // Follow the device: both of these are things it is authoritative about, and it can be changed
  // from a terminal too. Keyed on the incoming value, so typing here is not overwritten by a poll
  // that changed nothing.
  useEffect(() => setTz(device.timezone || ''), [device.timezone]);
  useEffect(() => setHost(device.hostname || ''), [device.hostname]);

  const send = async (label: string, fn: () => Promise<unknown>, said: string) => {
    setBusy(label);
    try {
      await fn();
      toast(said);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not reach the display server.', 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="pi-sec">
      <h3 className="pi-sec__title">This board</h3>

      <div className="pi-row">
        <label className="hint muted">
          timezone{' '}
          <input
            className="input input--sm"
            list={`zones-${device.id}`}
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            placeholder="not reported yet"
            aria-label="This screen's timezone"
            spellCheck={false}
            style={{ width: '13rem' }}
          />
          <datalist id={`zones-${device.id}`}>
            {ZONES.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </label>
        <button
          className="btn btn--sm btn--primary"
          disabled={busy !== '' || !tz.trim() || tz === device.timezone}
          onClick={() =>
            void send(
              'tz',
              () => api.piCommand(device.id, 'set-timezone', undefined, undefined, tz.trim()),
              `Asked the screen to switch to ${tz.trim()}.`,
            )
          }
        >
          {busy === 'tz' ? <Spinner /> : 'Set'}
        </button>
      </div>
      <p className="hint muted pi-note">
        The screen works out prayer times from its own clock, so a wrong zone here puts every time on
        the wall out by exactly that much &mdash; with nothing anywhere saying so. This is the
        screen&rsquo;s own zone, not the one the timetable is scheduled in.
      </p>

      <div className="pi-row" style={{ marginBlockStart: '0.6rem' }}>
        <label className="hint muted">
          name on the network{' '}
          <input
            className="input input--sm"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="main-hall"
            aria-label="This screen's hostname"
            spellCheck={false}
            style={{ width: '11rem' }}
          />
        </label>
        <button
          className="btn btn--sm"
          disabled={busy !== '' || !host.trim() || host === device.hostname}
          onClick={() =>
            void send(
              'host',
              () => api.piCommand(device.id, 'set-hostname', undefined, undefined, host.trim()),
              `Asked the screen to rename itself to ${host.trim().toLowerCase()}.`,
            )
          }
        >
          {busy === 'host' ? <Spinner /> : 'Rename'}
        </button>
      </div>
      <p className="hint muted pi-note">
        Letters, digits and hyphens. This is what the masjid&rsquo;s router shows, so
        &ldquo;main-hall&rdquo; beats a wall of boards all called <code>raspberry</code>.
      </p>

      <div className="pi-row" style={{ marginBlockStart: '0.6rem' }}>
        <button
          className="btn btn--ghost btn--sm"
          disabled={busy !== ''}
          title="Install operating-system security updates on this board. Takes a few minutes and runs in the background."
          onClick={() =>
            void send(
              'os',
              () => api.piCommand(device.id, 'os-update'),
              'Asked the screen to install system updates. It runs in the background and takes a few minutes.',
            )
          }
        >
          {busy === 'os' ? <Spinner /> : <IconDownload size={14} />} System updates
        </button>
        <span className="hint muted">Debian&rsquo;s own packages &mdash; not this app</span>
      </div>

      <div className="pi-row" style={{ marginBlockStart: '0.6rem' }}>
        <Toggle checked={rebOn} onChange={setRebOn} label="Reboot this screen every night" />
        <span className="hint">Reboot every night</span>
        <label className="hint muted">
          at{' '}
          <input
            className="input input--sm"
            type="time"
            value={rebAt}
            disabled={!rebOn}
            onChange={(e) => setRebAt(e.target.value)}
            aria-label="Time to reboot this screen"
          />
        </label>
        <button
          className="btn btn--sm btn--primary"
          disabled={busy !== ''}
          onClick={() =>
            void send(
              'reb',
              () => api.piRebootSchedule(device.id, { enabled: rebOn, at: rebAt }),
              rebOn ? `This screen will reboot at ${rebAt} every night.` : 'Nightly reboot turned off.',
            )
          }
        >
          {busy === 'reb' ? <Spinner /> : 'Save'}
        </button>
      </div>
      <p className="hint muted pi-note">
        A blunt fix, and the one that works: pick a time when nobody is in the hall and a board that
        has been running for months clears itself out overnight. The screen keeps its own clock and
        does this itself.
      </p>
    </section>
  );
}
