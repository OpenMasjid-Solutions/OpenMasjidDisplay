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
 * The sending. OpenMasjidOS holds the gateway, the key and the linked number, and one queue
 * that every app shares. So this file decides *whether* and *what*, hands it over, and is
 * finished.
 *
 * **Queued is not sent, and it is now possible to find out which.** The platform hands back an
 * id and answers what became of it (0.51.1+), so a queued entry is reconciled on the same
 * minute tick and becomes `sent`, `failed` or `expired`. Even `sent` is only "handed to
 * WhatsApp" — there is no delivery receipt anywhere in this chain — and an entry we can never
 * get an answer for stays `queued`, which is the honest record of what we know.
 *
 * **The platform stopped pacing us** (0.51.1): no quiet hours, no caps, no cooldowns, no
 * warm-up, no random gap. It used to refuse to send too much and it does not any more, so what
 * bounds this app is only what is written here — one approved group and never a person, one
 * message per change deduped through the persisted log, five attempts thirty minutes apart, one
 * post in flight. All structural: there is no loop in this file, and a masjid's WhatsApp number
 * cannot be recovered once it is blocked.
 *
 * ## The poster, with text as the fallback
 *
 * When the platform advertises `media` (OpenMasjidOS 0.50.5+) the poster PNG goes as an image
 * with a short caption. The capability is read BEFORE rendering, because rasterising a
 * 1080×1350 poster is real work on a Pi and is wasted on a platform that cannot take one.
 * Every media failure — no capability, a render that threw, over the platform's size cap —
 * falls back to the FULL text notice, never the caption alone: the caption is written to sit
 * under an image, so on its own it is an announcement with no timetable in it.
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
import { posterModel, announceText, announceCaption, type PosterModel } from './render/announce';
import { renderAnnouncePng } from './render/renderPool';
import {
  whatsappSendToGroup,
  whatsappAvailability,
  whatsappMessageStatus,
  whatsappSuspectWindows,
  type SuspectWindow,
  WA_CAPTION_MAX,
  type WhatsAppMedia,
  type WhatsAppAvailability,
  type WhatsAppOutcome,
} from './fabric';
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

/**
 * How long to keep asking the platform what became of a queued message.
 *
 * **This is the platform's retention, and matching it is a correctness requirement rather than
 * a courtesy.** It was half an hour, chosen when the outcome history was 200 records shared
 * between every app and an unasked id was assumed to be evicted quickly. That was wrong in a
 * way that fails silently and permanently:
 *
 * A message the gateway cannot send is eventually marked `expired` by the platform, and
 * `expired` is the verdict that re-opens the retry. Stop asking before it arrives and the entry
 * stays `queued` — which the dedupe reads as *handled*, because a queued message is one still
 * on its way. So a notice that never went out would never be retried and never be sent, and the
 * log would say "waiting" about it for ever. Half an hour was comfortably inside the window in
 * which that could happen.
 *
 * The platform now keeps 500 outcomes per app for 24 hours
 * (`MAX_OUTCOMES_PER_SOURCE` / `OUTCOME_MAX_AGE_MS` in its whatsapp-queue-store), no longer
 * shared, so asking for as long as it will answer costs one request a minute while a single
 * message is outstanding — against a read budget of 600 a minute — and buys the verdict.
 *
 * An entry we still never get an answer for keeps its `queued` outcome, and that is deliberate:
 * "we could not learn" is not "it failed", and inventing a failure would re-announce a change
 * the group may already have.
 *
 * ## Why this is no longer 24 hours
 *
 * It matched the platform's retention exactly, on the reasoning that asking beyond it could only
 * return 404. Then the platform started HOLDING messages when the WhatsApp link is down, released
 * by an admin once they have re-linked the phone — deliberately, so a notice is not dropped while
 * nobody is looking. A message can therefore sit queued for days, and a 24-hour window meant we
 * stopped asking before the answer existed and left the entry `queued` for good. A `queued` entry
 * reads as handled, so that strands the announcement silently, which is the one outcome this whole
 * mechanism exists to prevent.
 *
 * Seven days costs nothing to be wrong about: a 404 in the meantime is "unknown", already handled
 * as such, and asking is five reads a minute against a 600-a-minute read budget.
 */
