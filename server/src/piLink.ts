// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * piLink.ts — the address checking behind "adopt the screen at 192.168.1.30".
 *
 * Two panels now take an address from somebody and act on it, and they are opposite halves of the
 * same feature (docs/PI_ADOPTION.md):
 *
 *   • a Display server's panel is given a **Raspberry Pi's** address and calls it, to hand it the
 *     credentials for a screen it has just created;
 *   • a standalone Pi's panel is given a **display server's** address and writes it into its own
 *     config, so the screen enrols there and shows a code.
 *
 * The second is a string going into a file this process already owns, and `SERVER_ORIGIN_RE` in
 * pi/agentConfig.ts has always been the check for it. The FIRST is different in kind: it makes
 * this server open a connection to wherever an address says, and then post a credential there.
 * That is a request-forgery primitive, and the fact that an admin typed the address is a reason to
 * take it seriously rather than to wave it through — the point of the check is that a mistyped or
 * malicious address cannot turn into "this masjid's screen token was posted to a stranger".
 *
 * So the guard here is on **resolved addresses, not on names**. `pi/lanHost.ts` says of itself
 * that it is "a heuristic about names, not a security check", and it is right: it exists to decide
 * whether `curl` will need `-k`, where guessing wrong costs a needless flag. Deciding whether to
 * post a token somewhere needs the other thing — ask the resolver what the name actually points
 * at, and require every answer to be on a private network.
 *
 * ## Why private-only is not a restriction
 *
 * A server adopting a Pi has to be able to open a connection TO the Pi. A masjid's Pi sits on the
 * masjid's LAN behind NAT, so that only ever works when the server is on that LAN with it. There
 * is no deployment where a public address here would have worked and this refuses it — a display
 * server in the cloud cannot reach a Pi at all, which is exactly why the Pi-side direction exists.
 * Requiring a private address therefore costs nothing real and removes the whole class of
 * "make the server fetch this URL for me".
 *
 * A DNS name that resolves privately is still accepted, because `raspberrypi.local` is how plenty
 * of people reach these boxes. The resolve-then-connect window is a rebinding opportunity in
 * theory; it is bounded by the caller refusing to send anything until the Pi's own panel has
 * accepted an admin password, which a stranger's host cannot do.
 */
import dns from 'node:dns';

/**
 * Where a link request is pointed, after parsing.
 *
 * `origin` is scheme + host + port with no path, which is what both halves of the feature store
 * and send. `hostname` is kept separately because the privacy check is about the host and nothing
 * else, and re-deriving it at the call site is how the two end up disagreeing.
 */
export interface LinkTarget {
  origin: string;
  hostname: string;
}

/**
 * What somebody typed, turned into an origin.
 *
 * Deliberately forgiving about the SHAPE and strict about everything else. An admin reading an
 * address off a sticker types `192.168.1.30`, and refusing that because it has no scheme would be
 * a puzzle with no clue in it — so a bare host gets `http://`, which is what a Pi's panel serves
 * anyway (port 80, no certificate). What is NOT guessed at is the scheme when one is given: a
 * `file:` or `gopher:` URL is a refusal rather than something to coerce.
 *
 * A path is dropped rather than refused. People paste the address bar, and
 * `http://192.168.1.30/settings` means the same screen as `http://192.168.1.30`.
 */
export function parseLinkAddress(raw: unknown): LinkTarget | { error: string } {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { error: 'Enter the address of the screen, for example 192.168.1.30.' };
  if (text.length > 255) return { error: 'That address is too long to be one.' };
  // A space cannot appear in a host or a scheme, and `new URL` would percent-encode it into a
  // path rather than refusing — which would silently accept "192.168.1.30 please".
  if (/\s/.test(text)) return { error: 'An address cannot contain spaces.' };

  // No scheme: assume the one a Pi's panel actually serves. `//host` is treated the same way;
  // it is what a half-pasted URL looks like.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text.replace(/^\/+/, '')}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: 'That does not look like an address. Try something like 192.168.1.30.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'Use a web address — http:// or https://.' };
  }
  if (url.username || url.password) {
    return { error: 'Leave the username and password out of the address; there is a box for the password.' };
  }
  if (!url.hostname) return { error: 'That address has no host in it.' };

  return { origin: url.origin, hostname: url.hostname.replace(/^\[|\]$/g, '') };
}

/**
 * Is this a literal address on a private network?
 *
 * Takes a PARSED address, never a name — a name is whatever a resolver says it is, and this is the
 * question asked about each of those answers. Covers the ranges a masjid's own network is actually
 * built from, including carrier NAT (100.64/10), which is the range Tailscale hands out and so a
 * real way to reach a screen across sites.
 *
 * Link-local is private and answers TRUE here, which is the truthful answer to the question this
 * function asks. It is refused anyway, one level up, for a reason that has nothing to do with
 * privacy — see `resolveLinkTarget`.
 */
