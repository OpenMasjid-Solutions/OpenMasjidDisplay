// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * OpenMasjidOS Fabric — single sign-on (optional, server→server).
 *
 * The Fabric is the platform↔app integration layer (appearance + SSO). When this
 * app runs under OpenMasjidOS, the platform injects OPENMASJID_BASE_URL and a
 * per-app OPENMASJID_APP_SECRET, and the browser also sends the platform's
 * `omos_session` cookie to us (same host, different port = same-site). We never
 * trust that cookie ourselves — we ask the platform to validate it.
 *
 * SSO is IDENTITY-BOUND: the platform fails closed unless we present our per-app
 * secret in the X-OpenMasjid-App-Secret header, so the shared session cookie can't
 * let some other installed app validate (or impersonate) the session as us. A
 * positive result is cached briefly per token so we don't call on every request.
 *
 * Everything here degrades gracefully: no base URL, no secret, no cookie, or an
 * unreachable platform all simply mean "no SSO", and the app falls back to its own
 * password. The wire identifiers (env vars, header, cookie, endpoint) are the
 * shared Fabric contract — do not rename them. See docs/FABRIC.md.
 */
import type { IncomingMessage } from 'node:http';
import { config } from './config';
import { makeLog } from './logger';

const log = makeLog('fabric');

/** Is Fabric SSO even possible? Needs the platform's address AND our per-app
 *  secret — without the secret the identity-bound platform fails closed, so we
 *  treat SSO as unavailable and fall back to our own login. */
export function ssoConfigured(): boolean {
  return !!config.omosBaseUrl && !!config.omosAppSecret;
}

/**
 * Is `host` a loopback / private / LAN address where sending our app secret over
 * plain HTTP is acceptable? Covers loopback (127.0.0.1/::1/localhost), RFC1918
 * private ranges (10/172.16-31/192.168), link-local (169.254 / fe80), and the
 * mDNS/intranet hostnames the product uses by default (*.local, *.lan). Anything
 * else is treated as a PUBLIC host. We err on the side of "safe" only for these
 * well-known private cases — an unrecognised host is considered public.
 */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, ''); // strip IPv6 brackets
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (h.endsWith('.local') || h.endsWith('.lan')) return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true; // IPv6 link-local + unique-local
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  }
  return false;
}

// Warn at most once for the whole process — a cleartext secret on a public host is
// a config concern, not a per-request event, so we don't want to spam the log.
let cleartextSecretWarned = false;

/**
 * One-time warning when our per-app Fabric secret is about to be sent in cleartext
 * to a PUBLIC host (non-https base URL whose host is not loopback/private/LAN). The
 * default LAN flow (http://openmasjidos.local, a 192.168.x.x box, …) is fine and
 * stays silent. We never stop sending — this only nudges cross-host deployments
 * toward an https OPENMASJID_BASE_URL. See docs/FABRIC.md.
 */
function warnIfCleartextSecret(): void {
  if (cleartextSecretWarned || !config.omosBaseUrl) return;
  let url: URL;
  try {
    url = new URL(config.omosBaseUrl);
  } catch {
    return; // malformed base URL — the fetch below will fail and be handled there
  }
  if (url.protocol === 'https:') return; // encrypted — nothing to warn about
  if (isPrivateHost(url.hostname)) return; // trusted LAN — sending over http is fine
  cleartextSecretWarned = true;
  log.warn(
    `OPENMASJID_BASE_URL is a public address over plain http (${url.host}); this app's Fabric secret ` +
      `is being sent across the network unencrypted. For a cross-host deployment, set an https ` +
      `OPENMASJID_BASE_URL so the secret isn't exposed. (Over a trusted LAN, plain http is fine.)`,
  );
}

export interface NotifyPayload {
  text: string;
  title?: string;
  level?: 'info' | 'success' | 'warning' | 'error';
}