export const WA_OUTCOME_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** How many outcomes to ask about in one tick, so a backlog cannot become a burst. */
export const WA_OUTCOME_PER_TICK = 5;

/**
 * How often to ask whether the platform still stands behind its own `sent` reports.
 *
 * Hourly. The platform suggested hourly is plenty, the normal answer is an empty array, and it is a
 * read against a 600-a-minute budget rather than anything that costs a send. Asking more often would
 * buy nothing: the window only appears once the platform has NOTICED the link is dead, which takes
 * it about ten minutes, so polling straight after a send would find nothing anyway.
 *
 * Asking less often is the mistake worth naming. The failure this exists for ran for over a day
 * before anyone spotted it, and every notice inside it was recorded as delivered.
 */
export const WA_SUSPECT_MS = 60 * 60_000;

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
  // BOTH of these block a re-announce, and `sent` being in the list is load-bearing rather
  // than tidy. Outcomes used to be only queued-or-failed, so "already handled" and "outcome is
  // queued" were the same test; now that a queued entry can be updated to `sent`, a check for
  // `queued` alone would stop matching the moment the platform confirmed delivery — and the
  // next tick would cheerfully announce the change to the group a second time. Success turning
  // into a duplicate is the exact shape of bug worth spelling out at the site.
  //
  // The one exception is a `sent` the PLATFORM has since disowned — see WhatsAppLogEntry.suspect.
  // There the report of success is the thing that turned out to be wrong, so treating it as handled
  // is what would strand the notice. It rejoins the ordinary paced path from here: nothing about the
  // backoff, the attempt budget or the one-message-per-change rule is bypassed.
  const handled = (e: WhatsAppLogEntry) =>
    e.outcome === 'queued' || (e.outcome === 'sent' && e.suspect !== 'pending');
  if (mine.some(handled)) {
    return { act: 'skip', why: 'This change has already been sent to the group.' };
  }
  // Only the SCHEDULED attempts count against the budget. A "Send now" that failed is an
  // admin retrying by hand, and five of those would otherwise permanently disable the
  // automatic post for that change — punishing the person for trying.
  //
  // `expired` counts as a failure because it is one: the platform gave up on the message. It
  // differs from `failed` only in whose patience ran out.
  const failures = mine.filter((e) => (e.outcome === 'failed' || e.outcome === 'expired') && !e.manual);
  if (failures.length >= WA_MAX_ATTEMPTS) {
    return { act: 'skip', why: `Gave up after ${WA_MAX_ATTEMPTS} failed attempts.` };
  }
  // From when we LEARNED it failed, not from when it was queued. A message accepted at nine and
  // reported failed at half past is a failure at half past; backing off from the earlier time
  // would retry immediately and, if the cause is still there, burn the whole budget in minutes.
  const failedAt = (e: WhatsAppLogEntry) => Date.parse(e.settledAt ?? e.at) || 0;
  const lastFailedAt = failures.reduce((mx, e) => Math.max(mx, failedAt(e)), 0);
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

/** The caption that would ride under the poster, when the platform can carry one. */
export function announceCaptionFor(target: AnnounceTarget): string {
  return fitCaption(announceCaption(posterModel(target.tt, target.change)));
}

/**
 * Cut a caption to the platform's limit without leaving a word in half.
 *
 * The platform refuses an over-long caption at enqueue — while our request is open, so it
 * would surface as a plain failure rather than a silent one. Staying under it ourselves means
 * that never has to happen: ours runs to a couple of hundred characters, and this only exists
 * because a masjid with four changing prayers and very long custom labels could in principle
 * reach it.
 */
export function fitCaption(s: string, max = WA_CAPTION_MAX): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

export interface AnnounceResult {
  queued: boolean;
  /** why nothing was queued — a plain sentence, safe to show an admin */
  reason?: string;
  /** did the poster itself go, or only the text? */
  asImage?: boolean;
}

