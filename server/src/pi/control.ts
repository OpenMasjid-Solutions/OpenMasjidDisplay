// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Asking the root side to do something, and the Wi-Fi request in particular.
 *
 * Lifted out of `index.ts` because there are now TWO things that ask: the agent, carrying a
 * command a display server queued, and — on a standalone screen — the control panel this same
 * process is serving, carrying one somebody just pressed in a browser on the LAN.
 *
 * They must ask in exactly the same way. The alternative is a second spool writer, written from
 * the same description rather than the same code, and the first time one of them wrote the payload
 * after the verb instead of before it, root would wake on a join whose details had not landed. So
 * the writer is here, once, and the two callers differ only in where the request came from.
 *
 * Nothing in this file is privileged. It writes files into a directory the agent owns; a root
 * `.path` unit notices them and `control.sh` decides what, if anything, to do.
 */
import fs from 'node:fs';

/** Where the agent leaves its requests, and where root leaves its answers. */
export const STATE_DIR = '/var/lib/openmasjid-screen';
export const CONTROL_DIR = `${STATE_DIR}/control`;

/**
 * The closed set of things the root dispatcher will act on.
 *
 * The agent cannot do any of these itself, deliberately: it cannot write /opt, so it cannot
 * rewrite its own code, and it holds no capability that would let it reboot the machine. What it
 * CAN do is write one file into a spool directory that a root-owned systemd path unit is watching.
 *
 * Written under a dot-prefixed temporary name and renamed into place, so the watcher never wakes on
 * a half-written file — and the verb is one of a fixed set the dispatcher matches against, never
 * anything derived from the network.
 */
export type PrivilegedVerb =
  // A ROOT terminal. The only verb that hands over the whole machine, and the reason it is a verb
  // at all is that this process cannot start anything privileged — see the shell-session branch of
  // runCommand. It carries a session id and a one-time secret, never a command.
  | 'shell-session'
  // 'screenshot' is deliberately absent: the agent reads the framebuffer itself, because it is
  // already in the video group. Nothing that can be done unprivileged belongs in this list.
  | 'display-off'
  | 'display-on'
  | 'set-timezone'
  | 'set-video-mode'
  | 'keep-video-mode'
  | 'update'
  | 'reboot'
  | 'reinstall'
  | 'logs'
  | 'wifi-on'
  | 'wifi-off'
  | 'wifi-join'
  | 'wifi-forget'
  | 'wifi-rescan';

/** The five a panel may ask for directly. `wifi-join` is the only one that carries a payload. */
export const WIFI_ACTIONS = ['wifi-on', 'wifi-off', 'wifi-join', 'wifi-forget', 'wifi-rescan'] as const;
export type WifiAction = (typeof WIFI_ACTIONS)[number];

export function isWifiAction(v: unknown): v is WifiAction {
  return typeof v === 'string' && (WIFI_ACTIONS as readonly string[]).includes(v);
}

export interface Control {
  requestPrivileged(id: string, verb: PrivilegedVerb, said: string): void;
  /**
   * Ask root for a Wi-Fi change. Returns null when the request was left for root, or a sentence
   * saying why it could not be — which a panel shows to whoever pressed the button.
   */
  requestWifi(id: string, action: WifiAction, wifi?: { ssid: string; psk: string }): string | null;
}

/**
 * Bound to a logger so neither caller has to pass one at every site.
 *
 * `stateDir` is a parameter only so the tests can watch what lands on disk, in order. The spool
 * is a root-owned path on a Raspberry Pi and nothing in the product ever passes anything else.
 */
export function makeControl(log: (...args: unknown[]) => void, stateDir: string = STATE_DIR): Control {
  const controlDir = `${stateDir}/control`;

  function requestPrivileged(id: string, verb: PrivilegedVerb, said: string): void {
    try {
      fs.mkdirSync(controlDir, { recursive: true });
      const tmp = `${controlDir}/.${id}`;
      fs.writeFileSync(tmp, `${verb}\n`);
      fs.renameSync(tmp, `${controlDir}/${id}`);
      log(said);
    } catch (e) {
      log(`could not ask for "${verb}":`, (e as Error).message);
    }
  }

  function requestWifi(id: string, action: WifiAction, wifi?: { ssid: string; psk: string }): string | null {
    if (action !== 'wifi-join') {
      requestPrivileged(id, action, `asked the system to ${action.replace('-', ' ')}`);
      return null;
    }

    // The details CANNOT travel in the spool file. The dispatcher reads a verb as
    // `head -c 32 | tr -dc 'a-z-'`, which deletes digits, spaces, punctuation and capitals — a
    // network called "Masjid 5G" would arrive as "masjidg". That filter's narrowness is what keeps
    // the verb set closed, so it stays exactly as it is and the payload goes beside it.
    //
    // Both fields are base64 so no network name or password can introduce a newline, a quote or a
    // leading dash into the file's shape. Root decodes and validates them itself — this side is a
    // courier, not the check.
    if (!wifi?.ssid) {
      log('a Wi-Fi join arrived with no network name; ignoring it');
      return 'That request had no network name in it.';
    }
    try {
      const b64 = (v: string): string => Buffer.from(v, 'utf8').toString('base64');
      const NL = String.fromCharCode(10);
      const body = b64(wifi.ssid) + NL + b64(wifi.psk ?? '') + NL;
      // Written and renamed BEFORE the verb, so the dispatcher can never wake on a join whose
      // details have not landed yet. Mode 0600: it holds the masjid's Wi-Fi password.
      const tmp = `${stateDir}/.wifi-request`;
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, `${stateDir}/wifi-request`);
    } catch (e) {
      log('could not leave the Wi-Fi details for the system:', (e as Error).message);
      return 'Could not leave the details for the system to pick up.';
    }
    // The name is fine to log — it is on the air for anyone to see. The password never is.
    requestPrivileged(id, 'wifi-join', `asked the system to join "${wifi.ssid}"`);
    return null;
  }

  return { requestPrivileged, requestWifi };
}

/**
 * What root said about the last Wi-Fi join, if it has said anything since we last looked.
 *
 * Read-and-delete: the result is a one-off answer to one request, and leaving it would have the
 * panel reporting an old failure next to a working connection. Root writes it; we only ever read
 * it, so a corrupt or half-written file is treated as no answer rather than as a problem.
 */
export function readWifiResult(stateDir: string = STATE_DIR): { ok: boolean | null; detail: string; kind?: string } | undefined {
  const p = `${stateDir}/wifi-result`;
  try {
    if (!fs.existsSync(p)) return undefined;
    // Three lines now: verdict, detail, and optionally WHICH action this is the answer to. A join
    // writes the first two, as it always has, so a file with no third line is a join — which is
    // what makes this readable by an older agent and vice versa.
    const [verdict = '', detail = '', kind = ''] = fs.readFileSync(p, 'utf8').split(String.fromCharCode(10));
    fs.unlinkSync(p);
    // 'unverified' is its own answer and must not read as success: it means the join worked but
    // nothing proved the display server could still be reached afterwards.
    const ok = verdict.trim() === 'yes' ? true : verdict.trim() === 'no' ? false : null;
    const which = kind.trim();
    return { ok, detail: detail.trim().slice(0, 200), ...(which ? { kind: which.slice(0, 16) } : {}) };
  } catch {
    return undefined;
  }
}
