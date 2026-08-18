// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * fabricCommands.ts — `POST /fabric/commands/run`, the platform asking us to DO something.
 *
 * Every other Fabric call in this app goes outward: we present our secret to OpenMasjidOS.
 * This one is the reverse — the platform presents *our own* secret back to us and asks us to
 * run a command an admin picked from a WhatsApp menu. It is the only inbound Fabric surface
 * this app has, so the envelope is written once, here, and carefully:
 *
 *  - **Both headers, or nothing.** `X-OpenMasjid-App-Secret` must equal our own
 *    `OPENMASJID_APP_SECRET`, compared in constant time, and `X-OpenMasjid-Caller-App` must be
 *    exactly `omos:platform`. That value can never be an app id — the colon is outside the
 *    app-id charset — so it identifies the platform by construction rather than by a list we
 *    would have to maintain.
 *  - **Exact path, AND no forwarding headers.** Behind the OS tunnel this app is served under
 *    `/<basePath>/…` and the platform does not strip the prefix, so `/display/fabric/commands/run`
 *    matches no route. That alone is not quite enough: the router derives the path with
 *    `new URL()`, which NORMALISES dot segments, so `/display/../fabric/commands/run` collapses
 *    to a match. Hence the second test — the platform builds its request headers from scratch
 *    (`x-openmasjid-app-secret` + `x-openmasjid-caller-app` and nothing else), so a genuine call
 *    never carries `x-forwarded-*`, while anything arriving through the tunnel does. Refusing on
 *    their presence is what makes "LAN-only" a rule rather than an accident of routing.
 *  - **Answer fast.** The platform gives us 10 s and someone is standing there holding a
 *    phone. Everything this does is in-memory plus one debounced store write.
 *  - **Never echo the request back.** The platform strips control characters and clamps our
 *    text to 1000 characters, and never logs our body — we log the command id and nothing else.
 *
 * `commands` must NOT appear in the manifest's `fabric.provides`: that is a reserved capability
 * and would expose this same handler to other apps through the app-to-app broker, which is a
 * different trust boundary sharing a path prefix.
 */
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config';
import { makeLog } from './logger';
import { sendJson } from './httpio';
import type { Store } from './store';
import { IqamahCommand } from './iqamahWizard';

const log = makeLog('commands');

/** The one value the platform identifies itself with. No app id can contain a colon. */
const PLATFORM_CALLER = 'omos:platform';

/** Headers that only an intermediary adds. The platform calls us directly over the LAN and
 *  builds its header set from scratch, so ANY of these means the request was proxied — which
 *  this route must never accept. */
const FORWARDED_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded'] as const;

/** The command ids we declare in manifest.yaml. Anything else is a 404 `unknown_command`,
 *  which the platform turns into "that isn't one of the options". */
export const COMMAND_IDS = ['iqamah-change'] as const;

/** Compare two secrets without leaking their contents through timing. Lengths are compared
 *  first because timingSafeEqual throws on a mismatch — and the length of a secret is not
 *  what an attacker is missing. */
function secretMatches(presented: string | undefined, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export interface CommandDeps {
  store: Store;
  now?: () => number;
}

/**
 * The inbound command handler.
 *
 * Returns true when it took the request, so the API's dispatcher can fall through for
 * anything else. Held as a class because the wizard is stateful across calls.
 */
export class FabricCommands {
  private readonly iqamah: IqamahCommand;

  constructor(deps: CommandDeps) {
    this.iqamah = new IqamahCommand(deps.store, deps.now);
  }

  /** Is this app able to serve commands at all? Without the platform's secret we cannot
   *  authenticate anyone, so the endpoint stays shut rather than open. */
  private get configured(): boolean {
    return !!config.omosAppSecret;
  }

  async handle(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    if (!this.configured) {
      // 503 is the contract's "still starting up" — accurate here too: this app has no secret,
      // so it cannot yet serve commands, and the platform should not treat it as broken.
      return sendJson(res, 503, { ok: false, code: 'not_ready', error: 'This app is not connected to OpenMasjidOS yet.' });
    }
    // Anything proxied has been through an ingress; the platform's own call has not. Checked
    // before the secret so a tunnelled probe never even reaches the comparison.
    if (FORWARDED_HEADERS.some((h) => req.headers[h] !== undefined)) {
      log.warn('refused a commands call that arrived through a proxy — this route is LAN-only');
      return sendJson(res, 403, { ok: false, error: 'Not allowed.' });
    }
    if (!secretMatches(header(req, 'x-openmasjid-app-secret'), config.omosAppSecret) ||
        header(req, 'x-openmasjid-caller-app') !== PLATFORM_CALLER) {
      // Deliberately not "which one was wrong".
      return sendJson(res, 403, { ok: false, error: 'Not allowed.' });
    }

    const command = typeof body.command === 'string' ? body.command : '';
    const text = typeof body.text === 'string' ? body.text : '';
    // Set when this message is an ANSWER to a question we asked last turn. Absent on the
    // first call of an exchange, and on every call from a platform older than 0.51.
    const followUpToken = typeof body.followUpToken === 'string' ? body.followUpToken : undefined;
    if (!(COMMAND_IDS as readonly string[]).includes(command)) {
      return sendJson(res, 404, { ok: false, code: 'unknown_command' });
    }

    // Metadata only. The argument is an admin typing a prayer time, but the rule that inbound
    // command text is never logged is worth keeping unconditional.
    log.info(`running ${command}`);
    try {
      const r = this.iqamah.run(text, followUpToken);
      if (!r.ok) return sendJson(res, 200, { ok: false, error: r.text });
      // `followUp` is what makes the sender's next PLAIN message come back to us — without it
      // they would have to type `!display 1 <answer>` for every step. Omitting it is how a
      // flow ends, so it is present exactly while the wizard still wants an answer.
      return sendJson(res, 200, r.followUpToken ? { ok: true, text: r.text, followUp: { token: r.followUpToken } } : { ok: true, text: r.text });
    } catch (err) {
      log.error(`command ${command} failed`, err);
      // No followUp: a thrown error ends the exchange rather than leaving the admin answering
      // questions into something that is not working.
      return sendJson(res, 200, { ok: false, error: 'Something went wrong running that.' });
    }
  }
}
