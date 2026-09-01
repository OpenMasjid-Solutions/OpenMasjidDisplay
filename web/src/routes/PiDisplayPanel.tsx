// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The television itself: whether it is lit, and what it is showing right now.
 *
 * Both answer questions that cannot be answered from another city. "Is that screen actually on?" —
 * a device reporting itself healthy is not the same as a television with a picture on it. "Is it
 * showing today's times?" — the only honest answer is to look at the pixels.
 *
 * ## Why the preview is a preview and not a stream
 *
 * Nothing can connect to this device: it sits behind a masjid's router and holds a capability rather
 * than listening on a port. So there is no socket to push frames down. What there is instead is the
 * device's own poll, which it already shortens to about a second while something is happening.
 *
 * So this window does not open a stream — it says "somebody is watching, for the next fifteen
 * seconds" and keeps saying it while it is open. The device sends a frame per poll for as long as
 * that holds, and stops on its own when it lapses. That is what makes a closed tab, a shut laptop
 * lid and a dropped tunnel all safe: none of them has to send anything for the frames to stop.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { PiDeviceInfo } from '../types';
import { Modal, Spinner, useToast } from '../ui';

/** The modes worth offering by name. Anything else can still be typed. */
const MODES = ['auto', '1920x1080', '1920x1080@60', '1280x720', '1024x768', '800x600'];

/**
 * How often to tell the server somebody is watching — and, in the same breath, ask what the newest
 * picture is.
 *
 * One second, because it does both jobs. It is comfortably inside the server's fifteen-second window,
 * so several lost beats in a row cannot interrupt the picture; and it is what makes the view live,
 * because the reply carries the timestamp of the newest frame and the image is re-fetched only when
 * that changes. A few bytes a second to find that out, rather than re-reading a device row that
 * carries up to 180KB of collected journal — which is the traffic the settings window's own
 * 8-second cadence exists to avoid.
 */
const BEAT_MS = 1000;

/** "4 seconds ago", for a picture whose whole value is that it is current. */
function ago(iso?: string): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'} ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? '' : 's'} ago`;
}

/**
 * The preview window.
 *
 * Its own floating window rather than a panel inside the settings, for the same reason the terminal
 * is: the point of watching a screen is to change something and see what happens to it, and a panel
 * that pushed the controls off the bottom made that a scroll each way.
 */