export interface AnnouncerDeps {
  store: Store;
  /** injected so tests never touch the network */
  send?: (group: string, text: string, media?: WhatsAppMedia) => Promise<{ queued: boolean; id?: string; error?: string }>;
  capability?: () => Promise<WhatsAppAvailability>;
  /** injected so tests never touch the network */
  status?: (id: string) => Promise<WhatsAppOutcome>;
  /** injected so tests never touch the network. null = could not ask, which is not "nothing wrong". */
  suspect?: () => Promise<SuspectWindow[] | null>;
  render?: (tt: Timetable, nowMs: number, model: PosterModel) => Promise<Buffer>;
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
  private readonly send: (group: string, text: string, media?: WhatsAppMedia) => Promise<{ queued: boolean; id?: string; error?: string }>;
  private readonly capability: () => Promise<WhatsAppAvailability>;
  private readonly status: (id: string) => Promise<WhatsAppOutcome>;
  private readonly suspect: () => Promise<SuspectWindow[] | null>;
  /** when the suspect check last ran, so it is hourly rather than every tick. 0 = never, which is
   *  why the first tick after a restart always asks. */
  private suspectAt = 0;
  private readonly render: (tt: Timetable, nowMs: number, model: PosterModel) => Promise<Buffer>;
  private readonly now: () => number;

