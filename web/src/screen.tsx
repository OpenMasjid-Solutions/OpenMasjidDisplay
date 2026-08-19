// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * screen.tsx — the page a television opens. A screen that is a browser, not a decoder.
 *
 * ## The whole idea
 *
 * An RTSP screen is fed ~1.5 Mbit/s of H.264 forever, because a decoder box can only speak
 * video. A browser can render for itself, so this page fetches the TIMETABLE (about half a
 * kilobyte) and draws locally once a second. After the first load the network carries almost
 * nothing: one small state poll every few seconds, which doubles as the heartbeat.
 *
 * ## One renderer, not two
 *
 * It imports `renderDisplaySvg` from the SERVER's own `render/svg.ts`. That file is a pure
 * string builder — no fs, no Buffer, and it never reads the clock itself (`now` is always
 * passed in) — so it bundles for the browser unchanged and returns byte-identical SVG to what
 * the video pipeline rasterises. This is the single most important property of the feature:
 * a browser screen and a decoder screen cannot disagree, because there is nothing to
 * disagree with.
 *
 * ## What the browser has to do that the SVG does not
 *
 * Four things live outside the SVG, and each is handled here rather than reimplemented:
 *  - the announcement slideshow phase (`activeAnnouncementImage`, exported and pure),
 *  - the ticker's MOTION (ffmpeg scrolls it in the video path; here it is CSS, so it moves at
 *    the compositor's frame rate and costs no redraws),
 *  - marking a stale picture, which in the video path is pixel arithmetic on a frame,
 *  - deciding the picture IS stale, which on the server is "the render loop stopped" and here
 *    can only be "I can no longer reach the server, or my clock disagrees with its".
 */
import {
  renderDisplaySvg,
  activeAnnouncementImage,
  bottomBandSplit,
  activeTicker,
  tickerTextColor,
  TICKER_RED,
} from '../../server/src/render/svg';
import type { Timetable } from '../../server/src/types';

interface ScreenState {
  content: { kind: 'timetable' | 'source' | 'off'; id?: string };
  source: 'override' | 'schedule' | 'default';
  timetable: Timetable | null;
  assets: { background: string | null; logo: string | null; announcements: string[] };
  bgLight: boolean;
  autoAccent: string | null;
  serverNow: number;
  clockSuspect: boolean;
  pollMs: number;
  name: string;
}

/** The screen's own base path and token, read off the URL it was opened with. Doing it this
 *  way is what makes the page work identically on the LAN (`/s/<token>`) and behind the
 *  platform's Cloudflare tunnel (`/display/s/<token>`) with nothing configured. */
const SELF = window.location.pathname.replace(/\/+$/, '');

/** How far the browser's clock may differ from the server's before the picture is marked.
 *  A television with a dead RTC and no NTP shows confident, wrong prayer times — which is
 *  worse than showing nothing, and is exactly the failure the server already guards its own
 *  clock against. Two minutes is far outside any plausible scheduling drift. */
const CLOCK_SKEW_LIMIT_MS = 120_000;

/** No successful state fetch for this long and the picture is marked out of date. The times
 *  on screen keep ticking from the last known timetable, which is right — they are still
 *  correct — but a change made in the panel would not have reached us, and after this long
 *  that is worth admitting on the wall. */
const OFFLINE_MARK_MS = 10 * 60_000;

let state: ScreenState | null = null;
let lastStateAt = 0;
/** serverNow − clientNow at the last fetch. Applied to every render so the picture follows
 *  the SERVER's idea of the time even on a television whose own clock is wrong. */
let clockOffsetMs = 0;
let ticker = { text: '', el: null as HTMLDivElement | null };

const root = document.getElementById('screen')!;

async function fetchState(): Promise<void> {
  const res = await fetch(`${SELF}/state`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`state ${res.status}`);
  const next = (await res.json()) as ScreenState;
  clockOffsetMs = next.serverNow - Date.now();
  state = next;
  lastStateAt = Date.now();
}

/** The instant to render at: the server's clock, not this television's. */
const serverTime = () => new Date(Date.now() + clockOffsetMs);

/**
 * Is the picture out of date, and why?
 *
 * The server's own answer ('frozen' — the render loop stopped) cannot apply here, because
 * there is no server-side loop for this screen. What CAN go wrong is losing contact with the
 * server, or this machine's clock being wrong, and both produce wrong times on a wall that
 * looks perfectly healthy.
 */