/**
 * Relay a message to the masjid's configured webhook via the Fabric (server→server,
 * authenticated with our per-app secret). The platform owns the destination — we
 * never see the webhook URL — and it requires the notifications capability
 * (manifest `notifications: true`). FAILS SOFT: no platform, no secret, the admin
 * hasn't enabled notifications, or any error → returns delivered:false and the app
 * carries on. Never throws. See docs/FABRIC.md.
 */
export async function notify(payload: NotifyPayload): Promise<{ delivered: boolean; reason?: string }> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return { delivered: false, reason: 'no-fabric' };
  if (!payload.text?.trim()) return { delivered: false, reason: 'empty' };
  warnIfCleartextSecret(); // about to send the per-app secret — flag it if cleartext to a public host
  // The timer is cleared in `finally`, not straight after the fetch. `fetch` resolves as soon
  // as the response HEADERS arrive, so disarming it there left the BODY read with no deadline
  // at all — and a platform that sends headers and then stalls would hang this call forever.
  // That is not hypothetical: the announcer holds an in-flight flag across the await, so one
  // stalled body would stop every future Iqamah announcement until the app restarted.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/notify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openmasjid-app-secret': config.omosAppSecret,
      },
      body: JSON.stringify({ text: payload.text, title: payload.title, level: payload.level ?? 'info' }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    if (!res.ok) {
      log.warn(`Fabric notify not delivered: platform returned HTTP ${res.status} (is this app allowed to send notifications, and updated in OpenMasjidOS?)`);
      return { delivered: false, reason: `http_${res.status}` };
    }
    const j = (await res.json().catch(() => ({}))) as { delivered?: boolean; reason?: string };
    if (j.delivered !== true) {
      log.warn(`Fabric notify not delivered (reason: ${j.reason ?? 'unknown'}) — e.g. notifications not enabled in OpenMasjidOS Settings.`);
    }
    return { delivered: j.delivered === true, reason: j.reason };
  } catch (err) {
    log.warn(`Fabric notify could not reach the platform at ${config.omosBaseUrl || '(unset)'}: ${err instanceof Error ? err.message : err}`);
    return { delivered: false, reason: 'unreachable' };
  } finally {
    clearTimeout(t);
  }
}

export interface SiteInfo {
  /** is remote access (the admin's Cloudflare tunnel) enabled? */
  enabled: boolean;
  /** the app's public base URL behind the tunnel (e.g. https://masjid.org/display), or '' */
  publicUrl: string;
  /** the path the app is served under behind the tunnel (e.g. /display), or '' */
  basePath: string;
}

/**
 * Ask the platform for this app's PUBLIC URL behind the admin's Cloudflare tunnel
 * (GET /api/fabric/site, identity-bound via the per-app secret + the `domain`
 * capability). Used so the web-widget embed code can point at a public address when
 * remote access is on. FAILS SOFT: no Fabric, not capable, tunnel off, or any error
 * → null, and callers fall back to the LAN URL. Never throws.
 */
