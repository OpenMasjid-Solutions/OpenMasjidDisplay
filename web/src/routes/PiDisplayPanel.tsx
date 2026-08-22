// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The television itself: whether it is lit, how it is mounted, and what it is showing right now.
 *
 * Everything here is about the physical set rather than the app running on it, and it exists because
 * the questions it answers cannot be answered from another city. "Is that screen actually on?" —
 * a device that reports itself healthy is not the same as a television with a picture on it.
 * "Why is the bottom row cut off?" — because the set crops its input, which nobody can see from
 * here. "It's mounted sideways" — which used to mean an SD card and a visit.
 *
 * ## Two mechanisms, deliberately not one
 *
 * Turning the output off, and the nightly schedule for it, go through **root on the device**: the
 * framebuffer's blank control is root-owned. (And note that `vcgencmd display_power`, which every
 * guide reaches for, does nothing at all on a Pi 4 under the KMS driver — measured.)
 *
 * Rotation and overscan go through **nothing at all**. The agent renders every pixel it puts on the
 * screen, so it can simply turn them and inset them; the documented firmware options for both are
 * legacy-stack settings that this image's driver ignores anyway. That is why those two take effect
 * on the next frame while everything else here waits for a poll — and why neither can leave a screen
 * black, which the forced resolution below very much can.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { PiDeviceInfo } from '../types';
import { Spinner, IconCheck, Toggle, useToast } from '../ui';

/**
 * The rotations the agent can do. Four, because the rotation is index arithmetic on a pixel buffer
 * and only those four are exact — see pi/raster.ts.
 *
 * The labels describe HOW THE TELEVISION IS MOUNTED and the values are quarter turns applied to the
 * PICTURE, which are opposite by definition: a set turned clockwise needs its picture turned
 * anticlockwise to read upright. Getting this backwards is a screen that is upside down in the
 * other direction, so it is worth being explicit — 90 and 270 are deliberately not where a first
 * reading would put them, and it was checked against a real frame off a real board.
 */
const ROTATIONS = [
  { v: 0, label: 'Normal' },
  { v: 270, label: 'Turned clockwise' },
  { v: 180, label: 'Upside down' },
  { v: 90, label: 'Turned anticlockwise' },
] as const;

/** The modes worth offering by name. Anything else can still be typed. */
const MODES = ['auto', '1920x1080', '1920x1080@60', '1280x720', '1024x768', '800x600'];

/** "4 seconds ago", for a picture whose whole value is that it is current. */
function ago(iso?: string): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'} ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  return `${Math.round(m / 60)} hour${Math.round(m / 60) === 1 ? '' : 's'} ago`;
}

