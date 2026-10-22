// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * pi/pairing.ts — what a freshly installed Pi puts on the television.
 *
 * This screen is the entire setup instructions for the product. Someone has plugged a Pi into a
 * television in a hall, and the only interface they have is that television: no keyboard, no
 * browser on the device, nothing to read but what we draw. So it has to say, in the order a
 * person needs it, what this box is, what to do next, and enough detail for whoever gets called
 * when it does not work.
 *
 * The pairing code is the largest thing on the screen because it is the one thing that gets
 * typed. It is deliberately the code and not the Pi's IP address: the address is on a network
 * the display server may not share — the server can be in the cloud — and DHCP can move it
 * between reboots. A code read off the screen also proves whoever is typing it can see this
 * screen, which is the closest thing to physical presence we can ask for. The address is still
 * shown, small, underneath, because it is what someone diagnosing a network problem asks for
 * first.
 *
 * Pure string building, exactly like `render/svg.ts`: no clock, no filesystem, no state. That
 * keeps it testable by comparing strings and means a wrong pixel is a wrong character in a test
 * rather than something only a television can tell you.
 */
import { THEMES } from '../render/theme';
import { approxWidth, FONT_SANS } from '../render/svg';

/** The brand palette — the same one the panel and the timetable use, so a Pi waiting to be set
 *  up already looks like the product it belongs to rather than a boot message. */
const P = (THEMES.find((t) => t.id === 'cyan') ?? THEMES[0]).palette;

/** Escape text for XML. The hostname and IP come off the device and the server address comes
 *  out of a config file, so none of them are ours to trust unescaped. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface PairingView {
  /** the code an admin types into the panel; empty while we have not been given one yet */
  code: string;
  /** the Pi's own address on the masjid's network, for whoever is diagnosing */
  ip: string;
  hostname: string;
  /** the display server this agent is talking to, or '' when this screen runs standalone */
  server: string;
  /**
   * Setting itself up on its own rather than enrolling with a display server.
   *
   * The code is then typed into THIS Pi's own panel, so the instruction has to name its address
   * instead of the dashboard — somebody standing in a hall with no server anywhere needs to be
   * told where to go, and "Dashboard → Screens" is an instruction they cannot follow.
   */
  standalone?: boolean;
  /** what is going on right now, in one plain sentence */
  status: string;
  /** true once the server has answered at least once — decides which colour the dot is */
  connected: boolean;
  agentVersion: string;
}

/**
 * The waiting screen.
 *
 * Rendered at a fixed 1920×1080 and scaled by resvg to whatever the television negotiated, so
 * the layout is written once against one size instead of reflowing per monitor.
 */