function staleReason(): 'clock' | 'offline' | null {
  if (!state) return null;
  if (state.clockSuspect) return 'clock';
  if (Math.abs(clockOffsetMs) > CLOCK_SKEW_LIMIT_MS) return 'clock';
  if (Date.now() - lastStateAt > OFFLINE_MARK_MS) return 'offline';
  return null;
}

/**
 * The stale mark.
 *
 * The video pipeline halves every pixel's RGB and paints a red bar along the bottom
 * (`renderer.markStale`). This is the DOM equivalent, deliberately the same two signals so a
 * masjid sees one visual language whichever kind of screen it is looking at.
 */
function applyStaleMark(reason: 'clock' | 'offline' | null): void {
  root.style.filter = reason ? 'brightness(0.5)' : '';
  let bar = document.getElementById('stalebar');
  if (!reason) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'stalebar';
    bar.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;height:2vh;min-height:6px;background:#d03a2f;' +
      'z-index:9;display:flex;align-items:center;justify-content:center;color:#fff;' +
      'font:600 1.6vh system-ui,sans-serif;letter-spacing:0.08em;';
    document.body.appendChild(bar);
  }
  bar.textContent =
    reason === 'clock' ? "THIS SCREEN'S CLOCK IS WRONG — TIMES MAY BE INCORRECT" : 'NOT CONNECTED — TIMES MAY BE OUT OF DATE';
}

/**
 * The ticker's motion.
 *
 * In the video path ffmpeg scrolls the text with `drawtext` because the SVG is rasterised
 * once a second and a 1 fps scroll judders. Here the band is drawn by the same SVG (with
 * `tickerBandOnly`, exactly as the video path does) and the text rides above it in a DOM
 * layer animated by CSS — so it moves at the display's own frame rate while the SVG underneath
 * still only redraws once a second. Geometry comes from `bottomBandSplit`, the same function
 * ffmpeg's filter graph derives its lane from, so the text cannot land in the wrong place.
 */
function syncTicker(tt: Timetable, now: Date, w: number, h: number): void {
  // The SAME source of truth the video path uses: it already knows a full-screen overlay
  // hides the ticker, and that a prohibited-time notice in ticker mode REPLACES it in red.
  const { text, prohibited } = activeTicker(tt, now);
  const band = bottomBandSplit(tt, now, w, h, !!text);
  // `scroll` is null when the Iqamah-change reminder has taken the whole band — there is no
  // lane to scroll in, and the reminder is already drawn in the SVG.
  if (!text || !band.scroll) {
    ticker.el?.remove();
    ticker = { text: '', el: null };
    return;
  }
  if (!ticker.el) {
    const el = document.createElement('div');
    el.id = 'ticker';
    el.style.cssText = 'position:fixed;overflow:hidden;z-index:8;pointer-events:none;white-space:nowrap;';
    el.innerHTML = '<div class="run"></div>';
    document.body.appendChild(el);
    const style = document.createElement('style');
    // Two copies end to end so the loop has no gap, and the whole run is translated by
    // exactly half its width — the standard seamless marquee.
    style.textContent =
      '@keyframes tick { from { transform: translateX(0); } to { transform: translateX(-50%); } }' +
      '#ticker .run { display:inline-flex; will-change: transform; animation: tick linear infinite; }' +
      '@media (prefers-reduced-motion: reduce) { #ticker .run { animation: none; } }';
    document.head.appendChild(style);
    ticker.el = el;
  }
  const el = ticker.el;
  // Position the lane over the band the SVG drew, in the same coordinates.
  // Percentages of the SVG's own viewport, so the lane tracks the band whatever the screen's
  // real pixel size is — the SVG is scaled to fit and these scale with it.
  el.style.left = `${(band.scroll.x / w) * 100}%`;
  el.style.width = `${(band.scroll.w / w) * 100}%`;
  el.style.top = `${(band.y / h) * 100}%`;
  el.style.height = `${(band.bandH / h) * 100}%`;
  el.style.lineHeight = `${(band.bandH / h) * 100}vh`;
  el.style.fontSize = `${(band.fs / h) * 100}vh`;
  el.style.color = prohibited ? TICKER_RED : tickerTextColor(tt);
  if (ticker.text !== text) {
    const run = el.firstElementChild as HTMLElement;
    const sep = '  •  ';
    run.innerHTML = '';
    for (let i = 0; i < 2; i++) {
      const span = document.createElement('span');
      span.textContent = text + sep;
      span.style.paddingInlineEnd = '4vw';
      run.appendChild(span);
    }
    // Speed 1–10 → seconds for one full pass. Slower for longer text so a long message is
    // readable rather than merely faster.
    const secs = Math.max(8, (text.length / 6) * (11 - Math.min(10, Math.max(1, tt.tickerSpeed ?? 5))));
    run.style.animationDuration = `${secs}s`;
    ticker.text = text;
  }
}


