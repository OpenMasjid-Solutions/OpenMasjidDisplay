// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * pi/claim.ts — the one-time code that lets somebody claim a standalone screen.
 *
 * A Pi running on its own has no display server to be adopted by and nobody to vouch for whoever
 * opens its panel first. The only thing it can ask for is **evidence of being in the room**: a
 * code drawn on the television, typed into the panel on the LAN. Whoever can read it is standing
 * in the masjid, which is the strongest claim this device can check and the same one the
 * enrolment flow already rests on.
 *
 * It is deliberately small. The code is not a password and never becomes one — it is spent once,
 * on creating the admin account, and then it is gone. What stops it being guessed is the
 * combination of eight digits, a LAN-only listener and the sign-in limiter that already guards
 * the password form; none of those three is sufficient alone and the arithmetic is in the tests.
 */
import crypto from 'node:crypto';

/** Eight digits, shown as 4-4. Long enough that guessing it through a rate-limited form is
 *  hopeless, short enough to carry across a hall in somebody's head. */
export const SETUP_CODE_DIGITS = 8;

/**
 * A fresh code.
 *
 * `crypto.randomInt` rather than `Math.random`: this is the only thing standing between a
 * stranger on the masjid's network and the admin account, and a predictable one is no code at
 * all. Uniform over the whole range, leading zeros kept — `00412345` is as valid as any other,
 * and dropping them would both shrink the space and make some codes shorter than the box on the
 * television.
 */
export function newSetupCode(): string {
  return String(crypto.randomInt(0, 10 ** SETUP_CODE_DIGITS)).padStart(SETUP_CODE_DIGITS, '0');
}

/** What somebody typed, reduced to digits. People copy the code off a television with the space
 *  in it, and some will use a dash; none of that should be the reason setup fails. */
export function normaliseSetupCode(given: string): string {
  return String(given ?? '').replace(/\D+/g, '');
}

/** For the television: `1234 5678`, which is markedly easier to carry than eight run together. */
export function formatSetupCode(code: string): string {
  const d = normaliseSetupCode(code);
  return d.length === SETUP_CODE_DIGITS ? `${d.slice(0, 4)} ${d.slice(4)}` : d;
}

/**
 * Does what somebody typed match the code on the television?
 *
 * Compared in constant time, because the alternative leaks the answer a digit at a time to
 * anyone who can measure a response — and on a LAN, with a form that can be driven in a loop,
 * that is a real measurement rather than a theoretical one.
 *
 * The length check before it is not a leak: both lengths are the same public constant, so it
 * tells an attacker only what this file already says out loud. `timingSafeEqual` throws on a
 * length mismatch, so something has to do it.
 */
export function setupCodeMatches(given: string, expected: string): boolean {
  const g = normaliseSetupCode(given);
  const e = normaliseSetupCode(expected);
  if (g.length !== SETUP_CODE_DIGITS || e.length !== SETUP_CODE_DIGITS) return false;
  return crypto.timingSafeEqual(Buffer.from(g, 'utf8'), Buffer.from(e, 'utf8'));
}