export function isPrivateAddress(ip: string): boolean {
  const h = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return false;
    const [a, b] = parts;
    if (a === 10 || a === 127) return true; // private, loopback
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local, and the cloud metadata address
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    return false;
  }

  if (!h.includes(':')) return false; // not an address at all

  /**
   * An IPv4 address wearing an IPv6 hat — the same machine, judged as the v4 address it is.
   *
   * BOTH spellings, which is the part that is easy to miss. `::ffff:192.168.1.30` is how it is
   * usually written, but it is equally `::ffff:c0a8:11e` in hex, and that is what `new URL`
   * normalises a typed literal into — measured, on `http://[::ffff:127.0.0.1]`, which came back
   * as `::ffff:7f00:1` and was judged public.
   *
   * The direction of that mistake is safe (a private address refused, never a public one allowed)
   * but it is not harmless: the admin is told their own screen "is on the public internet", which
   * is both false and impossible to act on.
   */
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mappedDotted) return isPrivateAddress(mappedDotted[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }

  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true; // fe80::/10
  if (/^f[cd]/.test(h)) return true; // fc00::/7 unique-local
  return false;
}

/**
 * Ask the resolver where this host points, insist every answer is on a private network, and come
 * back with the address to actually CONNECT to.
 *
 * `all: true` matters: a name with both a private and a public address would otherwise pass on
 * whichever one came first, and which one that is depends on the resolver's mood. Every address
 * has to be private, because we do not get to choose which one the connection uses.
 *
 * ## Why it returns an address rather than a verdict
 *
 * Checking a NAME and then handing that name to `fetch` resolves it twice, and nothing says the
 * two answers agree. A name whose record is private for the check and public for the connection —
 * DNS rebinding, which costs an attacker a zero-TTL record and nothing else — would walk straight
 * through a check written that way. The consequence here is not abstract: the caller goes on to
 * post a device TOKEN, and a token is a live credential for reading this masjid's timetable and
 * its camera URLs, passwords and all.
 *
 * So the resolved address is what gets connected to, and the name is never resolved a second
 * time. There is no window left to race, which is a different and better thing than a window too
 * small to be worth racing.
 *
 * The cost is one real case: an HTTPS target whose certificate is issued for the NAME would now
 * fail to verify, because the connection is made to the address. A Raspberry Pi's panel is plain
 * HTTP on port 80 — that is what the installer sets up and what the television prints — so this
 * costs nothing that exists. An address typed as a literal is used exactly as typed and never
 * goes near the resolver at all.
 */
export async function resolveLinkTarget(target: LinkTarget): Promise<{ origin: string; display: string } | LinkFailure> {
  const { hostname } = target;
  let found: { address: string }[];
  try {
    found = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return {
      status: 400,
      error: `Nothing on this network answers to "${hostname}". Check the address and that the screen is switched on.`,
    };
  }
  if (!found.length) return { status: 400, error: `Nothing on this network answers to "${hostname}".` };

  const publicOnes = found.filter((a) => !isPrivateAddress(a.address));
  if (publicOnes.length) {
    return {
      status: 400,
      error:
        `"${hostname}" is on the public internet (${publicOnes[0].address}), and this only adopts a screen ` +
        `on your own network. If the screen is somewhere else, set this server's address on the screen itself instead.`,
    };
  }

  /**
   * Link-local is refused separately, and not because it is public — it is as private as an
   * address gets.
   *
   * 169.254.0.0/16 is what a machine gives itself when DHCP fails, so a screen there is not a
   * working screen and adopting one is not a thing anybody is trying to do. It is also where cloud
   * metadata services live (169.254.169.254), which makes it the one private range where "make
   * this server open a connection for me" is worth something to somebody. Costing nothing and
   * removing a probe, it is refused — with its own sentence, because telling an admin that
   * 169.254.169.254 is "on the public internet" would be a lie and an unhelpful one.
   */
  const linkLocal = found.find((a) => /^169\.254\./.test(a.address) || /^fe[89ab]/i.test(a.address));
  if (linkLocal) {
    return {
      status: 400,
      error:
        `${linkLocal.address} is a link-local address — what a machine gives itself when it cannot ` +
        `get one from the network. Give the screen's real address on your network instead.`,
    };
  }

  // Rebuilt around the address that was just checked. An IPv6 literal needs its brackets back;
  // `URL` strips them from `hostname` and refuses to parse without them.
  const picked = found[0].address;
  const literal = picked.includes(':') ? `[${picked}]` : picked;
  const url = new URL(target.origin);
  url.hostname = literal;
  // `display` is what the ADMIN typed. Messages quote that rather than the address it resolved
  // to: being told that "raspberrypi.local" did not answer is actionable, and being told that
  // 10.0.0.5 did not is a puzzle about a number they never saw. For an address typed as a literal
  // — which is almost all of them — the two are the same string.
  return { origin: url.origin, display: target.origin };
}

