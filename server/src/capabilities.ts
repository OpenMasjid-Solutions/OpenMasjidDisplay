// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * What this host can do — the one thing that differs between the two machines running this panel.
 *
 * A Raspberry Pi screen is about to serve the SAME web app the OpenMasjidOS server serves
 * (docs/PI_STANDALONE_DESIGN.md §2): one React codebase, one component library, one design
 * system, no Pi-specific fork of any page. The two hosts are not equally capable, though — a Pi
 * has no WhatsApp gateway, no platform to sign in through and nowhere to send an alert — so the
 * panel asks the host what it supports and leaves out what it does not.
 *
 * **Absent, never disabled.** A capability that is off removes its navigation entry, its route
 * and its settings block entirely. Nothing renders greyed out and no layout shifts to make room
 * for something that is not there; that is what makes two screenshots of the same page
 * comparable, which is how the brief asks for this to be proved.
 *
 * This is a CAPABILITY list, not device state. What a managed Pi is called, which server owns it
 * and whether its link is local or remote are facts about one device at one moment — they belong
 * with the device record, and they arrive with the badge in phase 4. Putting them here now would
 * be inventing a shape before anything reads it.
 */

export interface Capabilities {
  /** Which machine is serving this panel. */
  host: 'server' | 'pi';
  /** Queue a WhatsApp announcement when the Iqamah changes. Needs the platform's gateway. */
  whatsapp: boolean;
  /** Serve this masjid's times to another OpenMasjid app through the platform's broker. */
  companion: boolean;
  /** Sign in through the OpenMasjidOS dashboard instead of a local password. */
  sso: boolean;
  /** Any alert destination at all — email, webhook, Slack, Discord. A Pi has none. */
  notifications: boolean;
  /** The public embeddable prayer-times widget for a masjid's own website. */
  widget: boolean;
  /** The root terminal on a Pi screen, offered by the server that manages it. */
  terminal: boolean;
  /** Remote access / tunnel settings. The platform's, never a Pi's. */
  remoteAccess: boolean;
  /** `fleet`: many screens to manage. `self`: this one screen, in the same card. */
  screens: 'fleet' | 'self';
}

/** The OpenMasjidOS server: everything this app has ever offered. */
export const SERVER_CAPABILITIES: Capabilities = {
  host: 'server',
  whatsapp: true,
  companion: true,
  sso: true,
  notifications: true,
  widget: true,
  terminal: true,
  remoteAccess: true,
  screens: 'fleet',
};

/**
 * A Raspberry Pi serving its own panel.
 *
 * Every OMOS-only feature is off, and the Screens page shows the one screen this is. Not used
 * yet — the Pi does not serve a panel until phase 2 — but it is written here, beside the
 * server's, because the pair is the contract and a contract kept in one place cannot drift from
 * itself. `capabilities.test.ts` holds them to that.
 */
export const PI_CAPABILITIES: Capabilities = {
  host: 'pi',
  whatsapp: false,
  companion: false,
  sso: false,
  notifications: false,
  widget: false,
  terminal: false,
  remoteAccess: false,
  screens: 'self',
};

/** The capabilities of the host answering this request. */
export function capabilitiesFor(host: Capabilities['host']): Capabilities {
  return host === 'pi' ? PI_CAPABILITIES : SERVER_CAPABILITIES;
}
