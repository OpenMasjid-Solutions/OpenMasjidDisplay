// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A tiny in-memory failed-attempt limiter for the login endpoints. Keyed by client
 * IP, with exponential backoff after a few failures and a temporary lockout. This is
 * the real defence behind the short admin password / 4-digit volunteer PIN — without
 * it those credentials are trivially brute-forced over the LAN.
 */
import type { IncomingMessage } from 'node:http';

interface Entry {
  fails: number;
  lockedUntil: number;
  /** last time we heard from this client — what eviction is actually based on */
  lastSeen: number;
}

const MAX_FREE = 5; // attempts before backoff kicks in
const BASE_MS = 2000; // first lockout step
const MAX_MS = 5 * 60 * 1000; // cap a single lockout at 5 minutes
const IDLE_MS = 60 * 60 * 1000; // forget a client we haven't seen for an hour

export class LoginLimiter {
  private readonly map = new Map<string, Entry>();
  private readonly sweep: NodeJS.Timeout;

  constructor() {
    this.sweep = setInterval(() => this.prune(), 10 * 60 * 1000);
    this.sweep.unref?.();
  }

  private key(req: IncomingMessage): string {
    return req.socket.remoteAddress || 'unknown';
  }

  /**
   * Forget clients we haven't heard from in a while, so the map can't grow without bound.
   *
   * The previous condition was `e.lockedUntil < now - 3600000 && e.fails === 0`, which
   * could never be satisfied: entries are only ever created in fail(), and fail()
   * increments `fails` BEFORE storing, so every entry has fails >= 1. Nothing was ever
   * evicted and one entry accumulated per distinct client IP for the life of the process —
   * over IPv6 an effectively unbounded key space, on a box that runs for years.
   *
   * Now eviction is based on inactivity, which is the thing that actually makes an entry
   * useless. A client still inside its lockout window is always kept, so pruning can never
   * hand an attacker a fresh allowance.
   *
   * Takes `now` so the behaviour is testable without waiting an hour.
   */
  prune(now = Date.now()): void {
    for (const [k, e] of this.map) {
      if (now - e.lastSeen > IDLE_MS && e.lockedUntil <= now) this.map.delete(k);
    }
  }

  /** How many clients are currently tracked (diagnostics + tests). */
  get tracked(): number {
    return this.map.size;
  }

  /** ms the caller must wait before another attempt (0 = allowed now). */
  retryAfterMs(req: IncomingMessage): number {
    const e = this.map.get(this.key(req));
    if (!e) return 0;
    const now = Date.now();
    e.lastSeen = now; // still knocking — keep tracking them
    const left = e.lockedUntil - now;
    return left > 0 ? left : 0;
  }

  fail(req: IncomingMessage): void {
    const k = this.key(req);
    const now = Date.now();
    const e = this.map.get(k) ?? { fails: 0, lockedUntil: 0, lastSeen: now };
    e.fails += 1;
    e.lastSeen = now;
    if (e.fails > MAX_FREE) {
      const step = Math.min(MAX_MS, BASE_MS * 2 ** (e.fails - MAX_FREE - 1));
      e.lockedUntil = now + step;
    }
    this.map.set(k, e);
  }

  succeed(req: IncomingMessage): void {
    this.map.delete(this.key(req));
  }
}

/**
 * Distinguish real clients on a PUBLIC endpoint.
 *
 * `req.socket.remoteAddress` is the wrong key for anything reached through the
 * OpenMasjidOS remote-access tunnel: every external visitor arrives from the ingress, so
 * they all share ONE bucket and a popular masjid's own website visitors throttle each
 * other. X-Forwarded-For's first hop is the original client and is trustworthy here only
 * because that ingress sanitises the header (CLAUDE.md §4).
 *
 * Spoofable on a DIRECT hit — but the failure direction is benign for a volume cap: a
 * forged value buys an attacker a fresh bucket, which is no better than the extra source
 * addresses they already have, while a shared-bucket false positive would deny real
 * worshippers the prayer times. Never use this for a credential limiter, where the
 * incentives invert — LoginLimiter deliberately keys on the socket for exactly that reason.
 */
function clientKey(req: IncomingMessage): string {
  // Both `headers` and `socket` are optional-chained on purpose: this runs on the public,
  // unauthenticated path, and a throw here would be a 400 (or worse) rather than a limit.
  const xff = String(req.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim();
  return xff || req.socket?.remoteAddress || 'unknown';
}

/**
 * A plain request-rate cap keyed by client, for PUBLIC endpoints where the concern is
 * volume rather than credential guessing (so unlike LoginLimiter there is no backoff and
 * no notion of failure — every request counts).
 *
 * Deliberately generous where it is used: the public widget is meant to be embedded on a
 * masjid's website, and throttling real visitors would be a worse outcome than the load.
 */
export class RequestLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();

  /**
   * @param bySocket key on the SOCKET address instead of X-Forwarded-For. Set it for anything
   *   guarding a credential: there the incentives invert, exactly as the note on `clientKey`
   *   says. A caller rotating a forged X-Forwarded-For would otherwise never be limited at
   *   all, and would mint one Map entry per request while doing it. The widget keeps the
   *   forwarded key, because there a shared bucket would throttle real worshippers.
   */
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly bySocket = false,
  ) {}

  /** True if this request is within budget (and counts it). */
  allow(req: IncomingMessage): boolean {
    const k = this.bySocket ? (req.socket?.remoteAddress ?? 'unknown') : clientKey(req);
    const now = Date.now();
    const e = this.hits.get(k);
    if (!e || now - e.windowStart >= this.windowMs) {
      this.hits.set(k, { count: 1, windowStart: now });
      return true;
    }
    e.count += 1;
    return e.count <= this.max;
  }

  /** Drop windows that have expired — same lesson as LoginLimiter: a cleanup that cannot
   *  actually delete is not cleanup. Takes `now` so it is testable. */
  prune(now = Date.now()): void {
    for (const [k, e] of this.hits) if (now - e.windowStart >= this.windowMs) this.hits.delete(k);
  }

  get tracked(): number {
    return this.hits.size;
  }
}