/**
 * What went wrong, in a sentence an admin can act on, plus the status to answer with.
 *
 * Carried rather than thrown because every one of these is an ordinary outcome of typing an
 * address — a typo, a wrong password, a screen that is switched off — and a thrown error at this
 * boundary becomes a 500, which says "this server is broken" about a situation where it is not.
 */
export interface LinkFailure {
  status: number;
  error: string;
}

/** How long the whole conversation with a screen may take. An admin is watching a spinner. */
export const LINK_TIMEOUT_MS = 12_000;

/**
 * POST to a screen's own panel.
 *
 * `redirect: 'error'` is the same guard every outbound call in this app carries, and here it is
 * load-bearing in a specific way: a redirect is exactly how an address that passed the private
 * check sends us somewhere that would not have. Following one would undo the whole of
 * `resolveLinkTarget`.
 */
function askPi(origin: string, path: string, payload: unknown, signal: AbortSignal, cookie?: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload),
    signal,
    redirect: 'error',
  });
}

/**
 * Sign in to the screen's own panel, and come back with its session.
 *
 * This is the whole authorisation for adopting by address, and it proves two things at once —
 * both of which are needed. That whoever is asking administers that screen, which is the consent;
 * and that the thing at that address is one of OUR panels, which is why no credential of ours is
 * sent until this has succeeded. A stranger's web server cannot produce a 200 with a session
 * cookie from `/api/login` against a password it has never seen.
 */
export async function piPanelSignIn(
  origin: string,
  display: string,
  password: string,
  signal: AbortSignal,
): Promise<{ cookie: string } | LinkFailure> {
  let res: Response;
  try {
    res = await askPi(origin, '/api/login', { password }, signal);
  } catch (e) {
    return {
      status: 502,
      error:
        `Could not reach a screen at ${display} (${e instanceof Error ? e.message : 'no answer'}). ` +
        'Check the address, and that the screen is switched on and set up.',
    };
  }
  if (res.status === 401) return { status: 401, error: 'That password was not accepted by the screen.' };
  if (res.status === 429) {
    return { status: 429, error: 'That screen is refusing sign-ins for a moment after too many tries. Wait, then try again.' };
  }
  if (res.status === 400) {
    return {
      status: 502,
      error: 'That screen has not been set up yet. Open its address in a browser and give it a password first.',
    };
  }
  /**
   * 405 is a screen that ALREADY belongs to a display server.
   *
   * An adopted screen serves `managedPanel.ts`, which answers nothing but GET and HEAD — so the
   * sign-in is refused by the method, before any password is looked at. Worth its own sentence
   * rather than the catch-all below, which would report a wrong password for a screen whose
   * password was never the problem.
   */
  if (res.status === 405) {
    return {
      status: 409,
      error: `The screen at ${display} is already managed by a display server. Forget it there first, or set it free from that server.`,
    };
  }
  if (!res.ok) {
    return { status: 502, error: `The screen at ${display} answered unexpectedly (HTTP ${res.status}). Is that address a screen's panel?` };
  }

  // `set-cookie` can legitimately arrive as several headers. `getSetCookie` keeps them apart,
  // where reading the joined string would splice two cookies into one value that matches neither.
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter(Boolean)
    .join('; ');
  if (!cookie) {
    return { status: 502, error: `The screen at ${display} signed in but issued no session. Is that address a screen's panel?` };
  }
  return { cookie };
}

/**
 * Hand the screen its new identity.
 *
 * Called only after `piPanelSignIn`, and only after the caller has created the device row the
 * credentials belong to. A failure here means that row must be deleted again — see the link route
 * in api.ts — because a token nobody holds is a live credential for a screen that will never
 * appear, sitting in the masjid's own data.
 */
export async function piPanelHandOver(
  origin: string,
  cookie: string,
  payload: { server: string; deviceId: string; deviceSecret: string; token: string },
  signal: AbortSignal,
): Promise<{ ok: true; previousDeviceId: string } | LinkFailure> {
  let res: Response;
  try {
    res = await askPi(origin, '/api/pi/link', payload, signal, cookie);
  } catch (e) {
    return {
      status: 502,
      error: `The screen signed in but then stopped answering (${e instanceof Error ? e.message : 'no answer'}). Nothing was changed.`,
    };
  }
  if (res.ok) {
    // The id this screen is giving up, so its old pending row can go with it. Read defensively:
    // an older screen does not send it, and the body is a device's word for what it used to be
    // called — which is why the caller only ever uses it to drop a row that has no token.
    const body = (await res.json().catch(() => ({}))) as { previousDeviceId?: unknown };
    const previous = typeof body.previousDeviceId === 'string' ? body.previousDeviceId.slice(0, 64) : '';
    return { ok: true, previousDeviceId: previous };
  }
  return {
    status: 502,
    error:
      res.status === 404
        ? 'That screen\'s software is too old to be adopted this way. Update it, or run this server\'s installer on it.'
        : `That screen refused to join (HTTP ${res.status}). Nothing was changed.`,
  };
}
