// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The Pi node's on-screen renderer.
 *
 * This page IS the display. It asks the local agent what to show (`GET /api/view` on
 * loopback) and draws it:
 *
 *  • a timetable — by calling the SAME `renderDisplaySvg` from packages/render-core that
 *    the controller rasterizes for RTSP screens, and dropping the returned SVG straight
 *    into the DOM. That shared call is what makes pixel parity a property of the design
 *    rather than something to keep re-checking by eye.
 *  • the status screen — the node's address in huge type, which is how an admin adopts it.
 *
 * ── Two rules ──
 * 1. NEVER STOP DRAWING. Every failure path keeps the last good frame on screen. A masjid
 *    would rather see a timetable a minute stale than a blank TV or an error page, and the
 *    times are computed locally from the clock anyway — no network needed to stay correct.
 * 2. The frame is a pure function of (document, now). Nothing is cached between ticks, so
 *    a document change takes effect on the next second with no reload.
 */
import { renderDisplaySvg, type Timetable } from '../../../packages/render-core/src/index';

/** Mirrors the agent's KioskView (node/agent/src/agent.ts). */
type View =
  | { kind: 'timetable'; doc: Timetable; clockSynced: boolean }
  | {
      kind: 'status';
      serial: string;
      model: string;
      fw: string;
      ip: string;
      adopted: boolean;
      controllerName: string;
      linked: boolean;
      note: string;
      identify?: { name: string; untilMs: number };
    };

/** How often we ask the agent what to show. The frame itself redraws every second. */
const POLL_MS = 2000;

const root = document.getElementById('screen');
if (!root) throw new Error('#screen missing from index.html');

let view: View | null = null;
/** Last SVG we wrote, so an unchanged frame is not re-parsed by the browser. */
let lastHtml = '';

async function poll(): Promise<void> {
  try {
    const res = await fetch('/api/view', { cache: 'no-store' });
    if (res.ok) view = (await res.json()) as View;
  } catch {
    // The agent is restarting. Keep the last frame up — rule 1.
  }
}

function draw(): void {
  const now = new Date();
  let html: string;
  try {
    html = view?.kind === 'timetable' ? renderDisplaySvg(view.doc, now, {}) : statusSvg(view, now);
  } catch (err) {
    // A malformed document must not blank the screen or spin the CPU on an exception every
    // second. Say so on screen once and keep the clock running.
    html = messageSvg('Could not draw this screen', String(err instanceof Error ? err.message : err), now);
  }
  if (html !== lastHtml) {
    root!.innerHTML = html;
    lastHtml = html;
  }
}

// ── The status / diagnostic screen ────────────────────────────────────────────

const W = 1920;
const H = 1080;

const esc = (s: string): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const clock = (d: Date): string =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * The page an unadopted node shows, and the fallback whenever content cannot be drawn.
 *
 * The IP is deliberately enormous: an admin reads it off a TV from across a prayer hall
 * and types it into the panel. That single number is the whole adoption flow.
 */
function statusSvg(v: View | null, now: Date): string {
  if (v && v.kind !== 'status') return messageSvg('Starting…', '', now);
  const s = v;
  const identifying = !!s?.identify && Date.now() < s.identify.untilMs;
  const addr = s?.ip || 'no network';
  const headline = identifying ? s?.identify?.name || 'This screen' : addr;
  const sub = identifying
    ? addr
    : s?.adopted
      ? `${s.linked ? 'Connected to' : 'Waiting for'} ${s.controllerName || 'the control panel'}`
      : 'Ready to adopt — type this address into your OpenMasjid control panel';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="sky" cx="50%" cy="18%" r="85%">
      <stop offset="0%" stop-color="#0d3b34"/><stop offset="100%" stop-color="#04120f"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  <text x="${W / 2}" y="170" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, sans-serif"
        font-size="46" fill="#7fd8c4" letter-spacing="6">OPENMASJID DISPLAY</text>
  <text x="${W / 2}" y="${identifying ? 520 : 500}" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, sans-serif"
        font-size="${headline.length > 20 ? 110 : 168}" font-weight="700" fill="#ffffff">${esc(headline)}</text>
  <text x="${W / 2}" y="600" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, sans-serif"
        font-size="44" fill="#cbeee4">${esc(sub)}</text>
  ${s?.note ? `<text x="${W / 2}" y="672" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, sans-serif" font-size="34" fill="#f2c14e">${esc(s.note)}</text>` : ''}
  <text x="${W / 2}" y="${H - 120}" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, sans-serif"
        font-size="30" fill="#7fb3a6">${esc(s?.model || 'Raspberry Pi')} · serial ${esc(s?.serial ?? '—')} · firmware ${esc(s?.fw ?? '—')}</text>
  <text x="${W / 2}" y="${H - 64}" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, sans-serif"
        font-size="34" fill="#4f8b7d">${clock(now)}</text>
</svg>`;
}

/** A plain full-screen message (startup, or a render failure). */
function messageSvg(title: string, detail: string, now: Date): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#04120f"/>
  <text x="${W / 2}" y="${H / 2 - 20}" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, sans-serif"
        font-size="72" fill="#ffffff">${esc(title)}</text>
  ${detail ? `<text x="${W / 2}" y="${H / 2 + 60}" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, sans-serif" font-size="34" fill="#f2c14e">${esc(detail).slice(0, 160)}</text>` : ''}
  <text x="${W / 2}" y="${H - 64}" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, sans-serif"
        font-size="34" fill="#4f8b7d">${clock(now)}</text>
</svg>`;
}

// ── Loop ──────────────────────────────────────────────────────────────────────

// Draw immediately so the TV is never blank while the first fetch is in flight.
draw();
void poll().then(draw);
setInterval(() => void poll(), POLL_MS);
// One second, aligned to the wall clock, so the displayed minute flips when it should.
setInterval(draw, 1000);