// ── video: a camera or HDMI source on a browser screen ──────────────────────

let video: HTMLVideoElement | null = null;
let hls: { destroy(): void } | null = null;
/** Remember what we are already playing, so a 1 Hz redraw does not tear the stream down and
 *  rebuild it every second. */
let playingId = '';

function stopVideo(): void {
  hls?.destroy();
  hls = null;
  video?.remove();
  video = null;
  playingId = '';
}

/**
 * Play the screen's current source.
 *
 * Native HLS first (Safari, iOS, several smart-TV browsers) because it costs nothing; hls.js
 * only where the browser cannot — and it is a DYNAMIC import, so a masjid whose screens only
 * ever show a timetable never downloads it.
 */
async function showVideo(sourceId: string): Promise<void> {
  const src = `${SELF}/hls/index.m3u8`;
  // Keyed on the SOURCE, not the URL. The URL is identical for every camera — the server
  // resolves it against whatever the screen is currently showing — so comparing URLs would
  // leave the previous camera playing after a switch between two of them.
  if (playingId === sourceId && video) return;
  stopVideo();
  hideMessage();

  const el = document.createElement('video');
  el.autoplay = true;
  el.muted = true; // a browser will refuse to autoplay with sound, and a wall has no speakers
  el.playsInline = true;
  el.controls = false;
  el.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:contain;background:#000;z-index:1;';
  document.body.appendChild(el);
  video = el;
  playingId = sourceId;

  // Say so rather than showing black while the stream warms up — MediaMTX pulls a source on
  // demand, so the first few seconds after a switch are genuinely empty.
  showMessage('Connecting to the camera…', state?.name ?? '');
  el.addEventListener('playing', hideMessage, { once: true });

  if (el.canPlayType('application/vnd.apple.mpegurl')) {
    el.src = src;
    return;
  }
  try {
    const { default: Hls } = await import('hls.js');
    if (!Hls.isSupported()) {
      showMessage('This screen’s browser cannot play video', 'Use a decoder box for camera screens.');
      return;
    }
    const h = new Hls({
      // Low latency is deliberately OFF. It asks for a "part" every fraction of a second,
      // which on a Raspberry Pi is a lot of CPU and a lot of requests to watch a camera that
      // nobody is frame-racing. A second or two behind is fine on a wall.
      lowLatencyMode: false,
      // Keep almost nothing behind the live edge: a wall screen is never scrubbed backwards,
      // and buffered video is memory a small box does not have to spare.
      backBufferLength: 10,
      // The first playlist request is EXPECTED to 404 for a few seconds. MediaMTX pulls a
      // camera on demand, so nothing exists until our request wakes it — being patient here
      // is the difference between "it works" and "Camera unavailable" every time a screen
      // switches to a camera.
      manifestLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 20_000,
          maxLoadTimeMs: 30_000,
          timeoutRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 4000 },
          errorRetry: { maxNumRetry: 8, retryDelayMs: 1000, maxRetryDelayMs: 4000 },
        },
      },
    });
    h.loadSource(src);
    h.attachMedia(el);

    // Only give up on the wall after hls.js has exhausted its own retries, and keep trying
    // underneath the message — a camera that comes back should heal without anyone driving to
    // the masjid. A message that flickers on every transient hiccup is worse than none, so
    // non-fatal errors are left to hls.js entirely.
    let recovering = false;
    h.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      showMessage('Camera unavailable', 'Still trying — it will appear when the stream returns.');
      if (recovering) return;
      recovering = true;
      setTimeout(() => {
        recovering = false;
        try {
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) h.recoverMediaError();
          else h.startLoad();
        } catch {
          /* the next error will bring us back here */
        }
      }, 3000);
    });
    h.on(Hls.Events.FRAG_BUFFERED, hideMessage);
    hls = h;
  } catch {
    showMessage('Could not start the video player', '');
  }
}

// ── a message on the wall, instead of a black rectangle ─────────────────────

