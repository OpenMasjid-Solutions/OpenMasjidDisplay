<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# OpenMasjidDisplay — security & code-health audit

| | |
|---|---|
| **Date** | 2026-08-04 |
| **Commit audited** | `c1080cd` (tree identical to `v0.61.0` + the image digest pin) |
| **Scope** | `server/`, `web/`, `Dockerfile`, `docker-compose.yml`, `manifest.yaml`, `.github/workflows/`, full git history |
| **Baseline** | server build clean · 50/50 server tests pass · `web tsc --noEmit` + `vite build` clean |
| **Autonomous push to `main`** | **DISABLED** — see [Pre-flight](#pre-flight) |
| **Findings** | 2 Critical · 1 High · 7 Medium · 9 Low |

> **Read this first.** The single most urgent item is **DISPLAY-001**: any device that can
> reach the control panel port can kill the whole app with one unauthenticated HTTP
> request, no credentials, in a loop. On unattended masjid signage that is a total
> outage of every screen. It is a two-line fix.
>
> The second, **DISPLAY-002**, is the one the Display addendum calls Critical even
> though nothing is exploitable: a screen can go on showing **yesterday's prayer times
> with a frozen clock, indefinitely, while the panel reports it healthy.**

---

## Pre-flight

**Autonomous push to `main` was disabled for this audit.** `.github/workflows/build-image.yml`
fires `on: push: branches: [main]` and runs `docker/build-push-action` with `push: true`,
publishing `ghcr.io/openmasjid-solutions/openmasjiddisplay:<manifest version>` **and
`:latest`** to GHCR. Pushing audit commits to `main` would therefore build and publish a
new production container image that every masjid installs from. Per the audit rules
("*If pushing to `main` triggers a deploy, a device update, an app store submission, or a
published artifact — do not push*"), all work is on the branch
**`audit/security-2026-08-04`** and goes through a pull request for human review.

Other pre-flight facts:

- **Rollback tag** `pre-audit-2026-07-27` → `a32816bf5e3e3576b4a0bcfb400713b12383e98f` (pushed).
- **Baseline CI on `main`** was green before this audit began.
- **`main` protection**: required check `cla`; `enforce_admins: false`; no required reviews.
- **No history was rewritten and nothing was force-pushed** at any point.

---

## What this audit found in one paragraph

The app's *deliberate* security work is genuinely good and I could not break any of it:
the stream-scheme allowlist and array-form `spawn` hold, SVG text is escaped through a
single funnel, upload filenames cannot traverse, SSO is verified server-to-server with
the app secret and `redirect: 'error'`, the `/api/setup` SSO guard from `CLAUDE.md` §4 is
intact, and the timezone/DST handling is careful and correct (see
[What I verified as sound](#what-i-verified-as-sound)). What is missing is defence in the
*seams*: a cookie parser that throws where nothing catches it, a session secret that
fails **open** instead of closed when its file is damaged, a render pipeline with no
liveness or freshness contract, and a release workflow that publishes production images
using mutable third-party action tags while the sibling workflow in the same repository is
correctly SHA-pinned.

---

## Severity scale

| Severity | Meaning here |
|---|---|
| **Critical** | Unauthenticated total loss of service, or the screens silently show wrong prayer times |
| **High** | Authentication can be defeated under a reachable precondition |
| **Medium** | Real weakening of a security boundary, or a supply-chain route into production |
| **Low** | Hardening, hygiene, and long-uptime robustness |

**Confidence** is one of *Confirmed* (I demonstrated it against a running server or the
code path is unambiguous), *Likely*, or *Needs verification*.

---

# Critical

## DISPLAY-001 — Unauthenticated remote crash of the entire app via a malformed cookie

- **Category** denial-of-service / unhandled exception
- **Severity** Critical · **Confidence** Confirmed (live exploit, reproduced)
- **Where** [`server/src/auth.ts:73`](../../server/src/auth.ts#L73), reached from [`server/src/ws.ts:21`](../../server/src/ws.ts#L21) via [`server/src/index.ts:67`](../../server/src/index.ts#L67)
- **Reachable** Yes — **no authentication of any kind required**

`parseCookies` decodes every cookie value eagerly:

```ts
// server/src/auth.ts:67-76
for (const part of header.split(';')) {
  const i = part.indexOf('=');
  if (i < 0) continue;
  out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
}
```

`decodeURIComponent('%')` throws `URIError: URI malformed`. On the HTTP path that is
harmless — the request handler wraps everything in `try/catch` and returns 400. But the
WebSocket upgrade path calls the same code from inside an `'upgrade'` event listener,
where **nothing catches it**:

```ts
// server/src/index.ts:67
hub = new WsHub(server, (req) => hasValidSession(req, store.secret));

// server/src/ws.ts:21 — inside server.on('upgrade', …)
if (!authed(req)) { … }
```

An exception thrown in an `'upgrade'` listener becomes an uncaught exception, and there is
no `process.on('uncaughtException')` handler. The process exits.

**Reproduction** (against a real server on :8791):

```
GET /ws  Upgrade: websocket  Cookie: omd_session=notavalidtoken   ->  HTTP/1.1 401 Unauthorized
GET /ws  Upgrade: websocket  Cookie: omd_session=%                ->  SOCKET ERROR ECONNRESET
GET /healthz (immediately after)                                  ->  DEAD: ECONNREFUSED
```

Server log:

```
URIError: URI malformed
    at decodeURIComponent (<anonymous>)
    at parseCookies (server/src/auth.ts:73:36)
    at hasValidSession (server/src/auth.ts:81:17)
    at <anonymous> (server/src/index.ts:67:36)
    at Server.<anonymous> (server/src/ws.ts:21:12)
    at Server.emit (node:events:509:28)
```

For comparison, the same cookie on the HTTP path is contained:
`GET /api/state` with `Cookie: omd_session=%` → `HTTP 400`, and `/healthz` still returns 200.

**Failure scenario.** A masjid runs the app on their LAN with remote access on. Anyone on
the guest wifi — or anyone on the internet, through the Cloudflare tunnel — sends this
request in a loop. `restart: unless-stopped` brings the container back, and the next
request kills it again. Every screen in the building loses its stream for as long as the
loop runs. Prayer timetables, the Jumu'ah camera feed, all of it. No password is needed
and nothing is logged that names an attacker.

**Aggravating factor.** There is no `HEALTHCHECK` in the image (DISPLAY-019), so Docker's
own recovery is limited to the crash-restart, and the MediaMTX child is torn down and
respawned on each cycle.

**Fix.** Decode defensively in `parseCookies` (fall back to the raw value), and add an
`uncaughtException` guard around the upgrade listener so no future throw in an event
handler can take the process down. Both are small and testable.

---

## DISPLAY-002 — A screen can show stale prayer times forever, and the panel calls it healthy

- **Category** correctness / availability — *silently wrong prayer times*
- **Severity** Critical (per the Display addendum: "*silently displaying stale or wrong times is Critical, not cosmetic*") · **Confidence** Confirmed by code path
- **Where** [`server/src/render/renderPool.ts:79`](../../server/src/render/renderPool.ts#L79), [`server/src/render/renderer.ts:472`](../../server/src/render/renderer.ts#L472), [`server/src/render/renderer.ts:498`](../../server/src/render/renderer.ts#L498), [`server/src/orchestrator.ts:189`](../../server/src/orchestrator.ts#L189)
- **Reachable** Yes — no attacker needed; any render fault triggers it

Three gaps compound into one bad outcome. **There is no freshness or liveness contract
anywhere between the renderer and the screen.** A repo-wide search for
`stale|drift|ntp|lastRender|frameAge|freshness` returns nothing relevant.

**(a) A render request can never time out.** `RenderWorker.request()` creates a promise
that is settled only by a worker `message`, `error`, or `exit`:

```ts
// server/src/render/renderPool.ts:79-87
private request(payload: Record<string, unknown>): Promise<WorkerMsg> {
  if (this.disposed) return Promise.reject(new Error('render worker disposed'));
  const id = ++this.seq;
  const w = this.ensure();
  return new Promise((resolve, reject) => {
    this.pending.set(id, { resolve, reject });
    w.postMessage({ ...payload, id });
  });
}
```

If the worker thread *hangs* rather than crashing — a pathological SVG, a font edge case,
resvg blocking — the promise never settles.

**(b) A never-settled render wedges the pipeline permanently.** The in-flight guard is
only cleared in `.then()`/`.catch()`:

```ts
// server/src/render/renderer.ts:472
if (this.rendering) return false; // a render is still in flight — let it finish
```

So `rendering` stays `true` for the life of the process and **no further frame is ever
rendered for that screen**.

**(c) The write pump has no frame-age guard.** It keeps feeding the last good frame to
ffmpeg at the input frame rate, forever, with no notion of how old it is:

```ts
// server/src/render/renderer.ts:498-509
private writeLatest(): void {
  const s = this.proc?.stdin;
  const img = this.lastFrame;
  if (!s || !s.writable || !img) return;
  …
  s.write(img.pixels);
}
```

**(d) The health signal measures the wrong thing.** `streamReady` is "a decoder is
reading this path", not "the picture is current":

```ts
// server/src/orchestrator.ts:180-189
const st = await getPathState(tv.id);
pulling = !!st && st.readers >= 1;
…
streamReady: pulling,
```

Because ffmpeg is still dutifully publishing duplicated frames, `readers >= 1` stays
true, the panel shows the screen **online**, and the offline alert in `runAlerts()` never
fires.

There is a second, easier route to the same outcome: a render that throws *every* time —
say a background image file that becomes unreadable — is caught and logged at **debug**
level only (`log.debug`, suppressed unless `OMD_DEBUG=1`), leaving `lastFrame` in place:

```ts
// server/src/render/renderer.ts:486-489
.catch((err) => {
  this.rendering = false;
  if (!this.stopped) log.debug(`render ${this.id} failed: …`);
});
```

**Failure scenario.** At 23:58 a render wedges. The TV in the prayer hall keeps showing a
clock reading 23:58 and Tuesday's Iqamah times. Fajr comes and goes; the screen still says
23:58. Nobody gets an alert, the control panel shows a green dot and "online", and the
first anyone knows is a congregant arriving for a jamā'ah that finished twenty minutes
earlier. This is the exact failure the addendum singles out.

**Fix.** Three parts, each independently valuable: a timeout on `request()` that rejects
and recycles the worker; a `renderedAt` stamp with a staleness threshold in `writeLatest()`
plus a visible on-screen indicator once exceeded; and raising a repeated render failure
from `debug` to `warn` and surfacing it in `TvStatus` so the existing Fabric alert path can
carry it.

> The addendum instructs: "*Fix the staleness indicator even if nothing is exploitable.*"

---

# High

## DISPLAY-003 — A damaged `session.secret` fails OPEN: sessions become forgeable

- **Category** authentication bypass
- **Severity** High · **Confidence** Confirmed (forged an admin session against a running server)
- **Where** [`server/src/store.ts:173-187`](../../server/src/store.ts#L173)
- **Reachable** Requires a corrupt/truncated secret file — not directly attacker-triggerable, but plausible in the field

```ts
// server/src/store.ts:173-187
private loadSecret(): Buffer {
  const f = path.join(config.dataDir, 'session.secret');
  try {
    if (fs.existsSync(f)) return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
  } catch { /* regenerate below */ }
  const secret = crypto.randomBytes(32);
  try {
    fs.writeFileSync(f, secret.toString('hex'), { mode: 0o600 });
  } catch (err) { … }
  return secret;
}
```

There is **no length or validity check on the loaded value**. `Buffer.from(s, 'hex')` does
not throw on bad input — it silently decodes as much as it can and returns a **shorter or
empty** buffer. An empty file, a whitespace-only file, or a file truncated mid-write all
yield a zero-length HMAC key, and `crypto.createHmac('sha256', <empty>)` happily signs with
it. The key is then *known to everybody*, so any visitor can mint a valid admin cookie.

**Reproduction.** Truncate `session.secret` to 0 bytes (the app's own file is 64 bytes),
restart, then forge a token with an empty key:

```
forged token (masked): eyJleHAiOjE3ODU4Nz…
GET /api/state with NO cookie      -> 401
GET /api/state with FORGED cookie  -> 200
   >>> ADMIN STATE DISCLOSED: timetables=1, tvs=0, masjid="Our Masjid"
```

Full admin access: repoint every RTSP source, reconfigure or blank every screen, read the
whole configuration.

**Why the precondition is reachable.** The secret is written with a **plain, non-atomic
`writeFileSync`**. The very same file, `db.json`, is written atomically in this same class
because the author knew the hazard:

```ts
// server/src/store.ts:189-193
private persist(db: DB): void {
  const tmp = `${this.file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, this.file);
}
```

A power cut, a full data volume, an OOM kill during first-run write, or a partial
volume/backup restore can therefore leave a short `session.secret` — and the app comes
back up authenticating **anyone**, with no warning in the log.

**Fix.** Require the decoded secret to be ≥32 bytes; otherwise log a warning and generate
a fresh one (which invalidates existing sessions — the correct, fail-closed behaviour).
Write it atomically via tmp+rename like `db.json`.

---

# Medium

## DISPLAY-004 — Production image is published using mutable third-party action tags

- **Category** supply chain · **Severity** Medium · **Confidence** Confirmed
- **Where** [`.github/workflows/build-image.yml:36-58`](../../.github/workflows/build-image.yml#L36)

```yaml
- uses: actions/checkout@v4
- uses: docker/setup-qemu-action@v3
- uses: docker/setup-buildx-action@v3
- uses: docker/login-action@v3
- uses: docker/build-push-action@v6
```

This job holds `packages: write` and publishes the image **every masjid installs**. Git
tags are mutable: whoever controls any of those five action repositories can move a tag to
new code, which then runs inside a job holding a GHCR publish token. That is a direct
supply-chain route into production on every masjid screen.

**This repository already knows the rule.** The sibling workflow is correctly pinned, with
a comment explaining exactly this reasoning:

```yaml
# .github/workflows/cla.yml:37
uses: contributor-assistant/github-action@ca4a40a7d1004f18d9960b404b97e5f30a505a08 # v2.6.1
```

…and `OpenMasjidAPPS/.github/workflows/build-catalog.yml` pins
`actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4` under the note "*a moved
tag on any action used here would be a direct supply-chain route into production*".
`build-image.yml` is the outlier.

**Fix.** Pin all five to full commit SHAs with the version in a trailing comment, matching
the house convention.

## DISPLAY-005 — Admin session cookie is never marked `Secure`, though the panel is served over HTTPS

- **Category** session management / transport · **Severity** Medium · **Confidence** Confirmed
- **Where** [`server/src/auth.ts:18`](../../server/src/auth.ts#L18), [`server/src/auth.ts:86`](../../server/src/auth.ts#L86), [`docker-compose.yml:19-30`](../../docker-compose.yml#L19), [`manifest.yaml:71`](../../manifest.yaml#L71)

```ts
// server/src/auth.ts:18
const SECURE = (process.env.COOKIE_SECURE ?? '').trim().toLowerCase() === 'yes' ? '; Secure' : '';
```

`manifest.yaml` opts into `https: true`, and its own comment says the TLS proxy "*gives the
panel a secure context — needed for clipboard … and **Secure cookies***". But
`docker-compose.yml` never sets `COOKIE_SECURE`, so the flag is off in every deployment and
the 30-day admin cookie is transmitted without `Secure`.

Cookies are not isolated by scheme. The manifest also notes "*The plain HTTP port stays
published as a legacy fallback*" — so the same app answers on both ports, and a cookie set
over HTTPS is sent in cleartext to the HTTP port. Anyone passively watching the masjid LAN
(or a hostile hop) can lift a 30-day admin session, which given DISPLAY-007 cannot be
revoked by changing the password.

**Fix.** Do not flip `COOKIE_SECURE=yes` blindly — `auth.ts` warns correctly that a
`Secure` cookie over plain HTTP would silently lock the admin out of the LAN flow. Instead
mark the cookie `Secure` **per request**, when the request arrived over HTTPS
(`X-Forwarded-Proto`, trustworthy only behind the sanitising OS ingress per `CLAUDE.md` §4,
or a direct TLS socket). Plain-HTTP LAN users keep working exactly as today.

## DISPLAY-006 — Unauthenticated endpoints force an outbound platform request each, with no throttle

- **Category** denial-of-service / amplification · **Severity** Medium · **Confidence** Confirmed
- **Where** [`server/src/api.ts:302-310`](../../server/src/api.ts#L302), [`server/src/api.ts:332-339`](../../server/src/api.ts#L332), [`server/src/fabric.ts:265-276`](../../server/src/fabric.ts#L265)

`GET /api/session` is unauthenticated and, under SSO, calls `probePlatform(req)`. With no
`omos_session` cookie on the request there is **no caching at all** — every call performs a
fresh outbound `fetch` to the platform:

```ts
// server/src/fabric.ts:218-222
if (!token) {
  return { username: null, reachable: await platformReachable() };
}
```

`while true; do curl /api/session; done` therefore turns one unauthenticated client into a
sustained flood against OpenMasjidOS's `/api/public/appearance`, while each in-flight probe
holds an app socket for up to 3 s.

`POST /api/setup` has the same shape and is *permanently* reachable under SSO: the guard
`if (store.db.admin) return 409` never fires because under SSO the admin signs in through
the dashboard and `store.db.admin` stays `null` for the life of the deployment (as
`CLAUDE.md` §4 documents). So the probe at `api.ts:333` is always reached.

This is the same class the Donations app already fixed ("*the pages that talk to
OpenMasjidOS can no longer be flooded by someone on your network*"); Display has not.

**Fix.** Rate-limit unauthenticated `/api/session` and `/api/setup` per IP, and add a
short negative/reachability cache in `fabric.ts` so N requests collapse into one probe.

## DISPLAY-007 — No session revocation: changing the password does not sign other devices out

- **Category** session management · **Severity** Medium · **Confidence** Confirmed
- **Where** [`server/src/auth.ts:42-65`](../../server/src/auth.ts#L42)

Tokens carry only `{ exp, aud }` and are validated purely by HMAC + expiry + audience.
There is no token version, no session id, and no server-side session list, so there is no
way to invalidate an issued token short of deleting `session.secret` (which is undocumented
and also logs the admin out everywhere). Admin sessions last **30 days**.

**Failure scenario.** A volunteer signs in on a borrowed phone. The admin later changes the
password from the office. The borrowed phone keeps full admin access for up to 30 more
days. The Students app shipped a fix for exactly this ("*changing your password now signs
you out on your other devices*"); Display has not.

**Fix.** Add a `tokenVersion` (or a stored secret generation) to `db.admin`, include it in
the token payload, and bump it on password change — invalidating every other session while
re-issuing the current one.

## DISPLAY-008 — Container runs everything as root

- **Category** container hardening · **Severity** Medium · **Confidence** Confirmed
- **Where** [`Dockerfile:33`](../../Dockerfile#L33), [`docker-compose.yml:14-41`](../../docker-compose.yml#L14)

`FROM node:22-slim` and no `USER` directive, so the app, **ffmpeg**, and **MediaMTX** all
run as uid 0. ffmpeg and resvg are large C/C++ attack surfaces that parse untrusted camera
streams and uploaded images; a memory-safety bug in either is root inside the container.
`docker-compose.yml` sets no `security_opt: [no-new-privileges:true]` and no `cap_drop`,
though its header does correctly claim no privileged mode, host networking, devices or
sockets.

**Do not fix this blindly.** Adding `USER node` changes the uid that must own `/data`, and
every existing install has a `data` volume owned by root — a careless change locks masjids
out of their own configuration on upgrade. This needs a deliberate migration
(`chown` on start, or an init step) and real testing on an existing volume.
**Recorded in `ACTION_REQUIRED.md`; not changed by this audit.**

## DISPLAY-009 — Base images pinned by mutable tag, not digest

- **Category** supply chain · **Severity** Medium · **Confidence** Confirmed
- **Where** [`Dockerfile:14`](../../Dockerfile#L14), [`Dockerfile:17`](../../Dockerfile#L17), [`Dockerfile:25`](../../Dockerfile#L25), [`Dockerfile:33`](../../Dockerfile#L33)

```dockerfile
FROM bluenviron/mediamtx:1.19.1 AS mediamtx
FROM --platform=$BUILDPLATFORM node:22-slim AS web
FROM --platform=$BUILDPLATFORM node:22-slim AS server
FROM node:22-slim AS runtime
```

The app's *own* image is digest-pinned in `docker-compose.yml`, but its inputs are not:
`node:22-slim` moves constantly and even `1.19.1` can be re-pushed. Two builds of the same
source can produce materially different images, which undercuts the digest pin downstream.

**Fix.** Append `@sha256:…` to each `FROM`, with the human-readable tag kept in a comment.

## DISPLAY-010 — Every push to `main` overwrites the published version tag and `:latest`

- **Category** release integrity · **Severity** Medium · **Confidence** Confirmed
- **Where** [`.github/workflows/build-image.yml:15-26`](../../.github/workflows/build-image.yml#L15), [`.github/workflows/build-image.yml:57-65`](../../.github/workflows/build-image.yml#L57)

The workflow triggers on **every** push to `main` and derives the tag from
`manifest.yaml`. Any merge that does not bump the version **republishes
`:<same version>`**, so a published tag stops meaning "the bytes we released as that
version". `:latest` is overwritten on every push regardless.

Today the only thing protecting installs is the `@sha256` digest pin in
`docker-compose.yml` — that pin is not a nicety, it is the sole integrity control. Note
this cuts both ways: the digest a rolled-back catalog points at becomes **untagged** after
a rebuild, so it must not be garbage-collected in GHCR.

**Fix.** Publish the version tag only from tag pushes (`refs/tags/v*`); from `main` publish
only a moving tag such as `:edge`. Optionally fail the build if the version tag already
exists in the registry.

---

# Low

## DISPLAY-011 — The login limiter's cleanup can never delete anything (unbounded growth)

- **Category** resource leak / long-uptime stability · **Severity** Low · **Confidence** Confirmed
- **Where** [`server/src/rateLimit.ts:26-29`](../../server/src/rateLimit.ts#L26)

```ts
this.sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, e] of this.map) if (e.lockedUntil < now - 3_600_000 && e.fails === 0) this.map.delete(k);
}, 10 * 60 * 1000);
```

Entries are **only ever created in `fail()`**, which increments `fails` before storing, so
every entry in the map has `fails >= 1`. The predicate `e.fails === 0` is therefore
**never true** and the sweep deletes nothing, ever — defeating its own stated purpose
("*Drop stale entries periodically so the map can't grow unbounded*"). One entry accumulates
per distinct client IP for the process lifetime; over IPv6 that key space is effectively
unbounded. On a masjid box that runs for a year, this is a slow leak.

**Fix.** Evict on inactivity — track `lastSeen` and drop entries idle for an hour
regardless of `fails`.

## DISPLAY-012 — `postcss` ≤ 8.5.22 path traversal (build-time only, not reachable)

- **Category** dependency · **Severity** Low · **Confidence** Confirmed (advisory), **not reachable** in this app
- **Where** `web/package-lock.json` → `vite@6.4.3` → `postcss@8.5.15`

`npm audit` reports 1 high, 0 critical in `web/` and **0 vulnerabilities in `server/`**:

```
postcss  <=8.5.22   Severity: high
  GHSA-r28c-9q8g-f849  Path Traversal in Previous Source Map Auto-Loading (sourceMappingURL)
  GHSA-fxqj-rqcc-2cmp  incomplete fix of GHSA-6g55-p6wh-862q
fix available via `npm audit fix`
```

Both advisory IDs are copied verbatim from the tool — **no CVE has been invented here.**
Exploitation needs attacker-controlled CSS fed to postcss; this app compiles only its own
in-repo stylesheets at build time, and postcss never ships in the runtime image. So the
practical risk is ~nil, but the fix is a one-line override and CI builds are part of the
supply chain.

## DISPLAY-013 — No security response headers on the panel or API

- **Category** hardening · **Severity** Low · **Confidence** Confirmed
- **Where** [`server/src/api.ts:83-87`](../../server/src/api.ts#L83), [`server/src/api.ts:151-156`](../../server/src/api.ts#L151)

Observed against a running server:

```
GET /            -> 200, headers: content-type, Date, Connection, Keep-Alive, Transfer-Encoding
GET /api/state   -> 401, headers: content-type, Date, Connection, Keep-Alive, Transfer-Encoding
```

No `X-Frame-Options` / CSP `frame-ancestors`, no `Referrer-Policy`, no
`X-Content-Type-Options`. Impact is limited — `SameSite=Lax` means a cross-site frame gets
no session cookie, so clickjacking does not reach an authenticated panel — but the app
already demonstrates it knows how to do this properly for uploaded files
(`api.ts:662-667` sets `nosniff` + a `sandbox` CSP) and for the widget
(`frame-ancestors *`, deliberately). The panel simply has nothing.

**Fix.** Send `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
`Content-Security-Policy: frame-ancestors 'self'` on panel and API responses, leaving the
widget's deliberate `frame-ancestors *` alone.

## DISPLAY-014 — No clock sanity check: a wrong host clock yields confidently wrong prayer times

- **Category** correctness · **Severity** Low (raise to High on hardware without an RTC) · **Confidence** Confirmed by absence
- **Where** [`server/src/render/renderer.ts:479`](../../server/src/render/renderer.ts#L479), [`server/src/render/svg.ts:487`](../../server/src/render/svg.ts#L487)

Every prayer time derives from the host clock (`Date.now()` / `new Date()`) and nothing
ever questions it. The timezone maths is careful and correct, but a host whose clock is
wrong — a mini-PC that lost its CMOS battery, a Pi with no RTC that booted without network,
a container on a suspended VM — renders a beautiful, authoritative, wrong timetable. The
display's own confidence is the problem: there is no "times may be wrong" state, only the
"Setup needed" frame for a missing location (`svg.ts:1865`).

**Fix.** Sanity-check the clock (e.g. against the build date and, when the platform is
reachable, its `Date` header) and show a discreet on-screen warning when it looks
implausible. Pairs naturally with the DISPLAY-002 staleness indicator.

## DISPLAY-015 — No automated dependency updates

- **Category** dependency hygiene · **Severity** Low · **Confidence** Confirmed
- **Where** `.github/` contains only `workflows/build-image.yml` and `workflows/cla.yml`

No `dependabot.yml`, so nothing tells the maintainers when a dependency advisory lands. The
allowlist in `cla.yml:51` already lists `dependabot[bot]`, so the intent existed.

**Fix.** Add `.github/dependabot.yml` covering `server/`, `web/`, `docker`, and
`github-actions`.

## DISPLAY-016 — `print?month=` accepts months 00–99 and silently renders a different month

- **Category** input validation · **Severity** Low · **Confidence** Confirmed
- **Where** [`server/src/api.ts:828-832`](../../server/src/api.ts#L828)

```ts
const ym = monthParam ? /^(\d{4})-(\d{2})$/.exec(monthParam) : null;
const year = ym ? Number(ym[1]) : now.year;
const mon = ym ? Number(ym[2]) : now.month;
```

The regex fixes the *shape* but not the *range*. `?month=2026-00` renders December 2025 and
`?month=2026-99` renders a month in 2034 — each labelled with whatever month it landed on.
No crash and no unbounded loop (the day loop is bounded by `daysInMonth`), so this is
cosmetic, but a printed calendar that is confidently the wrong month is a bad artefact to
hand a congregation.

**Fix.** Clamp/reject `mon` outside 1–12 and constrain `year` to a sane window.

## DISPLAY-017 — The public widget is unauthenticated, uncached and unthrottled compute

- **Category** denial-of-service · **Severity** Low · **Confidence** Confirmed
- **Where** [`server/src/api.ts:253-289`](../../server/src/api.ts#L253)

`GET /w/<id>` and `/w/<id>.json` are intentionally public for opted-in timetables. Each
request computes a focus day plus seven days of prayer times and renders a full HTML page,
served `cache-control: no-store`, with no rate limit; the page itself polls every 30 s per
viewer. On a tunnel-exposed instance this is a cheap way to keep the box busy — and it
shares a CPU with the 1 fps render loop that feeds the screens, so widget load can degrade
the actual signage.

Access control itself is sound: a widget that is off returns 404 rather than 403 so ids are
not probeable (`api.ts:256-261`).

**Fix.** A small per-IP limit and a short `cache-control: public, max-age=30` (the payload
already changes at most once a second and the client re-polls anyway).

## DISPLAY-018 — `db.json` holds credential hashes but is written with default permissions

- **Category** hardening · **Severity** Low · **Confidence** Confirmed
- **Where** [`server/src/store.ts:189-193`](../../server/src/store.ts#L189)

`db.json` contains `admin.hash`/`admin.salt` and the volunteer PIN hash, and is written with
no explicit `mode` (so umask decides). The adjacent `session.secret` is deliberately written
`{ mode: 0o600 }` — the intent is clearly there, just not applied to the file that holds the
password hashes.

**Fix.** Write `db.json` (and its tmp file) with `mode: 0o600`.

## DISPLAY-019 — No container `HEALTHCHECK` although `/healthz` exists

- **Category** availability · **Severity** Low · **Confidence** Confirmed
- **Where** [`Dockerfile:86-90`](../../Dockerfile#L86), [`docker-compose.yml:14-41`](../../docker-compose.yml#L14)

The app serves `/healthz` (`api.ts:234`) and neither the image nor the compose file uses it.
For unattended signage that leaves the orchestrator blind to a wedged-but-listening process
— precisely the DISPLAY-002 state, where the port answers and the picture is frozen.

**Fix.** Add a `HEALTHCHECK` hitting `/healthz`, and once DISPLAY-002 lands, make that
endpoint report render freshness rather than merely "the process is up".

---

# What I verified as sound

Recording these matters as much as the findings: several are explicitly named as
non-negotiable invariants in `CLAUDE.md` §4, and a future change must not quietly undo them.

| Area | Verdict | Evidence |
|---|---|---|
| **Stream-scheme allowlist** | **Intact** | `validate.ts:347-356` allows only `rtsp/rtsps/rtmp/rtmps` via `new URL().protocol`; a URL cannot begin with `-`, so ffmpeg argument injection is closed |
| **Array-form `spawn`** | **Intact** | `renderer.ts:207,261`, `mediamtxServer.ts:50` — no string interpolation of a stream URL anywhere; plus `-protocol_whitelist` as defence-in-depth (`renderer.ts:156,183`) |
| **Ticker → ffmpeg `drawtext`** | **Safe** | Text is passed via `textfile=` with `expansion=none` (`renderer.ts:104-106`); only server-generated paths are interpolated, never the message |
| **SVG injection** | **Safe** | Every string reaches the SVG through one `text()` funnel that calls `esc()` (`svg.ts:348-373`); the only `<text>`/`<tspan>` emissions in 2098 lines are there |
| **Upload path traversal** | **Safe** | `safeName()` = `path.basename` + `/^[A-Za-z0-9._-]+$/` (`background.ts:29-32`), applied on every read/write/delete path |
| **Uploaded SVG as active content** | **Mitigated** | Announcement files are served with `nosniff` + `default-src 'none'; … sandbox` (`api.ts:662-667`) |
| **Public widget XSS** | **Safe** | All data rendered via `textContent`; embedded JSON has every `<` replaced by its `<` escape (`widget.ts:102`), so a payload cannot close the `<script>` block; the logo is always a base64 `data:` URI (`background.ts:57`), whose alphabet cannot contain `<` |
| **Print page HTML escaping** | **Safe** | `esc()` applied to masjid name, month, timezone, method, madhab, Jumu'ah (`print.ts:141-239`) |
| **Static file traversal** | **Safe** | `path.resolve` + `startsWith(root + path.sep)` (`api.ts:144-148`); `URL` normalisation means `..` and `%2e%2e` both fail closed |
| **SSO / Fabric** | **Sound** | Server-to-server with the app secret, `redirect: 'error'`, 3–5 s timeouts, `omos_session` pattern-validated before being forwarded, secret never logged (`fabric.ts`) |
| **`/api/setup` SSO guard** (`CLAUDE.md` §4) | **Intact** | `api.ts:332-339` still refuses an anonymous local-admin claim when SSO is configured *and* the platform is reachable |
| **Audience-bound tokens** | **Intact** | `verifyToken(…, aud)` checks `obj.aud === aud` (`auth.ts:50-65`), so a volunteer token cannot be replayed as admin |
| **scrypt + constant-time compare** | **Correct** | `auth.ts:20-34`, length-checked `timingSafeEqual` |
| **Timezone / DST / Hijri** | **Correct** | Every `prayerTimes()` call recomputes `timezoneOffsetHours` for *that* date (`svg.ts:490,497,808,1564`, `print.ts:82`, `iqamahCsv.ts:206`) — no single offset is reused across a month, so DST boundaries are right. Invalid IANA zones fall back instead of throwing (`engine.ts:169-177,196-204`); `zonedNoon` handles UTC+13/+14 (`engine.ts:212-216`). Covered by tests. |
| **`ptCache`** | **Safe** | Function-local (`svg.ts:1559`), so no cross-timetable contamination and no leak |
| **CSRF** | **Adequate** | `SameSite=Lax` is set explicitly on both cookies (`auth.ts:86,104`), so cross-site state-changing requests carry no cookie |
| **Secrets in code/history** | **Clean** | No hardcoded credentials in the tree; history swept with `git log -p --all -S` for 8 secret shapes; the single `AKIA` hit is byte noise inside `NotoNaskhArabic-Regular.ttf`, not a key. No `.env`/`.pem`/`.key` was ever committed. |
| **Web XSS** | **Safe** | No `dangerouslySetInnerHTML`, `innerHTML`, `eval`, or `new Function` anywhere in `web/src` |
| **Volunteer API isolation** | **Sound** | Separate cookie + audience, gated on `enabled()` **and** `authed()`, exposes no admin endpoint (`volunteerApi.ts:177-222`) |
| **Collection caps** | **Present** | `MAX_PER_COLLECTION = 40` prevents pipeline fan-out (`api.ts:209-216`); body sizes capped per endpoint; image uploads byte-sniffed, not extension-trusted (`api.ts:130-135`) |
| **`server/` dependencies** | **Clean** | `npm audit`: 0 vulnerabilities at every severity |

---

## Notes on method

- Every finding was read in the source and, where a claim could be tested, tested against a
  running server (`PORT=8791/8793`, `MEDIAMTX_MANAGED=no`, throwaway `DATA_DIR`). Test
  servers were stopped by PID afterwards; all four ports confirmed clear.
- DISPLAY-001 and DISPLAY-003 were **exploited**, not theorised.
- No secret value is printed anywhere in this report; the forged token appears masked.
- No CVE identifiers were invented. The only advisory IDs quoted (`GHSA-r28c-9q8g-f849`,
  `GHSA-fxqj-rqcc-2cmp`) are reproduced verbatim from `npm audit`.
- Findings whose remediation would change a cross-repo contract, a deployment's data
  ownership, or the release channel are **reported only** and recorded in
  `ACTION_REQUIRED.md`, per the audit rules.