  constructor(deps: AnnouncerDeps) {
    this.store = deps.store;
    this.send = deps.send ?? whatsappSendToGroup;
    this.capability = deps.capability ?? whatsappAvailability;
    this.status = deps.status ?? whatsappMessageStatus;
    this.suspect = deps.suspect ?? whatsappSuspectWindows;
    this.render = deps.render ?? ((tt, nowMs, model) => renderAnnouncePng(tt, nowMs, model));
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
      // BEFORE deciding, not after: the decision reads outcomes, so it has to read the current
      // ones. This does NOT shortcut the retry backoff — that runs from the verdict — it just means
      // a notice the platform has failed stops looking like one still on its way.
      await this.reconcile();
      // Before deciding, like the reconcile above and for the same reason: this can change whether
      // a notice still counts as handled, and the decision below is what reads that.
      await this.checkSuspect();
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
   *  not it is in the window and whether or not it has gone out before.
   *
   *  Takes the SAME in-flight guard as tick(). It did not, and that was the one way the group
   *  could be told twice: post() writes its dedupe entry only after the send returns, and the
   *  send is a capability fetch, a poster raster and an upload — seconds on a Pi. A tick
   *  starting inside that window read a log with no entry yet, decided the change was
   *  unannounced, and posted it again. */
  async sendNow(): Promise<AnnounceResult> {
    if (this.busy) return { queued: false, reason: 'A post is already in flight — try again in a moment.' };
    this.busy = true;
    try {
      const d = decideAnnounce(this.store.db, this.now(), true);
      if (d.act === 'skip') return { queued: false, reason: d.why };
      return await this.post(d.target, true);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Build the poster, if the platform can carry one.
   *
   * The capability is read BEFORE rendering, deliberately: rasterising a 1080×1350 poster is
   * real work on a Pi, and on a platform that cannot take an image it would all be thrown
   * away. Every failure here returns null and the notice goes as text — an announcement that
   * arrives as words beats one that does not arrive.
   */
  private async poster(target: AnnounceTarget, model: PosterModel): Promise<WhatsAppMedia | null> {
    const cap = await this.capability();
    if (!cap.media) return null;
    let png: Buffer;
    try {
      png = await this.render(target.tt, this.now(), model);
    } catch (err) {
      log.warn(`could not render the Iqamah-change poster, sending it as text: ${err instanceof Error ? err.message : err}`);
      return null;
    }
    // The platform's cap, read from the platform. A poster is 150–400 KB against their 2 MB,
    // so this is a guard rather than a live constraint — but a masjid with a huge logo could
    // reach it, and a refusal after the upload is a worse answer than text.
    if (cap.maxMediaBytes > 0 && png.byteLength > cap.maxMediaBytes) {
      log.warn(`the Iqamah-change poster is ${png.byteLength} bytes, over the platform's ${cap.maxMediaBytes} — sending it as text instead`);
      return null;
    }
    return { data: png.toString('base64'), mimeType: 'image/png', filename: `iqamah-change-${target.effectiveFrom}.png` };
  }

  /**
   * Ask the platform what became of the messages we are still waiting on.
   *
   * Only worth anything on a platform that answers (`outcomes`, OpenMasjidOS 0.51.1+), so the
   * capability is checked first and only when there is actually something to ask about — a
   * masjid with nothing outstanding makes no request at all.
   *
   * Never throws, and never invents a verdict: `state: null` means we could not learn one, and
   * the entry is left exactly as it was. An unreachable platform must not be able to turn a
   * delivered notice into a "failed" one, because the consequence of that mistake is announcing
   * the same change to the group twice.
   */
  private async reconcile(): Promise<void> {
    const now = this.now();
    const waiting = (this.store.db.whatsappLog ?? [])
      .filter((e) => e.outcome === 'queued' && !!e.id && now - (Date.parse(e.at) || 0) < WA_OUTCOME_WINDOW_MS)
      // Sorted rather than relying on the log's append order. It happens to hold today, and "oldest
      // first" silently meaning "whatever order the array is in" is the kind of assumption that
      // stops being true the first time anything reorders the log.
      .sort((x, y) => (Date.parse(x.at) || 0) - (Date.parse(y.at) || 0));
    if (!waiting.length) return;
    try {
      const cap = await this.capability();
      if (!cap.outcomes) return;
      // OLDEST first. It was `slice(-N)` — the newest five — which starves the rest whenever more
      // than five are outstanding: the oldest would never be asked about, would fall out of the
      // window, and would keep `queued` for good. Barely reachable when a queue drained in
      // seconds; entirely reachable now that messages are held while a phone is unlinked, which is
      // exactly when a backlog builds. Oldest first also puts the ones closest to expiring first,
      // and each one settled leaves the waiting set, so the next tick moves along.
      for (const entry of waiting.slice(0, WA_OUTCOME_PER_TICK)) {
        const res = await this.status(entry.id as string);
        if (!res.state || res.state === 'queued') continue;
        this.settle(entry, res.state, res.reason);
        if (res.state === 'sent') {
          log.info(`the WhatsApp group has the Iqamah-change notice for ${entry.effectiveFrom}`);
        } else {
          // Worth a warning: this is the case that used to be invisible — accepted, never
          // delivered, and nothing anywhere able to say so.
          log.warn(
            `the Iqamah-change notice for ${entry.effectiveFrom} ${res.state === 'expired' ? 'expired before it could be sent' : 'failed to send'}${res.reason ? `: ${res.reason}` : ''}`,
          );
        }
      }
    } catch (err) {
      log.debug(`could not reconcile WhatsApp outcomes: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Write the platform's verdict onto the entry it belongs to.
   *
   *  Matched on the id rather than the array index: the log is re-read from the store here, and
   *  a post written between the read and this write would have shifted the positions. */
  private settle(entry: WhatsAppLogEntry, state: 'sent' | 'failed' | 'expired', reason?: string): void {
    const at = new Date(this.now()).toISOString();
    this.store.update((db) => {
      db.whatsappLog = (db.whatsappLog ?? []).map((e) =>
        e.id && e.id === entry.id
          ? { ...e, outcome: state, settledAt: at, ...(reason ? { error: reason } : {}) }
          : e,
      );
    });
  }

  private async post(target: AnnounceTarget, manual: boolean): Promise<AnnounceResult> {
    const model = posterModel(target.tt, target.change);
    const media = await this.poster(target, model);
    // With the poster attached the caption is short — the image carries the timetable, and
    // repeating it underneath is a wall of text. Without it, the full notice IS the message.
    const text = media ? fitCaption(announceCaption(model)) : announceText(target.tt, model);
    const res = await this.send(target.groupId, text, media ?? undefined);
    this.record({
      at: new Date(this.now()).toISOString(),
      event: 'iqamah-change',
      recipient: target.groupId,
      effectiveFrom: target.effectiveFrom,
      outcome: res.queued ? 'queued' : 'failed',
      ...(res.id ? { id: res.id } : {}),
      ...(media ? { asImage: true } : {}),
      ...(res.error ? { error: res.error } : {}),
      ...(manual ? { manual: true } : {}),
    });
    if (res.queued) {
      // The change date and the format, never the message — an app log carrying WhatsApp
      // message text is a rule not worth re-arguing per message.
      log.info(`queued the Iqamah-change notice for ${target.effectiveFrom} to the WhatsApp group (${media ? 'poster' : 'text'})`);
    }
    return { queued: res.queued, reason: res.error, asImage: !!media };
  }

  private record(entry: WhatsAppLogEntry): void {
    this.store.update((db) => {
      // Any suspect entry for this same change has now been dealt with, and this is the only place
      // that can honestly say so: a new message for it exists. Without this the suspect entry stays
      // 'pending', keeps reading as not-handled, and re-announces the change on every pass.
      for (const e of db.whatsappLog ?? []) {
        if (
          e.suspect === 'pending' &&
          e.event === entry.event &&
          e.recipient === entry.recipient &&
          e.effectiveFrom === entry.effectiveFrom
        ) {
          e.suspect = 'resent';
        }
      }
      const next = [...(db.whatsappLog ?? []), entry];
      db.whatsappLog = next.slice(-WA_LOG_MAX);
    });
  }

  /**
   * Ask the platform whether any of its own `sent` reports have turned out to be untrustworthy, and
   * decide what to do about ours.
   *
   * Hourly, and on the first tick after a restart. It is a read against a 600-a-minute budget and
   * the normal answer is an empty array, so there is no case for asking more often — and no case for
   * asking less: the whole failure this addresses went unnoticed for over a day.
   *
   * Nothing is SENT from here. The decision this makes is only "does the existing dedupe still count
   * that message as handled", so a re-send goes out through the ordinary paced path — one message per
   * change, the same backoff, the same attempt budget — and a masjid with several suspect notices
   * does not produce a burst on a number that has just been re-linked and is being watched hardest.
   */
  private async checkSuspect(): Promise<void> {
    const now = this.now();
    if (this.suspectAt && now - this.suspectAt < WA_SUSPECT_MS) return;
    // Stamped BEFORE the request, not after: a platform that times out would otherwise be re-asked
    // on every tick for as long as it kept timing out.
    this.suspectAt = now;
    const windows = await this.suspect();
    // null is "could not ask" — an older platform, a timeout, a 404. Not "nothing is wrong", and
    // the difference matters here for the same reason it does for a message status.
    if (!windows?.length) return;
    // Marked ONCE, inside the update, and the counts come back out through a captured variable.
    //
    // This used to call markSuspectEntries twice: once on `this.store.db` to get the counts, then
    // again inside store.update to "apply" them. Those are the same array of the same objects, so the
    // first call was already the mutation — outside store.update, where nothing schedules a save or
    // notifies a listener — and the second was a no-op that happened to schedule the save the first
    // one needed. It worked by accident, and in a way that breaks if anyone removes the call that
    // returns a value nobody reads.
    //
    // Worth getting right rather than leaving: the platform retains a window for seven days after the
    // outage ends and re-reports it UNCHANGED — everything about it is snapshotted at detection — so
    // this path now runs against the same window roughly 170 times. Which is fine, because marking
    // is idempotent: an entry that already carries a verdict is skipped.
    let marked = { pending: 0, stale: 0 };
    this.store.update((db) => {
      marked = markSuspectEntries(db.whatsappLog ?? [], windows, now);
    });
    if (!marked.pending && !marked.stale) return;
    if (marked.pending) {
      log.warn(
        `the platform can no longer vouch for ${marked.pending} Iqamah-change notice(s) it reported as sent; ` +
          'they will be announced again on the usual schedule',
      );
    }
    if (marked.stale) {
      log.warn(
        `${marked.stale} Iqamah-change notice(s) the platform can no longer vouch for announced a change ` +
          'that has since taken effect; not re-sending those, because the wording would now be wrong',
      );
    }
  }
}

/**
 * How long after a window closes we will still believe a `sent` we learned about fell inside it.
 *
 * Only used when the platform does not name the messages. We poll for verdicts once a minute, five
 * at a time, so learning about a genuinely lost message lags the platform's report by a minute or
 * two — and a backlog can stretch that. Ten minutes is generous for the lag and still far short of
 * the case this exists to exclude, which is a message HELD for hours or days and then delivered
 * perfectly well after the phone was re-linked.
 */
const SUSPECT_LEARN_SLACK_MS = 10 * 60_000;

/**
 * Mark the log entries a suspect window covers, and say how many of each kind.
 *
 * Exported and pure so the decision can be tested without a platform: what counts as "covered" is
 * the part worth being exact about, and there are now two ways to decide it.
 *
 * ## By id, when the platform names them
 *
 * `ids` is authoritative and settles something inference cannot. The platform holds messages while
 * the WhatsApp link is down and releases them once an admin re-links the phone — so a message
 * QUEUED during an outage can be delivered, properly, after it. That message overlaps the window on
 * any interval test and was never lost, and re-announcing it posts the same Iqamah change to the
 * group twice. Only the platform knows which messages it actually reported sent while the link was
 * dead, and now it says so.
 *
 * ## By overlap, when it does not
 *
 * Older platforms send no ids, and a truncated list is incomplete by definition. Then we fall back
 * to asking whether the hand-off COULD have fallen inside the window: it is somewhere between our
 * queueing the message and our learning it was sent, so the test is an interval overlap rather than
 * a point test on either end — a point test on `at` would miss a message queued just before the link
 * died, which is the likeliest one of all to have been lost.
 *
 * With one bound added for the held case above: if we did not learn the verdict until well after the
 * window closed, the platform's report was after it too. That is a heuristic, and it is why the id
 * list is preferred wherever it exists.
 */
export function markSuspectEntries(
  entries: WhatsAppLogEntry[],
  windows: { from: number; to: number; ids?: string[]; truncated?: boolean; cause?: string }[],
  nowMs: number,
): { pending: number; stale: number } {
  let pending = 0;
  let stale = 0;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  for (const e of entries) {
    // Only ever a `sent` we have not already judged. A queued entry is still going to get a real
    // verdict, and a failed one is already being retried by the ordinary path.
    if (e.outcome !== 'sent' || e.suspect) continue;
    const queuedAt = Date.parse(e.at) || 0;
    if (!queuedAt) continue;
    const learnedAt = Date.parse(e.settledAt ?? e.at) || queuedAt;
    let hit: { cause?: string } | null = null;
    for (const w of windows) {
      const named = !!e.id && (w.ids?.includes(e.id) ?? false);
      if (named) {
        hit = w;
        break;
      }
      // The list is authoritative when it is complete: a message the platform did NOT name is a
      // message it did not lose, and guessing otherwise is what duplicates an announcement.
      if (w.ids?.length && !w.truncated) continue;
      if (queuedAt <= w.to && learnedAt >= w.from && learnedAt <= w.to + SUSPECT_LEARN_SLACK_MS) {
        hit = w;
        break;
      }
    }
    if (!hit) continue;
    if (hit.cause) e.suspectCause = hit.cause.slice(0, 32);
    // The domain call, and the only one the platform explicitly said it cannot make for us. An
    // Iqamah-change notice that has not taken effect yet still has a job to do, and somebody turning
    // up at the wrong time is the cost of not re-sending it. One that has already taken effect does
    // not: "from Friday, Asr will be at 5:30" read after Friday is not a correction.
    if (e.effectiveFrom >= today) {
      e.suspect = 'pending';
      pending++;
    } else {
      e.suspect = 'stale';
      stale++;
    }
  }
  return { pending, stale };
}