export function PiDisplaySection({ device }: { device: PiDeviceInfo }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');

  // ── the nightly schedule ──
  const sch = device.displaySchedule;
  const [schOn, setSchOn] = useState(!!sch?.enabled);
  const [offAt, setOffAt] = useState(sch?.offAt || '23:00');
  const [onAt, setOnAt] = useState(sch?.onAt || '04:30');

  // ── how it is mounted ──
  const tf = device.displayTransform;
  const [rotate, setRotate] = useState<number>(tf?.rotate ?? 0);
  const [overscan, setOverscan] = useState<number>(tf?.overscan ?? 0);

  // ── the forced mode ──
  const [mode, setMode] = useState(device.videoMode || 'auto');

  /**
   * Follow the device when it tells us something new.
   *
   * These are edit fields over a value the DEVICE is authoritative about, which is a combination
   * that goes wrong in one specific way: a mode nobody confirmed reverts itself on the screen, and
   * a select still showing the reverted-away value would have somebody pressing Apply on a setting
   * they think is already active. Keyed on the incoming value so a local edit survives a poll that
   * changed nothing.
   */
  useEffect(() => setMode(device.videoMode || 'auto'), [device.videoMode]);
  useEffect(() => {
    setRotate(device.displayTransform?.rotate ?? 0);
    setOverscan(device.displayTransform?.overscan ?? 0);
  }, [device.displayTransform?.rotate, device.displayTransform?.overscan]);

  // ── the picture ──
  //
  // Cache-busted on the timestamp rather than on every render: the same URL with no-store would
  // still be re-fetched by the browser on any re-render, and this window re-renders every two
  // seconds while it is open.
  const shotUrl = device.screenshotAt
    ? `/api/pi/${device.id}/screenshot?t=${encodeURIComponent(device.screenshotAt)}`
    : '';
  const [shotAskedAt, setShotAskedAt] = useState(0);
  const shotWaiting =
    shotAskedAt > 0 && (!device.screenshotAt || new Date(device.screenshotAt).getTime() < shotAskedAt);

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

  const transformChanged = rotate !== (tf?.rotate ?? 0) || overscan !== (tf?.overscan ?? 0);

  return (
    <>
      <section className="pi-sec">
        <h3 className="pi-sec__title">The screen</h3>
        <div className="pi-row">
          <button
            className="btn btn--ghost btn--sm"
            disabled={busy !== ''}
            title="Put the television to sleep. It stays asleep until it is turned back on or the schedule below turns it on."
            onClick={() =>
              void send(
                'off',
                () => api.piCommand(device.id, 'display-off'),
                'Asked the screen to turn its display off.',
              )
            }
          >
            {busy === 'off' ? <Spinner /> : null} Turn off
          </button>
          <button
            className="btn btn--ghost btn--sm"
            disabled={busy !== ''}
            onClick={() =>
              void send('on', () => api.piCommand(device.id, 'display-on'), 'Asked the screen to turn its display on.')
            }
          >
            {busy === 'on' ? <Spinner /> : null} Turn on
          </button>
          {/* What the DEVICE says, not what was last pressed. Undefined is its own state: an agent
              too old to report this must not be drawn as "on". */}
          {device.displayOff === true && (
            <span className="hint" style={{ color: 'var(--color-warn, #fbbf24)' }}>
              the display is asleep
            </span>
          )}
          {device.displayOff === false && (
            <span className="hint" style={{ color: 'var(--color-ok, #4ade80)' }}>
              the display is on
            </span>
          )}
        </div>

        <div className="pi-row" style={{ marginBlockStart: '0.6rem' }}>
          <Toggle checked={schOn} onChange={setSchOn} label="Turn this screen off overnight" />
          <span className="hint">Turn it off overnight</span>
          <label className="hint muted">
            off at{' '}
            <input
              className="input input--sm"
              type="time"
              value={offAt}
              disabled={!schOn}
              onChange={(e) => setOffAt(e.target.value)}
              aria-label="Time to turn the screen off"
            />
          </label>
          <label className="hint muted">
            on at{' '}
            <input
              className="input input--sm"
              type="time"
              value={onAt}
              disabled={!schOn}
              onChange={(e) => setOnAt(e.target.value)}
              aria-label="Time to turn the screen back on"
            />
          </label>
          <button
            className="btn btn--sm btn--primary"
            disabled={busy !== ''}
            onClick={() =>
              void send(
                'sch',
                () => api.piDisplaySchedule(device.id, { enabled: schOn, offAt, onAt }),
                schOn ? `This screen will go dark at ${offAt} and come back at ${onAt}.` : 'Overnight schedule turned off.',
              )
            }
          >
            {busy === 'sch' ? <Spinner /> : 'Save'}
          </button>
        </div>
        <p className="hint muted pi-note">
          The screen keeps its own clock and does this itself, so it still happens on a night the
          masjid&rsquo;s internet is down. Turning it on by hand during its off hours leaves it on until
          the next time in the schedule comes round.
        </p>
      </section>

      <section className="pi-sec">
        <h3 className="pi-sec__title">What it is showing</h3>
        <div className="pi-row">
          <button
            className="btn btn--ghost btn--sm"
            disabled={busy !== ''}
            onClick={() => {
              setShotAskedAt(Date.now());
              void send('shot', () => api.piCommand(device.id, 'screenshot'), 'Asked the screen for a picture.');
            }}
          >
            {busy === 'shot' || shotWaiting ? <Spinner /> : null} {shotUrl ? 'Take another' : 'Take a picture'}
          </button>
          <span className="hint muted">
            {shotWaiting ? 'waiting for the screen to send it…' : `taken ${ago(device.screenshotAt)}`}
          </span>
        </div>
        {shotUrl && (
          // Deliberately a plain img at full width: this is evidence, and the one thing somebody
          // wants from it is to see whether the times are right, which needs the pixels.
          <img className="pi-shot" src={shotUrl} alt="What this screen is currently showing" />
        )}
        <p className="hint muted pi-note">
          Read straight out of the screen&rsquo;s own video memory — so it is what the television is
          being sent, whatever the television then does with it. The one answer to &ldquo;is that screen
          really showing today&rsquo;s times?&rdquo; that does not depend on the screen agreeing.
        </p>
      </section>

      <section className="pi-sec">
        <h3 className="pi-sec__title">How it is mounted</h3>
        <div className="pi-row">
          <label className="hint muted">
            rotation{' '}
            <select
              className="input input--sm"
              value={rotate}
              onChange={(e) => setRotate(Number(e.target.value))}
              aria-label="How this screen is mounted"
            >
              {ROTATIONS.map((r) => (
                <option key={r.v} value={r.v}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="hint muted">
            shrink by{' '}
            <select
              className="input input--sm"
              value={overscan}
              onChange={(e) => setOverscan(Number(e.target.value))}
              aria-label="How much to shrink the picture, for a television that crops the edges"
            >
              {[0, 2, 3, 5, 8, 10, 15].map((p) => (
                <option key={p} value={p}>
                  {p === 0 ? 'nothing' : `${p}%`}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn btn--sm btn--primary"
            disabled={busy !== '' || !transformChanged}
            onClick={() =>
              void send(
                'tf',
                () => api.piDisplayTransform(device.id, { rotate, overscan }),
                'Saved. The screen redraws with it within a few seconds.',
              )
            }
          >
            {busy === 'tf' ? <Spinner /> : 'Save'}
          </button>
          {!transformChanged && (rotate !== 0 || overscan !== 0) && (
            <span className="hint muted" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
              <IconCheck size={13} /> in use
            </span>
          )}
        </div>
        <p className="hint muted pi-note">
          Both of these are done in the picture itself, so they take effect on the screen&rsquo;s next
          frame — no reboot, and nothing that can leave it black. Use <em>shrink by</em> when a
          television cuts the edges off: it draws the timetable slightly smaller with a black border,
          which is what the set then crops instead of your bottom row of times.
        </p>
      </section>

      <section className="pi-sec">
        <h3 className="pi-sec__title">Resolution</h3>
        {device.videoModePending ? (
          // The whole point of the confirmation. A television that shows nothing cannot be used to
          // undo the setting that made it show nothing, so the screen puts it back on its own unless
          // somebody says the picture is fine.
          <div className="pi-row">
            <span className="hint" style={{ color: 'var(--color-warn, #fbbf24)' }}>
              Can you see the timetable on this screen?
            </span>
            <button
              className="btn btn--sm btn--primary"
              disabled={busy !== ''}
              onClick={() =>
                void send(
                  'keep',
                  () => api.piCommand(device.id, 'keep-video-mode'),
                  'Keeping it. The screen will not put the old resolution back.',
                )
              }
            >
              {busy === 'keep' ? <Spinner /> : 'Yes, keep it'}
            </button>
            <span className="hint muted">
              Otherwise it puts the old one back on its own, within a few minutes, and reboots again.
            </span>
          </div>
        ) : (
          <div className="pi-row">
            <label className="hint muted">
              force{' '}
              <input
                className="input input--sm"
                list={`modes-${device.id}`}
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                aria-label="Force a display resolution"
                spellCheck={false}
                style={{ width: '11rem' }}
              />
              <datalist id={`modes-${device.id}`}>
                {MODES.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
            <button
              className="btn btn--sm"
              disabled={busy !== '' || mode === (device.videoMode || 'auto')}
              onClick={() =>
                void send(
                  'mode',
                  () => api.piCommand(device.id, 'set-video-mode', undefined, undefined, mode),
                  'Asked the screen to change resolution and reboot. It will ask you to confirm the picture.',
                )
              }
            >
              {busy === 'mode' ? <Spinner /> : 'Apply and reboot'}
            </button>
            {device.videoMode && device.videoMode !== 'auto' && (
              <span className="hint muted">currently forced to {device.videoMode}</span>
            )}
          </div>
        )}
        {device.videoModeResult && <p className="hint muted pi-note">{device.videoModeResult}</p>}
        <p className="hint muted pi-note">
          Leave this on <code>auto</code> unless a television negotiates a bad mode — the screen fits
          the timetable to whatever it is given. This is the only setting here that has to change the
          card&rsquo;s boot settings and reboot, so it is also the only one that can leave a screen dark:
          after the reboot it asks you whether you can see the picture, and puts the old resolution
          back by itself if you cannot.
        </p>
      </section>
    </>
  );
}