export function pairingSvg(v: PairingView): string {
  const W = 1920;
  const H = 1080;
  const dot = v.connected ? P.primarySoft : P.gold;

  // Letter-spaced by hand rather than with `letter-spacing`, which resvg does not apply to
  // `text-anchor: middle` the way a browser does — the string would drift off centre.
  // The two lines that differ between enrolling with a server and setting up on its own. They
  // live here, with the rest of the screen's words, rather than being passed in by a caller that
  // has no other opinion about what the television says.
  const prompt = v.standalone ? 'ENTER THIS CODE TO SET UP THIS SCREEN' : 'ENTER THIS CODE IN THE DASHBOARD';
  const where = v.standalone
    ? v.ip
      ? `In a browser on this network, open  http://${v.ip}`
      : 'Connect this screen to the network to continue'
    : 'Dashboard → Screens → Raspberry Pi screens';

  const codeChars = [...(v.code || '······')];
  const cellW = 132;
  const codeW = codeChars.length * cellW;
  const codeX = (W - codeW) / 2 + cellW / 2;

  const cells = codeChars
    .map((ch, i) => {
      const x = codeX + i * cellW;
      // A space is the grouping in "2640 4654", not a character to put in a box. Drawing one
      // gave an empty ninth box on the television, which reads as a digit somebody forgot.
      if (ch === ' ') return '';
      return (
        `<rect x="${x - cellW / 2 + 8}" y="470" width="${cellW - 16}" height="168" rx="18" ` +
        `fill="${P.surface}" stroke="${P.border}" stroke-width="2"/>` +
        `<text x="${x}" y="596" text-anchor="middle" font-family="DejaVu Sans, sans-serif" ` +
        `font-size="112" font-weight="700" fill="${P.gold}">${esc(ch)}</text>`
      );
    })
    .join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs>` +
    `<radialGradient id="scene" cx="50%" cy="0%" r="120%">` +
    `<stop offset="0%" stop-color="${P.bg2}"/><stop offset="100%" stop-color="${P.bg}"/>` +
    `</radialGradient>` +
    `</defs>` +
    `<rect width="${W}" height="${H}" fill="url(#scene)"/>` +

    // Identity, so nobody has to guess what the box on the shelf is.
    `<text x="${W / 2}" y="248" text-anchor="middle" font-family="DejaVu Sans, sans-serif" ` +
    `font-size="46" font-weight="600" fill="${P.text}">OpenMasjidDisplay</text>` +
    `<text x="${W / 2}" y="316" text-anchor="middle" font-family="DejaVu Sans, sans-serif" ` +
    `font-size="34" fill="${P.textDim}">This screen is ready to be set up</text>` +

    `<text x="${W / 2}" y="424" text-anchor="middle" font-family="DejaVu Sans, sans-serif" ` +
    `font-size="30" fill="${P.textFaint}">${esc(prompt)}</text>` +
    cells +

    // The one instruction. Named exactly as the panel names it, so the words match the buttons.
    `<text x="${W / 2}" y="726" text-anchor="middle" font-family="DejaVu Sans, sans-serif" ` +
    `font-size="32" fill="${P.textDim}">${esc(where)}</text>` +

    // Status line, with the dot that tells you whether the network half works.
    `<circle cx="${W / 2 - 300}" cy="836" r="10" fill="${dot}"/>` +
    `<text x="${W / 2 - 274}" y="846" font-family="DejaVu Sans, sans-serif" font-size="26" ` +
    `fill="${P.textDim}">${esc(v.status)}</text>` +

    // The small print: what a person on the phone to whoever set this up will be asked for.
    `<text x="${W / 2}" y="962" text-anchor="middle" font-family="DejaVu Sans, sans-serif" ` +
    `font-size="24" fill="${P.textFaint}">` +
    `${esc(v.hostname)}  ·  ${esc(v.ip || 'no network')}` +
    (v.server ? `  ·  server ${esc(v.server)}` : '') +
    `  ·  agent ${esc(v.agentVersion)}` +
    `</text>` +
    `</svg>`
  );
}

/**
 * The screen for when something is wrong enough that there is nothing to show.
 *
 * A black television is indistinguishable from a dead Pi, a dead television and a pulled cable,
 * so we always draw *something*. This is the difference between "the screen is broken" and "the
 * screen is telling me the server is unreachable", which is the difference between a callout and
 * a two-minute fix.
 */
export function messageSvg(title: string, detail: string): string {
  const W = 1920;
  const H = 1080;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="${P.bg}"/>` +
    `<text x="${W / 2}" y="${H / 2 - 20}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" ` +
    `font-size="52" font-weight="600" fill="${P.text}">${esc(title)}</text>` +
    `<text x="${W / 2}" y="${H / 2 + 56}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" ` +
    `font-size="32" fill="${P.textDim}">${esc(detail)}</text>` +
    `</svg>`
  );
}

/** What the badge says. */
export const CONNECTION_LOST = 'Server connection lost';

/**
 * A managed screen that cannot reach its display server: a small badge in the top-right corner,
 * over whatever it is drawing.
 *
 * It used to replace the whole picture with a "Lost contact" card. That threw away a timetable
 * that was still right — the times are worked out here, from the Pi's own clock — and blanked the
 * wall for as long as the outage lasted. What an outage actually costs is that a change made in
 * the dashboard may not have arrived, which is for whoever looks after the screens to notice, not
 * a reason to stop showing the times.
 *
 * In the page MARGIN, so it covers nothing: every layout starts its content 5% of the short side
 * in from the edge (`P` in renderDisplaySvg), and the badge stays inside that strip, its right edge
 * on the content's. It carries its own dark fill, so the white ink reads on a light page and a
 * dark one alike. Size and place come from the frame's own `width`/`height`, so it fits a 720p,
 * a 1080p and a portrait frame the same way.
 */
export function withConnectionLost(svg: string): string {
  const m = /^<svg\b[^>]*?\bwidth="([\d.]+)"[^>]*?\bheight="([\d.]+)"/.exec(svg);
  const end = svg.lastIndexOf('</svg>');
  if (!m || end < 0) return svg;
  const W = Number(m[1]);
  const H = Number(m[2]);
  const margin = Math.round(Math.min(W, H) * 0.05);
  const h = margin * 0.74;
  const fs = h * 0.46;
  const dot = fs * 0.3;
  const pad = h * 0.42;
  const w = pad + dot * 2 + fs * 0.5 + approxWidth(CONNECTION_LOST, fs) + pad;
  const x = W - margin - w;
  const y = (margin - h) / 2;
  const f = (n: number) => n.toFixed(1);
  return (
    svg.slice(0, end) +
    `<g>` +
    `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="${f(h / 2)}" fill="#000000" fill-opacity="0.62"/>` +
    `<circle cx="${f(x + pad + dot)}" cy="${f(y + h / 2)}" r="${f(dot)}" fill="#ff5a4e"/>` +
    `<text x="${f(x + pad + dot * 2 + fs * 0.5)}" y="${f(y + h / 2 + fs * 0.36)}" font-family="${FONT_SANS}" font-size="${f(fs)}" font-weight="600" fill="#ffffff">${esc(CONNECTION_LOST)}</text>` +
    `</g>` +
    svg.slice(end)
  );
}
