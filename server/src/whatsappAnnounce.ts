// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * whatsappAnnounce.ts — post the Iqāmah-change notice to the masjid's WhatsApp group.
 *
 * A masjid announces a change three times now: on the screens (the red band, render/svg.ts),
 * on the poster an admin downloads (render/announce.ts), and here — automatically, to the
 * group the admin approved, some days before it takes effect.
 *
 * ## What this does NOT own
 *
 * The sending. OpenMasjidOS holds the gateway, the key and the linked number, and runs ONE
 * paced queue that every app shares — randomised gaps, typing indicators, per-recipient
 * cooldowns, rolling caps, quiet hours. That queue is the entire defence for the masjid's
 * number against being banned, and it only works because no app can go around it. So this
 * file decides *whether* and *what*, hands it over, and is finished.
 *
 * **Queued is not sent.** Delivery is seconds to minutes away and hours if it lands inside
 * the masjid's quiet hours. Nothing here blocks on it, and nothing anywhere tells an admin a
 * message "was sent" — the log says queued, because that is what we actually know.
 *
 * ## Text, not the poster
 *
 * The platform's Fabric WhatsApp API carries text only — there is no media field on
 * `POST /api/fabric/whatsapp`. The poster PNG therefore cannot go through the masjid's queue,
 * so we send the same notice as text (`announceText`, built from the poster's own model). If
 * the platform grows a media field this becomes a small change here, not a redesign.
 *
 * ## The window, and why a last-minute change needs no special rule
 *
 * The admin picks how many days ahead to post. Every check asks: is there a change between
 * today and `daysBefore` days from now that this group has not been told about? A change
 * added when it is ALREADY inside that window — tomorrow's, or today's — satisfies that on
 * the very next check and goes straight out. There is no separate "urgent" path to get wrong.
 *
 * ## Exactly one automatic post per change
 *
 * The dedupe key is the group plus the change's effective date, read back out of the
 * persisted log — so a restart cannot re-announce something the group already has. Editing a
 * change after it has been announced does NOT re-post: an admin adjusting a time three times
 * would otherwise send three messages and burn the group's hourly allowance. A correction is
 * a deliberate act, and "Send now" is the button for it.
 */
import type { Store } from './store';
import type { DB, Timetable, WhatsAppLogEntry } from './types';
import { findIqamahChange, type NextIqamahChange } from './render/svg';
import { posterModel, announceText } from './render/announce';
import { whatsappSendToGroup } from './fabric';
import { makeLog } from './logger';

const log = makeLog('whatsapp');

/** How often the window is re-checked. A minute is what makes "someone added a change at the
 *  last minute" feel immediate without polling the platform — the check itself is local, and
 *  nothing leaves the box unless there is something new to say. */
export const WA_CHECK_MS = 60_000;

/** How much history the log keeps. It is also the dedupe memory, so it has to outlive a
 *  masjid's change cadence by a wide margin — at a dozen changes a year, this is decades. */
export const WA_LOG_MAX = 200;

/** Give up after this many failed attempts at one change, so a permanent refusal (an
 *  unapproved group, a manifest without `whatsapp: true`) doesn't retry forever and bury the
 *  log. The failures stay visible, which is the point — the admin can see why. */
export const WA_MAX_ATTEMPTS = 5;

/** Wait this long before retrying a failed post. Long enough that a gateway restart or a
 *  rate-limit window passes; short enough that a real change still makes its date. */
export const WA_RETRY_MS = 30 * 60_000;

/** How far to look when an admin presses "Send now" — the same year the poster uses, since
 *  the button exists to send whatever the poster would show. */
const MANUAL_LOOKAHEAD_DAYS = 400;

export interface AnnounceTarget {
  tt: Timetable;
  change: NextIqamahChange;
  /** the change's effective date, "YYYY-MM-DD" — the dedupe key and the log's record */
  effectiveFrom: string;
  groupId: string;
}

export type AnnounceDecision = { act: 'post'; target: AnnounceTarget } | { act: 'skip'; why: string };

const pad2 = (n: number) => String(n).padStart(2, '0');
const dateKey = (c: NextIqamahChange) => `${c.year}-${pad2(c.month)}-${pad2(c.day)}`;

/** The timetable whose changes get announced: the chosen one, else the first. Announcing from
 *  every timetable would send the same change once per screen. */
export function announceTimetable(db: DB): Timetable | null {
  const want = db.settings.whatsapp?.timetableId;
  if (want) return db.timetables.find((t) => t.id === want) ?? null;
  return db.timetables[0] ?? null;
}

/**
 * Should we post right now, and what?
 *
 * Pure over (db, now) so the window and dedupe rules are testable without a platform, a clock
 * or a store. Every "no" carries a reason, because those reasons are what an admin reads when
 * they ask why nothing went out.
 */
export function decideAnnounce(db: DB, nowMs: number, manual = false): AnnounceDecision {
  const wa = db.settings.whatsapp;
  if (!wa) return { act: 'skip', why: 'WhatsApp settings are missing.' };
  if (!manual && !wa.iqamahChange) return { act: 'skip', why: 'Iqamah-change posts are switched off.' };
  if (!wa.groupId) return { act: 'skip', why: 'No WhatsApp group has been chosen.' };

  const tt = announceTimetable(db);
  if (!tt) return { act: 'skip', why: 'There is no timetable to announce.' };
  if (tt.latitude == null || tt.longitude == null) {
    return { act: 'skip', why: 'Add the masjid location to the timetable first.' };
  }

  const now = new Date(nowMs);
  // minDays 0, not 1: a change taking effect TODAY is still worth announcing, and it is the
  // case a last-minute entry lands in. The poster's own detector, reused — there is no second
  // opinion anywhere about what counts as a change.
  const change = manual
    ? findIqamahChange(tt, now, { minDays: 1, maxDays: MANUAL_LOOKAHEAD_DAYS }) ??
      findIqamahChange(tt, now, { minDays: -MANUAL_LOOKAHEAD_DAYS, maxDays: 0, preferLatest: true })
    : findIqamahChange(tt, now, { minDays: 0, maxDays: wa.daysBefore });
  if (!change) {
    return {
      act: 'skip',
      why: manual
        ? 'There are no Iqamah changes to announce.'
        : `No Iqamah change falls in the next ${wa.daysBefore} day${wa.daysBefore === 1 ? '' : 's'}.`,
    };
  }

  const effectiveFrom = dateKey(change);
  const target: AnnounceTarget = { tt, change, effectiveFrom, groupId: wa.groupId };
  // "Send now" is the admin overriding all of this on purpose — including to correct a notice
  // that already went out — so it skips the dedupe and the backoff.
  if (manual) return { act: 'post', target };

  const mine = (db.whatsappLog ?? []).filter(
    (e) => e.event === 'iqamah-change' && e.recipient === wa.groupId && e.effectiveFrom === effectiveFrom,
  );
  if (mine.some((e) => e.outcome === 'queued')) {
    return { act: 'skip', why: 'This change has already been sent to the group.' };
  }
  const failures = mine.filter((e) => e.outcome === 'failed');
  if (failures.length >= WA_MAX_ATTEMPTS) {
    return { act: 'skip', why: `Gave up after ${WA_MAX_ATTEMPTS} failed attempts.` };
  }
  const lastFailedAt = failures.reduce((mx, e) => Math.max(mx, Date.parse(e.at) || 0), 0);
  if (lastFailedAt && nowMs - lastFailedAt < WA_RETRY_MS) {
    return { act: 'skip', why: 'Waiting before retrying the last failed post.' };
  }
  return { act: 'post', target };
}

/** The message a target would produce. Separate so the UI can show a preview of exactly what
 *  would go out, rather than an approximation of it. */
export function announceMessage(target: AnnounceTarget): string {
  return announceText(target.tt, posterModel(target.tt, target.change));
}

export interface AnnounceResult {
  queued: boolean;
  /** why nothing was queued — a plain sentence, safe to show an admin */
  reason?: string;
}

export interface AnnouncerDeps {
  store: Store;
  /** injected so tests never touch the network */
  send?: (group: string, text: string) => Promise<{ queued: boolean; error?: string }>;
  now?: () => number;
}

/**
 * Runs the check on a timer and posts when the window opens.
 *
 * One in-flight post at a time: the tick is a minute apart but a slow platform call could
 * still overlap one, and two ticks agreeing to post the same change before either has written
 * its log entry is the one way the dedupe can be beaten.
 */
export class WhatsAppAnnouncer {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly store: Store;
  private readonly send: (group: string, text: string) => Promise<{ queued: boolean; error?: string }>;
  private readonly now: () => number;

  constructor(deps: AnnouncerDeps) {
    this.store = deps.store;
    this.send = deps.send ?? whatsappSendToGroup;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), WA_CHECK_MS);
    // Don't hold the process open for a notice that can wait for the next boot.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scheduled check. Never throws — a background job that can crash the tick loop would
   *  stop announcing silently, which is the failure nobody would notice. */
  async tick(): Promise<AnnounceResult> {
    if (this.busy) return { queued: false, reason: 'A post is already in flight.' };
    this.busy = true;
    try {
      const d = decideAnnounce(this.store.db, this.now(), false);
      if (d.act === 'skip') return { queued: false, reason: d.why };
      return await this.post(d.target, false);
    } catch (err) {
      log.warn(`Iqamah-change check failed: ${err instanceof Error ? err.message : err}`);
      return { queued: false, reason: 'The check failed.' };
    } finally {
      this.busy = false;
    }
  }

  /** An admin pressing "Send now" — sends whatever the poster would currently show, whether or
   *  not it is in the window and whether or not it has gone out before. */
  async sendNow(): Promise<AnnounceResult> {
    const d = decideAnnounce(this.store.db, this.now(), true);
    if (d.act === 'skip') return { queued: false, reason: d.why };
    return this.post(d.target, true);
  }

  private async post(target: AnnounceTarget, manual: boolean): Promise<AnnounceResult> {
    const text = announceMessage(target);
    const res = await this.send(target.groupId, text);
    this.record({
      at: new Date(this.now()).toISOString(),
      event: 'iqamah-change',
      recipient: target.groupId,
      effectiveFrom: target.effectiveFrom,
      outcome: res.queued ? 'queued' : 'failed',
      ...(res.error ? { error: res.error } : {}),
      ...(manual ? { manual: true } : {}),
    });
    if (res.queued) {
      // The change date, never the message — an app log carrying WhatsApp message text is a
      // rule not worth re-arguing per message.
      log.info(`queued the Iqamah-change notice for ${target.effectiveFrom} to the WhatsApp group`);
    }
    return { queued: res.queued, reason: res.error };
  }

  private record(entry: WhatsAppLogEntry): void {
    this.store.update((db) => {
      const next = [...(db.whatsappLog ?? []), entry];
      db.whatsappLog = next.slice(-WA_LOG_MAX);
    });
  }
}