function PreviewWindow({
  device,
  screenName,
  onClose,
}: {
  device: PiDeviceInfo;
  screenName: string;
  onClose: () => void;
}) {
  const [error, setError] = useState('');
  /** The newest frame the server has, as IT reports it on each beat. */
  const [shotIso, setShotIso] = useState(device.screenshotAt ?? '');
  /** When this window opened, so "waiting" can be told from "showing a picture from last week". */
  const startedAt = useRef(Date.now());

  useEffect(() => {
    let alive = true;
    const beat = () =>
      api
        .piPreview(device.id)
        .then((r) => {
          if (!alive) return;
          setError('');
          // Only ever forward. The image is keyed on this, so re-assigning the same value costs
          // nothing, and assigning an older one would make the browser fetch a frame it already has.
          const at = r.screenshotAt;
          if (at) setShotIso((prev) => (at > prev ? at : prev));
        })
        .catch((e: unknown) => {
          if (alive) setError(e instanceof Error ? e.message : 'Lost contact with the display server.');
        });
    void beat();
    const t = setInterval(beat, BEAT_MS);
    // Torn down with the window, which is the whole safety story: the deadline it was pushing simply
    // stops being pushed, and the screen stops sending frames within fifteen seconds.
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [device.id]);

  const shotAt = shotIso ? new Date(shotIso).getTime() : 0;
  // Two seconds of slack: the frame that arrives immediately after opening was taken a moment
  // before the window existed, and calling that stale would flash a warning on every open.
  const live = shotAt > startedAt.current - 2000;
  // Keyed on the frame's own timestamp, so the browser fetches each picture exactly once and never
  // re-fetches one it already has while waiting for the next.
  const url = shotIso ? `/api/pi/${device.id}/screenshot?t=${encodeURIComponent(shotIso)}` : '';

  return (
    <Modal open floating wide title={`${screenName} — live`} onClose={onClose}>
      {url ? (
        <img className="pi-shot" src={url} alt={`What ${screenName} is showing`} />
      ) : (
        <p className="hint muted">
          <Spinner /> waiting for the first picture from the screen…
        </p>
      )}
      <div className="pi-row" style={{ marginBlockStart: '0.5rem' }}>
        {live ? (
          <span className="hint" style={{ color: 'var(--color-success)' }}>
            live · updated {ago(shotIso)}
          </span>
        ) : (
          <span className="hint muted">
            <Spinner /> {url ? `showing a picture from ${ago(shotIso)}` : 'waiting…'}
          </span>
        )}
        {error && (
          <span className="hint" style={{ color: 'var(--color-warning)' }}>
            {error}
          </span>
        )}
        {!error && !live && !device.online && <span className="hint muted">this screen is not checking in</span>}
      </div>
      <p className="hint muted pi-note">
        Read straight out of the screen&rsquo;s own video memory, about once a second while this window
        is open — so it is what the television is being sent, whatever the television then does with
        it. It stops by itself when you close this.
      </p>
    </Modal>
  );
}

export function PiDisplaySection({ device, screenName }: { device: PiDeviceInfo; screenName: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(false);

  // ── the nightly schedule ──
  const sch = device.displaySchedule;
  const [schOn, setSchOn] = useState(!!sch?.enabled);
  const [offAt, setOffAt] = useState(sch?.offAt || '23:00');
  const [onAt, setOnAt] = useState(sch?.onAt || '04:30');

  // ── the forced mode ──
  const [mode, setMode] = useState(device.videoMode || 'auto');
  // Follow the device: a mode nobody confirmed reverts itself on the screen, and a field still
  // showing the reverted-away value would have somebody pressing Apply on a setting they believe is
  // already active. Keyed on the incoming value, so typing survives a poll that changed nothing.
  useEffect(() => setMode(device.videoMode || 'auto'), [device.videoMode]);

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

  const watch = () => {
    setPreview(true);
    // One immediate frame, so the window has something in it before the first beat is even answered.
    void api.piCommand(device.id, 'screenshot').catch(() => {});
  };

  return (
    <>
      <section className="pi-sec">
        <h3 className="pi-sec__title">The screen</h3>
        <div className="pi-row">
          <button className="btn btn--sm btn--primary" onClick={watch}>
            Watch this screen
          </button>
          <button
            className="btn btn--ghost btn--sm"
            disabled={busy !== ''}
            title="Put the television to sleep. It stays asleep until it is turned back on, or until the schedule below turns it on."
            onClick={() =>
              void send('off', () => api.piCommand(device.id, 'display-off'), 'Asked the screen to turn its display off.')
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
            <span className="hint" style={{ color: 'var(--color-warning)' }}>
              the display is asleep
            </span>
          )}
          {device.displayOff === false && (
            <span className="hint" style={{ color: 'var(--color-success)' }}>
              the display is on
            </span>
          )}
        </div>

        <div className="pi-row" style={{ marginBlockStart: '0.6rem' }}>
          <label className="hint muted">
            <input
              type="checkbox"
              checked={schOn}
              onChange={(e) => setSchOn(e.target.checked)}
              style={{ marginInlineEnd: '0.35rem' }}
            />
            turn it off overnight
          </label>
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
            className="btn btn--sm"
            disabled={busy !== ''}
            onClick={() =>
              void send(
                'sch',
                () => api.piDisplaySchedule(device.id, { enabled: schOn, offAt, onAt }),
                schOn
                  ? `This screen will go dark at ${offAt} and come back at ${onAt}.`
                  : 'Overnight schedule turned off.',
              )
            }
          >
            {busy === 'sch' ? <Spinner /> : 'Save'}
          </button>
        </div>
        <p className="hint muted pi-note">
          The screen keeps its own clock and does this itself, so it still happens on a night the
          masjid&rsquo;s internet is down. It also stops drawing and stops any camera while it is dark.
          Turning it on by hand during its off hours leaves it on until the next time in the schedule
          comes round.
        </p>
      </section>

      <section className="pi-sec">
        <h3 className="pi-sec__title">Resolution</h3>
        {device.videoModePending ? (
          // The whole point of the confirmation. A television showing nothing cannot be used to undo
          // the setting that made it show nothing, so the screen puts it back on its own unless
          // somebody says the picture is fine.
          <div className="pi-row">
            <span className="hint" style={{ color: 'var(--color-warning)' }}>
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
            <button className="btn btn--ghost btn--sm" onClick={watch}>
              Watch this screen
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
          after the reboot it asks whether you can see the picture, and puts the old resolution back
          by itself if you cannot.
        </p>
      </section>

      {preview && <PreviewWindow device={device} screenName={screenName} onClose={() => setPreview(false)} />}
    </>
  );
}
