// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The board's own settings — the two that matter from another city.
 *
 * The timezone is the reason this section exists. A screen on the wrong zone shows every prayer time
 * an hour out, confidently and with no error anywhere, and the only way to find it was to shell in
 * and run `timedatectl`. It is also the single most consequential setting on the whole device, and
 * until now it was the one thing here that could only be set by whoever first wrote the SD card.
 *
 * The nightly reboot is the blunt fix that works: a board that has been up for eleven months with a
 * slow leak somewhere in a camera pipeline is put right by a reboot at 3am and by nothing anybody
 * wants to debug remotely. It is ON by default for every screen — see effectiveRebootSchedule for
 * why that is deliberate rather than presumptuous.
 *
 * Both run as root on the device through the closed verb set: the panel never sends a command, it
 * names one. See PI_COMMANDS.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { PiDeviceInfo } from '../types';
import { Spinner, useToast } from '../ui';

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

/** What a screen with nothing stored does. Kept in step with the server's own default, which is the
 *  one that actually runs — see effectiveRebootSchedule. */
const DEFAULT_REBOOT_AT = '03:00';

export function PiSystemSection({ device }: { device: PiDeviceInfo }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');

  const [tz, setTz] = useState(device.timezone || '');
  // The server fills this in for every screen, so an absent value only happens against a display
  // server too old to send it. Defaulted the same way here so the two cannot disagree about what
  // an absent schedule means.
  const reb = device.rebootSchedule;
  const [rebOn, setRebOn] = useState(reb ? reb.enabled : true);
  const [rebAt, setRebAt] = useState(reb?.at || DEFAULT_REBOOT_AT);

  // Follow the device: the timezone is something IT is authoritative about, and it can be changed
  // from a terminal too. Keyed on the incoming value, so typing here is not overwritten by a poll
  // that changed nothing.
  useEffect(() => setTz(device.timezone || ''), [device.timezone]);

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
          <input
            type="checkbox"
            checked={rebOn}
            onChange={(e) => setRebOn(e.target.checked)}
            style={{ marginInlineEnd: '0.35rem' }}
          />
          reboot every night
        </label>
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
          className="btn btn--sm"
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
        On for every screen at {DEFAULT_REBOOT_AT} unless you turn it off here. Nothing is happening in
        a prayer hall at three in the morning, and a board that has been running for months clears
        itself out overnight instead of being found wedged on a Friday. The screen keeps its own clock
        and does this itself.
      </p>
    </section>
  );
}