export async function siteInfo(): Promise<SiteInfo | null> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return null;
  warnIfCleartextSecret();
  // The timer is cleared in `finally`, not straight after the fetch. `fetch` resolves as soon
  // as the response HEADERS arrive, so disarming it there left the BODY read with no deadline
  // at all — and a platform that sends headers and then stalls would hang this call forever.
  // That is not hypothetical: the announcer holds an in-flight flag across the await, so one
  // stalled body would stop every future Iqamah announcement until the app restarted.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/site`, {
      headers: { 'x-openmasjid-app-secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { enabled?: boolean; publicUrl?: unknown; basePath?: unknown };
    return {
      enabled: j.enabled === true,
      publicUrl: typeof j.publicUrl === 'string' ? j.publicUrl : '',
      basePath: typeof j.basePath === 'string' ? j.basePath : '',
    };
  } catch (err) {
    log.debug(`fabric site lookup failed: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Can this masjid send WhatsApp at all, and if not, why?
 *
 * The platform answers with a deliberately tiny vocabulary (docs/WHATSAPP.md) so an app
 * renders one of a few sentences rather than tracking the gateway's lifecycle. We ask
 * before offering the feature: without this, "post to WhatsApp" is a switch that looks
 * available on every install and fails only when a real announcement was due.
 *
 * Two reasons are ours, not the platform's: `no-fabric` (running standalone — there is no
 * platform to ask) and `not-allowed` (the platform's 403, i.e. this build's manifest is
 * missing `whatsapp: true` or OpenMasjidOS hasn't picked the new manifest up yet). Both
 * need different words on screen from "the gateway is down", so they stay distinct.
 * FAILS SOFT — never throws.
 */
export type WhatsAppReason =
  | 'ready'
  | 'not-configured'
  | 'not-linked'
  | 'unreachable'
  | 'not-allowed'
  | 'no-fabric';

export interface WhatsAppAvailability {
  available: boolean;
  reason: WhatsAppReason;
  /** can the platform carry an image? Absent on older platforms, and MUST read as false —
   *  ask before rendering, because building a 1080×1350 poster is real work on a Pi and the
   *  capability read costs nothing. */
  media: boolean;
  /** the platform's own decoded-bytes cap. Read it rather than hardcoding: it is theirs to
   *  change, and a number baked in here would silently become wrong. 0 when unknown. */
  maxMediaBytes: number;
  /** can we ask what became of a message we handed over? (OpenMasjidOS 0.51.1+). Absent on an
   *  older platform, and MUST read as false — asking anyway would turn every queued notice
   *  into an unanswerable question, and treating "cannot ask" as "did not arrive" would be
   *  worse still. */
  outcomes: boolean;
}

const WA_REASONS: readonly WhatsAppReason[] = [
  'ready',
  'not-configured',
  'not-linked',
  'unreachable',
  'not-allowed',
  'no-fabric',
];

const NO_MEDIA = { media: false, maxMediaBytes: 0, outcomes: false };

export async function whatsappAvailability(): Promise<WhatsAppAvailability> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return { available: false, reason: 'no-fabric', ...NO_MEDIA };
  warnIfCleartextSecret();
  // The timer is cleared in `finally`, not straight after the fetch. `fetch` resolves as soon
  // as the response HEADERS arrive, so disarming it there left the BODY read with no deadline
  // at all — and a platform that sends headers and then stalls would hang this call forever.
  // That is not hypothetical: the announcer holds an in-flight flag across the await, so one
  // stalled body would stop every future Iqamah announcement until the app restarted.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp`, {
      headers: { 'x-openmasjid-app-secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    // 403 is the platform saying this app may not send — a different sentence from a
    // gateway that is merely down, so don't collapse it into 'unreachable'.
    if (res.status === 403) return { available: false, reason: 'not-allowed', ...NO_MEDIA };
    if (!res.ok) return { available: false, reason: 'unreachable', ...NO_MEDIA };
    const j = (await res.json().catch(() => ({}))) as {
      available?: unknown;
      reason?: unknown;
      media?: unknown;
      maxMediaBytes?: unknown;
      outcomes?: unknown;
    };
    // Nothing from the platform is trusted as typed: an unknown reason word becomes
    // 'unreachable' rather than reaching the UI as a raw string with no sentence for it.
    const reason = WA_REASONS.includes(j.reason as WhatsAppReason) ? (j.reason as WhatsAppReason) : 'unreachable';
    // `media` absent = an older platform that cannot carry an image. It must read as false,
    // or we would render a poster and post nothing.
    const media = j.media === true;
    const maxMediaBytes =
      media && typeof j.maxMediaBytes === 'number' && Number.isFinite(j.maxMediaBytes) && j.maxMediaBytes > 0
        ? Math.floor(j.maxMediaBytes)
        : 0;
    // Same rule as `media`: absent means an older platform, which means no.
    const outcomes = j.outcomes === true;
    return { available: j.available === true && reason === 'ready', reason, media, maxMediaBytes, outcomes };
  } catch (err) {
    log.debug(`fabric whatsapp status failed: ${err instanceof Error ? err.message : err}`);
    return { available: false, reason: 'unreachable', ...NO_MEDIA };
  } finally {
    clearTimeout(t);
  }
}

export interface WhatsAppGroup {
  /** the group's JID, e.g. "1203630…@g.us" — opaque to us */
  id: string;
  label: string;
}

/**
 * The WhatsApp groups this app may post into — only the ones the ADMIN approved in
 * OpenMasjidOS. We never see the masjid's other groups, and an id we did not get from
 * this list is refused by the platform with a 403.
 *
 * Approval can be withdrawn at any time, so an empty list means "no groups available"
 * and the UI hides the feature rather than erroring. FAILS SOFT → [].
 */
export async function whatsappGroups(): Promise<WhatsAppGroup[]> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return [];
  warnIfCleartextSecret();
  // The timer is cleared in `finally`, not straight after the fetch. `fetch` resolves as soon
  // as the response HEADERS arrive, so disarming it there left the BODY read with no deadline
  // at all — and a platform that sends headers and then stalls would hang this call forever.
  // That is not hypothetical: the announcer holds an in-flight flag across the await, so one
  // stalled body would stop every future Iqamah announcement until the app restarted.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp/groups`, {
      headers: { 'x-openmasjid-app-secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    if (!res.ok) return [];
    const j = (await res.json().catch(() => ({}))) as { groups?: unknown };
    if (!Array.isArray(j.groups)) return [];
    return j.groups
      .map((g) => g as { id?: unknown; label?: unknown })
      .filter((g) => typeof g.id === 'string' && g.id)
      .map((g) => ({ id: String(g.id), label: typeof g.label === 'string' ? g.label : String(g.id) }))
      .slice(0, 100);
  } catch (err) {
    log.debug(`fabric whatsapp groups failed: ${err instanceof Error ? err.message : err}`);
    return [];
  } finally {
    clearTimeout(t);
  }
}

/**
 * Post a message to an approved WhatsApp group through the platform's queue.
 *
 * QUEUED IS NOT SENT. A 202 means accepted for later delivery, full stop — so nothing here may
 * block on it or report "sent" to anyone. What comes back can be followed up afterwards
 * (whatsappMessageStatus), and even a `sent` verdict means "handed to WhatsApp", never "read":
 * WhatsApp gives no delivery receipt.
 *
 * **The platform no longer paces us** (OpenMasjidOS 0.51.1). Quiet hours, the hourly and daily
 * caps, the per-recipient and per-group cooldowns, the warm-up ramp and the random gap between
 * messages are gone; a typing indicator is the only pause left, and a message goes out within
 * seconds. It used to refuse to send too much and it does not any more — so the bound on what
 * this app sends is now entirely this app's, and it is structural: one approved group, never a
 * person; one message per Iqamah change, deduped through the persisted log; five attempts at
 * thirty-minute intervals; one post in flight. See whatsappAnnounce.ts. There is no loop here to
 * turn into a thousand messages, and adding one would put the masjid's NUMBER at risk — which is
 * unrecoverable, and shared by every app on the box.
 *
 * We never touch the gateway, its key, or the linked number. FAILS SOFT — never throws.
 */
export interface WhatsAppMedia {
  /** the image itself. Base64 is the platform's wire format (OpenWA takes base64, not a URL). */
  data: string;
  mimeType: 'image/png';
  filename: string;
}

/** The platform caps a caption at 1024 characters and refuses a longer one at enqueue —
 *  while our request is still open, so it surfaces here rather than as a silent gateway
 *  failure after the 202. We stay under it ourselves so that never has to happen. */
export const WA_CAPTION_MAX = 1024;

export async function whatsappSendToGroup(
  group: string,
  text: string,
  media?: WhatsAppMedia,
): Promise<{ queued: boolean; id?: string; error?: string }> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return { queued: false, error: 'OpenMasjidOS is not connected.' };
  if (!group.trim()) return { queued: false, error: 'No WhatsApp group chosen.' };
  // Text is optional when an image carries the message — a poster can speak for itself — but
  // a post with neither is nothing at all.
  if (!text.trim() && !media) return { queued: false, error: 'Nothing to send.' };
  warnIfCleartextSecret();
  const ctrl = new AbortController();
  // Longer than a text post: this uploads a few hundred KB, and the platform validates the
  // image while our request is open so a refusal is answered rather than logged remotely.
  const t = setTimeout(() => ctrl.abort(), media ? 20000 : 6000);
  try {
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openmasjid-app-secret': config.omosAppSecret,
      },
      body: JSON.stringify(media ? { group, text, media } : { group, text }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    const j = (await res.json().catch(() => ({}))) as { queued?: unknown; id?: unknown; error?: unknown };
    if (!res.ok || j.queued !== true) {
      // The platform's own wording is the useful one here (an unapproved group, a full
      // queue, a cap reached) — pass it through, and never log the message body.
      const error = typeof j.error === 'string' && j.error ? j.error : `The platform refused the message (HTTP ${res.status}).`;
      log.warn(`WhatsApp post not queued: ${error}`);
      return { queued: false, error };
    }
    // The id is what makes "did that notice actually go out?" answerable later — see
    // whatsappMessageStatus. Absent on a platform older than 0.51.1, which is not an error:
    // the message is queued either way, we just cannot follow it up.
    const id = typeof j.id === 'string' && j.id.trim() ? j.id.trim().slice(0, 64) : undefined;
    return id ? { queued: true, id } : { queued: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`WhatsApp post could not reach the platform at ${config.omosBaseUrl || '(unset)'}: ${msg}`);
    return { queued: false, error: 'Could not reach OpenMasjidOS.' };
  } finally {
    clearTimeout(t);
  }
}