function showMessage(title: string, detail: string): void {
  let el = document.getElementById('msg');
  if (!el) {
    el = document.createElement('div');
    el.id = 'msg';
    el.style.cssText =
      'position:fixed;inset:0;z-index:5;display:grid;place-items:center;text-align:center;' +
      'background:#03080f;color:#8593AD;font-family:system-ui,sans-serif;gap:0.6rem;';
    document.body.appendChild(el);
  }
  el.innerHTML = '';
  const h = document.createElement('div');
  h.textContent = title;
  h.style.cssText = 'font-size:3.2vh;font-weight:600;color:#F4F7FB;';
  const d = document.createElement('div');
  d.textContent = detail;
  d.style.cssText = 'font-size:2vh;margin-top:0.8vh;';
  const wrap = document.createElement('div');
  wrap.append(h, d);
  el.appendChild(wrap);
}

function hideMessage(): void {
  document.getElementById('msg')?.remove();
}

/** One frame. Called once a second — the same cadence the video pipeline renders at, which is
 *  what the colon blink and the prohibited-time flash are timed against. */
function draw(): void {
  if (!state) return;
  const now = serverTime();
  const tt = state.timetable;

  if (state.content.kind === 'source') {
    // A camera or HDMI encoder. The browser cannot play RTSP, so the server proxies the same
    // stream as HLS under this screen's own token — see webScreen.hlsTargetFor.
    root.innerHTML = '';
    ticker.el?.remove();
    ticker = { text: '', el: null };
    applyStaleMark(null);
    void showVideo(state.content.id ?? '');
    return;
  }
  if (!tt) {
    // Deliberately not a black rectangle. A screen that has simply been switched off should
    // look switched off ON PURPOSE, and one that is misconfigured should say so — a masjid
    // staring at a black TV has no way to tell those apart, which is exactly the bug this
    // replaced.
    stopVideo();
    root.innerHTML = '';
    ticker.el?.remove();
    ticker = { text: '', el: null };
    applyStaleMark(null);
    showMessage(state.content.kind === 'off' ? 'Screen is off' : 'Nothing to show yet', state.name);
    return;
  }
  // Back to a timetable: tear down anything the other two modes left behind.
  stopVideo();
  hideMessage();

  // The slideshow phase is epoch-locked in the same function the render worker calls, so a
  // browser screen and a decoder screen showing the same timetable change picture together.
  const annFile = activeAnnouncementImage(tt, now);
  const annUrl = annFile ? (state.assets.announcements.find((u) => u.endsWith(encodeURIComponent(annFile))) ?? null) : null;

  root.innerHTML = renderDisplaySvg(tt, now, {
    bg: state.assets.background,
    logo: state.assets.logo,
    announcement: annUrl,
    bgLight: state.bgLight,
    ...(state.autoAccent ? { autoAccent: state.autoAccent } : {}),
    // Exactly as the video path does: the SVG paints the band, the motion is composited over
    // it. Here that compositor is CSS instead of ffmpeg.
    tickerBandOnly: true,
  });

  const svg = root.firstElementChild as SVGSVGElement | null;
  const w = Number(svg?.getAttribute('width')) || 1920;
  const h = Number(svg?.getAttribute('height')) || 1080;
  syncTicker(tt, now, w, h);
  applyStaleMark(staleReason());
}

async function poll(): Promise<void> {
  try {
    await fetchState();
  } catch {
    // Keep drawing from the last known state. The times stay correct — they are computed
    // locally — and `staleReason` marks the picture once the gap gets long enough to matter.
  }
  setTimeout(() => void poll(), state?.pollMs ?? 5_000);
}

async function main(): Promise<void> {
  try {
    await fetchState();
  } catch {
    root.innerHTML =
      '<div style="color:#8593AD;font:500 2vh system-ui,sans-serif;display:grid;place-items:center;height:100%">' +
      'Waiting for OpenMasjid Display…</div>';
  }
  draw();
  // Align to the second boundary so the clock changes when it should, rather than up to a
  // second late — the same reason the server's loop stamps whole seconds.
  const toNextSecond = 1000 - (Date.now() % 1000);
  setTimeout(() => {
    draw();
    setInterval(draw, 1000);
  }, toNextSecond);
  // The state poll doubles as the heartbeat — the server marks a screen seen whenever it
  // asks — so a second request for the same fact would only be more traffic.
  void poll();
  // A television left on for months: reload weekly so a shipped bundle change eventually
  // lands without anyone driving to the masjid with a keyboard.
  setTimeout(() => window.location.reload(), 7 * 24 * 60 * 60_000);
}

void main();
