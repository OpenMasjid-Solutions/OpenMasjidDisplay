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
  /**
   * This panel can change things, as opposed to only showing them.
   *
   * False only on a Raspberry Pi that a Display server has adopted. The server owns the timetable
   * and the settings from that moment, so a panel here that offered to edit them would be
   * offering to edit a copy nothing reads — which is worse than offering nothing, because the
   * admin would believe they had changed something.
   *
   * **Stated as a capability the host HAS, not a restriction it is under**, and that is not
   * cosmetic. Every other flag here means "this host can do X", which is what lets
   * `capabilities.test.ts` assert the server's profile is simply everything on. A flag meaning
   * "this host is restricted" would have been the one entry in the set whose false is normal, and
   * it broke that test the moment it was added — which is the test doing its job.
   *
   * On a Pi, `!editable` IS "adopted", unambiguously: a standalone Pi is editable and so is a
   * server. The panel words it as *Managed* because that is what an admin calls it.
   *
   * It is a CAPABILITY rather than device state, by the rule at the top of this file: it answers
   * "what can this panel do", not "what is this device called". The screen's name, the server
   * that owns it and whether that server can be reached are facts about one device at one moment
   * and travel with the status payload, not here.
   */
  editable: boolean;
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
  editable: true,
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
  editable: true,
};

/**
 * The same Pi, once a Display server has adopted it.
 *
 * It still serves a panel — that is the point. An adopted screen used to serve nothing at all,
 * so a masjid whose server died for good had a wall of screens it could only reach over SSH, and
 * the one thing an admin needs at that moment is to see what the screen thinks is going on.
 *
 * Everything is off, including `screens`, because there is nothing on this device to change. The
 * panel is one status page.
 */
export const MANAGED_PI_CAPABILITIES: Capabilities = {
  ...PI_CAPABILITIES,
  editable: false,
};

/**
 * The capabilities of the host answering this request.
 *
 * `managed` is only ever true for a Pi: a Display server is not adopted by anything, and asking
 * for a managed server is a caller that has confused the two.
 */
export function capabilitiesFor(host: Capabilities['host'], managed = false): Capabilities {
  if (host !== 'pi') return SERVER_CAPABILITIES;
  return managed ? MANAGED_PI_CAPABILITIES : PI_CAPABILITIES;
}