/**
 * What became of a message we handed over (OpenMasjidOS 0.51.1+).
 *
 * This exists because for a long time it could not: `202 {queued:true}` was the last thing
 * anybody knew, and when the platform's queue had a head-of-line block — one held-up message
 * stopping every message behind it, from every app, and a failing one pausing the whole queue
 * for its retry delay — the symptom here was a poster that never arrived with nothing, at
 * either end, able to say so. The queue is fixed and now persisted across restarts; this is
 * the other half, so a masjid can be told the truth rather than "queued" forever.
 *
 * ## `null` is not a failure
 *
 * The return is deliberately three-valued: a state, or `null` for "we could not learn one".
 * A 404 (evicted from the platform's bounded history, or never ours), an older platform, a
 * timeout and an unreachable box all give `null`, and every one of them must leave a queued
 * notice exactly as it was. Collapsing "cannot ask" into "did not arrive" would re-announce
 * things a group already has, which is a worse fault than not knowing.
 *
 * FAILS SOFT — never throws.
 */
export type WhatsAppState = 'queued' | 'sent' | 'failed' | 'expired';

const WA_STATES: readonly WhatsAppState[] = ['queued', 'sent', 'failed', 'expired'];

export interface WhatsAppOutcome {
  /** the platform's verdict, or null when we could not learn one — never treat as a failure */
  state: WhatsAppState | null;
  /** the platform's own words for a failed/expired message; safe to show an admin */
  reason?: string;
}

export async function whatsappMessageStatus(id: string): Promise<WhatsAppOutcome> {
  if (!config.omosBaseUrl || !config.omosAppSecret || !id.trim()) return { state: null };
  warnIfCleartextSecret();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp/status/${encodeURIComponent(id)}`, {
      headers: { 'x-openmasjid-app-secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    // 404 is "not yours, or unknown", which on a bounded history is also "old enough to have
    // been forgotten". None of those are a verdict.
    if (!res.ok) return { state: null };
    const j = (await res.json().catch(() => ({}))) as { state?: unknown; reason?: unknown };
    if (!WA_STATES.includes(j.state as WhatsAppState)) return { state: null };
    const reason = typeof j.reason === 'string' && j.reason.trim() ? j.reason.trim().slice(0, 200) : undefined;
    return reason ? { state: j.state as WhatsAppState, reason } : { state: j.state as WhatsAppState };
  } catch (err) {
    log.debug(`fabric whatsapp status lookup failed: ${err instanceof Error ? err.message : err}`);
    return { state: null };
  } finally {
    clearTimeout(t);
  }
}

/**
 * A window in which the platform's own "sent" cannot be trusted.
 *
 * A masjid's WhatsApp session expired the way WhatsApp Desktop signs itself out, and nothing
 * noticed: the gateway went on accepting messages and the platform went on recording them `sent`,
 * for over a day, while none of them arrived. The platform detects that within about ten minutes
 * now, but there is a residual window between the link dying and it being noticed, and the messages
 * inside that window were recorded `sent`.
 *
 * The platform cannot resend them — it deletes a message's contents the moment it hands it to the
 * gateway, on purpose — so the app that still has the source data is the only thing that can. For
 * this app that is an Iqamah-change notice, and it is exactly the kind of message worth sending
 * again: somebody turns up at the wrong time otherwise.
 *
 * On the READ budget (600/min), not the send budget, so polling this costs no sends.
 */
/** Why the link was down. More may be added, so anything unrecognised reads as 'unknown'. */
export type SuspectCause = 'session-expired' | 'needs-relink' | 'key-rejected' | 'unknown';
const SUSPECT_CAUSES: SuspectCause[] = ['session-expired', 'needs-relink', 'key-rejected', 'unknown'];

export interface SuspectWindow {
  /** epoch ms */
  from: number;
  to: number;
  /** how many of OUR messages the platform reported `sent` inside it — scoped to this app id */
  count: number;
  /**
   * WHICH of our messages, by the id it gave us when it accepted them.
   *
   * Authoritative, and it settles something inference cannot. Before this existed the only way to
   * work out which messages a window covered was to ask whether the moment we handed one over
   * could have fallen inside it — and the platform's own held-message behaviour then made that
   * ambiguous: a message QUEUED during an outage and delivered after the phone was re-linked
   * overlaps the window and was never lost. Re-announcing it would post the same Iqamah change to
   * the group twice.
   *
   * Empty when the platform is older than 0.51.1-dev.13 and does not send it.
   */
  ids: string[];
  /** true when the id list hit the platform's 500-per-window cap, so it is incomplete */
  truncated: boolean;
  cause: SuspectCause;
}

export async function whatsappSuspectWindows(): Promise<SuspectWindow[] | null> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return null;
  warnIfCleartextSecret();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp/suspect`, {
      headers: { 'x-openmasjid-app-secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    // NULL, not []. A platform too old to have this endpoint answers 404, and "I could not ask"
    // must not read as "there is nothing wrong" — the caller decides what to do with not knowing,
    // exactly as it does for a message status it could not obtain.
    if (!res.ok) return null;
    const j = (await res.json().catch(() => ({}))) as { ok?: unknown; windows?: unknown };
    // `ok: false` on a 200 body. Belt and braces beside the res.ok check above, and the platform
    // added it because a sibling app was reading {groups: []} on a 429 as "there are no groups" —
    // a success-shaped body on an error is the trap. An ABSENT ok is fine: a platform older than
    // 0.51.1-dev.13 does not send it, and demanding it would break against every one of those.
    if (j.ok === false) return null;
    if (!Array.isArray(j.windows)) return null;
    const out: SuspectWindow[] = [];
    for (const w of j.windows.slice(0, 50)) {
      const o = (w ?? {}) as Record<string, unknown>;
      const from = Number(o.from);
      const to = Number(o.to);
      const count = Number(o.count);
      // Every field re-derived. A window with from > to, or either end absent, would silently
      // match nothing or everything depending on how it were compared — and a window that matches
      // everything would re-announce the masjid's whole history to its group.
      if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to < from) continue;
      // Bounded at the platform's own cap. Ids are opaque strings from us in the first place, but
      // they are compared against our log, and an unbounded list from the network is not something
      // to iterate over however friendly its source.
      const ids = Array.isArray(o.ids)
        ? o.ids.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 500).map((x) => x.trim())
        : [];
      const cause = SUSPECT_CAUSES.includes(o.cause as SuspectCause) ? (o.cause as SuspectCause) : 'unknown';
      out.push({
        from,
        to,
        count: Number.isFinite(count) && count > 0 ? Math.round(count) : 0,
        ids,
        truncated: o.truncated === true,
        cause,
      });
    }
    return out;
  } catch (err) {
    log.debug(`fabric whatsapp suspect lookup failed: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Pull the platform's session token out of the request's Cookie header. */
function omosCookie(req: IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const m = /(?:^|;\s*)omos_session=([^;]+)/.exec(raw);
  if (!m) return null;
  const token = m[1].trim();
  // Only forward a token that looks like a cookie value, so nothing odd can be
  // injected into the outbound Cookie header we send to the platform.
  return /^[A-Za-z0-9._~%+/=-]{1,4096}$/.test(token) ? token : null;
}

interface CacheEntry {
  username: string;
  expires: number;
}
const positiveCache = new Map<string, CacheEntry>();
const CACHE_MS = 45_000;

/**
 * Cap on how often we will call OUT to the platform to validate a session.
 *
 * /api/session is unauthenticated, and /api/setup is permanently reachable under SSO
 * (store.db.admin stays null for the life of the deployment, so its 409 short-circuit
 * never fires). Both call probePlatform. A caller spamming DISTINCT cookie values misses
 * the positive cache every time, so each request used to cause its own outbound fetch:
 * one unauthenticated client could turn this app into a flood generator against
 * OpenMasjidOS while burning an outbound socket here per request, held for up to 4s.
 *
 * 10 probes/second is far above any real panel (which validates once and then rides the
 * 45s positive cache) and far below useful amplification.
 */
const PROBE_BUDGET = 10;
const PROBE_WINDOW_MS = 1000;
let probeWindowStart = 0;
let probesThisWindow = 0;
let throttleWarned = 0;

function takeProbeBudget(): boolean {
  const now = Date.now();
  if (now - probeWindowStart >= PROBE_WINDOW_MS) {
    probeWindowStart = now;
    probesThisWindow = 0;
  }
  if (probesThisWindow >= PROBE_BUDGET) {
    if (now - throttleWarned > 60_000) {
      throttleWarned = now;
      log.warn('throttling outbound platform session checks (more than 10/s) — someone is hammering /api/session');
    }
    return false;
  }
  probesThisWindow += 1;
  return true;
}

/** Short cache for the bare "is the platform up?" probe, which /api/session performs on
 *  EVERY request that carries no platform cookie — i.e. every anonymous visitor. */
let reachCache: { at: number; ok: boolean } | null = null;
const REACH_CACHE_MS = 5_000;
let reachInFlight: Promise<boolean> | null = null;

function nowMs(): number {
  return Date.now();
}

export interface PlatformProbe {
  /** the platform-confirmed username, or null if the visitor isn't signed in there */
  username: string | null;
  /** did we actually REACH the platform? false = not configured, network error, or
   *  timeout. Distinguishes "not signed in" from "OpenMasjidOS is down / wrong
   *  address" so the panel can offer the local-password recovery instead of looping
   *  (a momentarily-unreachable platform must never permanently lock you out). */
  reachable: boolean;
}

/**
 * Probe the platform: validate the omos_session cookie present on THIS request (if
 * any) AND report whether the platform was reachable at all. Only ever validates the
 * cookie actually on the request (never a client-supplied username).
 */
export async function probePlatform(req: IncomingMessage): Promise<PlatformProbe> {
  if (!config.omosBaseUrl || !config.omosAppSecret) return { username: null, reachable: false };
  const token = omosCookie(req);
  if (!token) {
    // No session cookie to validate — still check reachability so the UI can tell
    // "open it from the dashboard" apart from "the platform is unreachable".
    return { username: null, reachable: await platformReachable() };
  }

  const cached = positiveCache.get(token);
  if (cached && cached.expires > nowMs()) return { username: cached.username, reachable: true };

  // Over the outbound budget: answer "platform is up, this visitor is not signed in".
  //
  // The `reachable` value here is load-bearing for SECURITY, not just for UI wording.
  // /api/setup refuses an anonymous local-admin claim only when
  // `probe.reachable && !probe.username`. Returning reachable:false under throttle would
  // therefore let an attacker exhaust the budget and then claim permanent local admin —
  // turning a DoS guard into an authentication bypass. So this fails CLOSED: reachable
  // stays true, no session is granted, and /api/setup still returns 403.
  if (!takeProbeBudget()) return { username: null, reachable: true };

  warnIfCleartextSecret(); // about to send the per-app secret — flag it if cleartext to a public host
  // The timer is cleared in `finally`, not straight after the fetch. `fetch` resolves as soon
  // as the response HEADERS arrive, so disarming it there left the BODY read with no deadline
  // at all — and a platform that sends headers and then stalls would hang this call forever.
  // That is not hypothetical: the announcer holds an in-flight flag across the await, so one
  // stalled body would stop every future Iqamah announcement until the app restarted.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${config.omosBaseUrl}/api/auth/session`, {
      headers: {
        cookie: `omos_session=${token}`,
        // Identity-bound SSO: prove which app is asking. Without this the platform
        // (v0.19+) fails closed. A credential — never logged.
        'x-openmasjid-app-secret': config.omosAppSecret,
      },
      signal: ctrl.signal,
      redirect: 'error', // don't follow a redirect to some other (internal) host
    });
    // Any HTTP response (even non-200 / "not signed in") means the platform is reachable.
    if (res.ok) {
      // `.catch` is not decoration here. This is the ONLY place a parse failure would fall
      // through to the catch below and return reachable:FALSE — and `/api/setup` opens to an
      // anonymous admin claim precisely when the platform is unreachable (CLAUDE.md §4). A
      // platform answering 200 with a non-JSON body (a proxy's HTML error page, a truncated
      // response) would therefore hand out an unauthenticated admin takeover. The comment
      // above says any HTTP response means reachable; this makes the code agree.
      const j = (await res.json().catch(() => ({}))) as { authenticated?: boolean; username?: unknown };
      if (j.authenticated === true) {
        const username = (typeof j.username === 'string' ? j.username : '').trim().slice(0, 64) || 'OpenMasjidOS';
        positiveCache.set(token, { username, expires: nowMs() + CACHE_MS });
        // Keep the cache from growing without bound on a busy panel.
        if (positiveCache.size > 256) {
          for (const [k, v] of positiveCache) if (v.expires <= nowMs()) positiveCache.delete(k);
        }
        return { username, reachable: true };
      }
    }
    return { username: null, reachable: true };
  } catch (err) {
    log.debug(`platform session check failed: ${err instanceof Error ? err.message : err}`);
    return { username: null, reachable: false };
  } finally {
    clearTimeout(t);
  }
}

/** Cheap, unauthenticated "is the platform up?" check, used only when there's no
 *  session cookie to validate. The appearance endpoint is public + CORS-enabled; any
 *  response (even an error status) proves we reached it. */
async function platformReachable(): Promise<boolean> {
  if (!config.omosBaseUrl) return false;
  const now = Date.now();
  if (reachCache && now - reachCache.at < REACH_CACHE_MS) return reachCache.ok;
  // Collapse concurrent callers onto one in-flight probe, so a burst of anonymous
  // requests produces a single outbound call rather than one each.
  if (reachInFlight) return reachInFlight;
  reachInFlight = (async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      // No body is read here, so clearing straight after the fetch is correct.
      await fetch(`${config.omosBaseUrl}/api/public/appearance`, { signal: ctrl.signal, redirect: 'error' });
      clearTimeout(t);
      reachCache = { at: Date.now(), ok: true };
      return true;
    } catch {
      reachCache = { at: Date.now(), ok: false };
      return false;
    } finally {
      reachInFlight = null;
    }
  })();
  return reachInFlight;
}
