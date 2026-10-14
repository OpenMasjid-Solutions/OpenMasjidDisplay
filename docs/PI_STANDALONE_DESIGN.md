<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Raspberry Pi screens: standalone, with optional adoption — design

**Status: draft for review. Nothing in this document is built yet.** It is phase 0 of the work:
the decisions, the routing check, and — most importantly — the four places where the brief and
the code disagree. Those are at the top, because three of them change what can be built.

This is a **pre-release (beta)** design. What is deferred is listed at the end.

---

## 0. What the brief asks for that the code cannot do as written

The brief says: *"Where this prompt contradicts the code, say so instead of guessing."* Four
places. The first two are blocking — they need a decision before phase 4 can be designed, let
alone built.

### 0.1 DECIDED (was blocking) — the platform cannot expose "only the pairing route"

The brief requires:

> The tunnel exposes only what must be public: the pairing route (open only during a window)
> and the managed-Pi sync and heartbeat routes. It must never expose the admin control panel,
> the Display API or any other route through the public hostname.

**OpenMasjidOS cannot do this, and no change on our side makes it do this.** Exposure is
per-app and all-or-nothing:

- `packages/core/src/system/ingress.ts:177` routes by **first path segment** to the app's
  `ports[0]`.
- `:431` proxies with `path: req.url` — **the full original path, verbatim**. There is no
  per-sub-path policy and no prefix stripping.
- `:503` is the only filter: an app that is **not** "shared online" (`exposed`) is reachable
  through the tunnel **only** with the platform's per-app access cookie; everyone else gets the
  same plain 404 an unused address gets.
- `:516` additionally refuses `/<app>/fabric/*` over the tunnel, always.

So there are exactly two states:

| Display's "shared online" flag | What the public hostname reaches |
| --- | --- |
| **off** | nothing, without a platform admin cookie — so **a Pi cannot pair** |
| **on** | **every** path under `/<basePath>/`, including `/` (the panel) and `/api/*` |

A Pi on a different network has no platform cookie. For PIN pairing to work at all, Display must
be shared online — and the moment it is, the OS hands the container every public request under
its segment. **The restriction can therefore only be enforced inside Display**, by answering a
plain 404 to everything except the permitted routes.

That is implementable, and the signal is sound in the direction that matters: **every tunnel
request necessarily carries the `/<basePath>` prefix** (the OS routes by first segment and
forwards the path verbatim), so *no prefix ⇒ definitely not the tunnel*. The converse is not
true — a LAN caller can type the prefix — but that is harmless, since a LAN caller already
reaches the panel on the bare path.

**The collision, and the question for Hasan.** Enforcing it as written breaks a shipped feature:
an admin opening Display remotely from the OMOS dashboard arrives at
`https://omos.<domain>/display/` and expects the panel. A blanket 404 under the prefix removes
remote admin access from the product.

Two options, and this is a **stop-and-ask** item under the brief's own list:

- **(a) As written.** Under the prefix, serve only the pairing route (during a window) and the
  managed-Pi sync/heartbeat routes. Everything else — panel, API, widget, volunteer page,
  browser screen — returns a plain 404 on the public hostname. **This removes remote admin
  access, the public widget and the remote volunteer page**, all of which work today.
- **(b) Authenticated-only.** Under the prefix, the pairing route (during a window) and the
  managed-Pi sync routes are served unauthenticated; the panel and API are served **only** to a
  request carrying a valid Display admin session, and an unauthenticated probe of either gets
  the same plain 404 — not a login page, nothing that confirms Display is installed. The widget
  and volunteer page keep working as they do today.

**Decision (Hasan, 2026-10-13): (b), authenticated-only.** A stranger on the internet reaches
nothing but pairing and sync; the panel and the API answer only to a request carrying a valid
Display admin session, and an unauthenticated probe of either gets the same plain 404 as a path
that does not exist — not a login page, and nothing that confirms Display is installed. Remote
admin access, the public widget and the remote volunteer page keep working.

What this obliges phase 4 to build, and to test:

- A single choke point that classifies every request as *under the public prefix* or not, reusing
  `basePathPrefix` (`api.ts:253`) rather than adding a second notion of it.
- Under the prefix: an allow-list of unauthenticated routes — the pairing route **only while a
  window is open**, the managed-Pi sync and heartbeat routes (device token), the widget and the
  volunteer page (unchanged from today). Everything else requires a Display admin session.
- The 404 for a refused route must be **byte-identical** to the 404 for a path that does not
  exist, and must not vary in timing in a way that distinguishes them. A test asserts the two
  responses match, because "returns 404" and "returns an indistinguishable 404" are different
  claims and only the second one is worth anything.
- The brief's acceptance test — *"through the public hostname the admin panel and API are not
  reachable"* — is kept, and reads: not reachable **without a Display admin session**. That is a
  deliberate, recorded widening of the brief's literal words, and it is the only one.

### 0.2 BLOCKING — `/display/adoption` is not a fixed address

`basePath` is the **admin-chosen** app path, not the literal string `display`:
`packages/core/src/apps/manager.ts:1266` — *"the app's own path when one is set, otherwise its
id"*. `docs/REMOTE_ACCESS_INGRESS.md` already says this in bold: **"Read it — don't hardcode
`display`."**

So `https://<public-host>/display/adoption` is the **default** case. A masjid that renamed the
app to `screens` in OMOS → Settings → Remote access pairs at
`https://<public-host>/screens/adoption`.

Design consequence, and it is not optional:

- Display matches the pairing route at **`/adoption` and `/<any-base-prefix>/adoption`**, the
  same way `api.ts:908` already matches `/w/<id>` and `/<appId>/w/<id>`. There is an existing
  helper for the prefix (`basePathPrefix`, `api.ts:253`) — reuse it, do not invent a second one.
- The address **shown to the admin** is built from `GET /api/fabric/site` → `{ publicUrl,
  basePath }`, which `api.ts:1714` already uses for the widget's copy-link. The pairing UI uses
  the same source, so a renamed app shows the right address with no extra work.
- The brief's acceptance criterion naming `https://<public-host>/display/adoption` is kept as
  the default-path case of the test, not as the only one.

**This one I am confident about and will build that way unless you say otherwise** — hardcoding
`display` would silently break every masjid that renamed the path. Flagged because the brief
states the literal path four times.

### 0.3 The source IP shown at confirmation is advisory, not a control

The brief says:

> Behind Cloudflare the source IP must come from the trusted forwarded header
> (`CF-Connecting-IP`), and only when the request really came through the platform proxy, never
> from a header a client can spoof directly.

The platform does exactly that and **says plainly that it is not sufficient**
(`ingress.ts:96`, the OS's own comment):

> *"this listener is also reachable directly (HOST is 0.0.0.0 and 80 is published), and a caller
> arriving that way can simply TYPE `cf-ray` and `cf-connecting-ip` and have both honoured here.
> So an app's X-Forwarded-For is trustworthy against a tunnel visitor and NOT against someone who
> can reach this port. It is a routing signal, never an authorisation one."*

So: against an attacker on the internet, the IP is sound. Against an attacker already on the
masjid's LAN, it is forgeable. The confirmation screen will therefore present it as *"Source
address (as reported)"*, and **nothing will be authorised on the strength of it**. The real
defences stay the PIN, the admin confirmation, and the caps — which is what the brief says
everywhere else. Recorded in `docs/audit/ACTION_REQUIRED.md` when built.

### 0.4 The pairing route must not live under `/fabric/`

`ingress.ts:516` refuses `/<app>/fabric/*` over the tunnel unconditionally — an access token does
not open it either. The pairing endpoint is therefore a **top-level** route (`/adoption`), never
`/fabric/adoption`. Noted because `/fabric/` is otherwise this app's convention for
machine-to-machine traffic, and it is the natural wrong guess.

### 0.5 Smaller contradictions, non-blocking

| # | Brief | Code today | Resolution |
| --- | --- | --- | --- |
| a | "Pi 4 family only… refuse Pi 5, Zero and unknown" | `install.sh:147` compares the generation as a **number** and accepts *"a Pi 5 or a Pi 6"*; `:148` lets **unknown boards through** on purpose | Invert both. See §6. |
| b | Pi 4 / 400 / CM4 must pass | `install.sh:154` is `sed 's/^Raspberry Pi \([0-9]*\).*/\1/'` — **"Raspberry Pi 400" yields `400`**, and "Raspberry Pi Compute Module 4" yields nothing | A numeric `= 4` check would refuse the 400 and the CM4, both of which the brief requires. Match the model string, not a parsed integer. See §6. |
| c | Standalone Pi is the product | `pi/index.ts:6` — *"a Pi 3 B+… a board with 1 GB of RAM"*; `:21` — *"The clock is the server's"* | The agent's stated target and its time source both change. NTP becomes the clock, and the existing "Clock is wrong" guard becomes load-bearing rather than a backstop. |
| d | "The Pi has no inbound path other than the LAN panel" | `pi/index.ts:15` — *"Nothing ever connects **to** it"* | The LAN panel is new inbound surface. The brief permits it; the agent's header comment is now wrong and must be rewritten rather than left to mislead. |

---

## 1. The `/display` routing check (the brief's "do this first")

**Question:** does the container receive `/display/adoption`, or `/adoption` with the prefix
stripped?

**Answer: the full path, prefix intact.** `ingress.ts:431` proxies with `path: req.url`.
Confirmed against the OS source, and it matches `docs/REMOTE_ACCESS_INGRESS.md`, which is this
repo's record of the platform-side fix in OMOS v0.37.0.

Everything else the check was asked to cover:

- **Assets.** An absolute `/assets/…` from a page served at `/display/adoption` is fetched from
  the platform root and 404s. Display already solves this twice — `serveScreenPage` and the
  volunteer page rewrite `="/assets/` to `="<prefix>/assets/` (`api.ts:274`, `:197`). The
  pairing page is server-rendered and needs no bundle, so it sidesteps this entirely.
- **Cookies.** Through the tunnel the OS rebuilds the Cookie header, dropping platform session
  cookies and keeping the app's own (`ingress.ts:82`). Pairing sets no cookie at all.
- **Redirects.** Nothing in the pairing flow redirects. A redirect built without the prefix
  would land on the platform root.
- **WebSocket upgrade.** Handled under the same segment rules (`ingress.ts:527`). The Pi's
  managed-mode sync may stay on HTTP polling, which is what it does today, so no new upgrade
  path is needed.
- **`/fabric/*`** is refused over the tunnel — §0.4.

**Verdict: `/display/adoption` works as written, with §0.2's caveat that the first segment is
whatever the admin chose.**

---

## 2. One web app, capability-gated

### The boundary

One React codebase in `web/`, one build, served by both hosts. No Pi fork of any page or
component. The Pi's panel differs **only** by what a capabilities object turns off.

The capabilities object is served from the **existing** bootstrap endpoint, `GET /api/session`
(`api.ts:980`), which already carries `needsSetup`, `authed`, `hasPassword` and `sso`. It gains:

```jsonc
"capabilities": {
  "host": "server" | "pi",          // who is serving this panel
  "whatsapp": false, "companion": false, "sso": false, "notifications": false,
  "widget": false, "terminal": false, "remoteAccess": false,
  "screens": "fleet" | "self"
}
```

**Built, with one trim (phase 1, `0.71.0-dev.19`).** `mode` and `link` are NOT in the object.
They are facts about one device at one moment — what a managed Pi is called, which server owns
it, whether the link is local or remote — not capabilities, and nothing reads them until the
badge arrives in phase 4. They belong with the device record, and inventing their shape before
anything consumes it is how a contract acquires a field that turns out to be the wrong one.

The web side reads this through a `useCaps()` context (`web/src/capabilities.ts`), mirroring the
existing `useToast` and `usePrefs`, because the consumers are scattered — a settings panel, and a
section of the timetable editor which is opened from two different routes. Its default is
everything-on, so a component rendered outside the provider, or served by a host too old to
answer, behaves exactly as it did before this existed.

Adding a field to an endpoint the app already calls on boot is the smallest change that works:
no new request, no new loading state, no second source of truth.

**Gating rule: absent, never disabled.** A capability that is off removes its nav entry, its
route and its settings block. Nothing renders greyed out, and no layout shifts to accommodate a
missing thing — that is what makes the screenshot test in §2.2 meaningful.

### 2.1 The complete list of intentional differences

Anything not on this list is a bug, and the brief makes adding to it a stop-and-ask item.

| # | Difference | Why |
| --- | --- | --- |
| 1 | WhatsApp, Companion API, SSO, platform notifications and alert destinations, the website widget, the terminal and Remote-access settings are **absent** on a standalone Pi | They are OMOS-only. No webhook, email, Slack or Discord destination exists on a Pi. |
| 2 | Screens page shows exactly one card, "This screen" | Same card component, same status dot, same Default/Scheduled/Manual badge, same "Back to schedule". `capabilities.screens: "self"`. |
| 3 | A **Standalone / Managed · Local / Managed · Remote** pill in the panel header | Not on the TV picture — that is congregation-facing. |
| 4 | Appearance: the server matches the OMOS dashboard theme and wallpaper; the Pi uses the panel's own "set them here" controls | Same controls, same look. The server's extra behaviour is inherited theme, not a different UI. |
| 5 | A **managed** Pi's panel is a read-only status page plus a break-glass login | Not a different design system — the same pages in a read-only state, which the panel already has a pattern for. |

### 2.2 Proving it — the visual-regression harness

Playwright, same fixture data, both builds, every shared page, at desktop (1280) and phone (390)
widths. Fails on any pixel difference beyond tolerance outside the five documented differences.

Three things it must get right or it will be a test that cannot fail:

- **Freeze everything that moves.** The panel has a live wall clock and a live timetable
  preview. Pin the clock and the fixture date, or every run differs from every other run and the
  tolerance gets raised until the test means nothing.
- **Both themes.** Light and dark, since the brief names the design system explicitly.
- **Mask the documented differences by element, not by raising tolerance.** A global tolerance
  large enough to hide the header pill is large enough to hide a broken layout.

**Reordered to phase 2, and the reason is worth keeping.** This is a *differential* test — one
build against another, in the same run, in the same browser — not a test against stored
baselines. That distinction removes the hardest problem in screenshot testing: committed
baselines are machine-specific (this repository vendors two Arabic faces and no Latin one, so
text rasterises differently on Windows and on a CI runner) and would have needed a pinned
container to be stable. Compared pair-by-pair in one run, the platform cancels out and no
baseline is stored at all.

The consequence is that it cannot run until there are two hosts to compare, which is phase 2. A
phase-1 run would compare the server against itself, which is green by construction and proves
only the plumbing. Playwright is a **new dependency** either way — it is in neither
`package.json` today and needs browser binaries in CI.

This is the brief's hardest acceptance criterion and the one most likely to be quietly defanged,
so: the tolerance is per-element masking, never a global threshold, and the clock and fixture
date are frozen.

---

## 3. Shared module boundary

Already shared, today, and it is why this is tractable: the agent imports
`renderDisplaySvg`, `activeAnnouncementImage`, `frostedBackgroundSvg` and `dimsFor` straight from
`../render/svg` (`pi/index.ts:52`). The prayer engine, timetable schema, renderer and schedule
evaluation are **already** host-neutral.

Phase 1 is therefore mostly a **move, not a rewrite**: lift these into a shared area with no
behaviour change, add golden-image tests, and leave every caller working. The risk in phase 1 is
not design, it is accidental behaviour change — hence golden images first.

What stays host-specific: MediaMTX and the RTSP renderer (server only), the framebuffer and
video player (Pi only), the verb spool (Pi only).

---

## 4. Standalone mode

- **Port 80** via systemd `AmbientCapabilities=CAP_NET_BIND_SERVICE`. The agent does not become
  root. (`User=` stays as it is; this is the one capability added.)
- **First run:** a setup code on the TV + the LAN address and `openmasjid-<id>.local`. The code
  proves physical access. The user sets a username and password — scrypt, constant-time compare,
  rate-limited sign-in, signed HTTP-only session cookie. This mirrors the server's existing
  `/api/setup` + `auth.ts`, which is the implementation to reuse rather than re-derive.
- **Clock:** NTP, no RTC. The existing "Clock is wrong" / "Times out of date" behaviour (dim,
  red bar) stays and becomes the primary guard, since there is no longer a server whose clock
  can be borrowed.
- **Updates:** poll GitHub releases a few times a day, apply through the existing root timer,
  roll back if the new version will not start.
- **Alerts: none.** Problems appear on the screen and on the panel's status page. No
  notification surface exists to hide.
- **Offline:** the prayer engine already runs on the device. Assets and fonts are cached
  (`assetCache.ts` exists).

---

## 5. Adoption, connection type, and the threat model

### Local vs Remote — decided by method, not by host

| How | Type |
| --- | --- |
| Admin enters the Pi's IP + username + password in the server panel (flow A) | **Local** |
| PIN pairing through the server's public pairing address (flow B) | **Remote** — even if the host happens to be a LAN address |
| TV setup-code flow (flow C) | **Local**, unless the server address given to the Pi is not private → **Remote** |
| Existing v0.70.x adopted Pis, on migration | Local if the stored server address is private, else Remote |

The server is authoritative. The Pi stores what it is told so the badge is right while offline,
and cannot change it. The type changes only by un-adopting and re-adopting.

**Compatibility mode is Local-only, enforced server-side**: the compatibility-stream endpoints
refuse a Remote Pi's token. Enforcing it only in the UI would be enforcing it nowhere.

### Flow A — adopt by IP: challenge-response, not TLS

The brief asks for either a challenge-response or HTTPS-with-pinned-self-signed-certificate, and
asks which and why.

**Choose challenge-response.** The password never leaves the Pi's panel in any form, there is no
certificate for an admin to eyeball and get wrong, and it does not require the Pi to hold a key
pair or the server to pin anything. Self-signed TLS on the Pi would add a fingerprint the admin
is asked to compare — a step that is routinely clicked through, and which buys nothing here
because the adoption call is one-time and LAN-local. The device token that follows is the
long-lived secret, and it travels once, in the response to an authenticated call.

### Flow B — PIN pairing, and what it is actually defending

The flow is the brief's, unchanged: window → request (Pi sends a hash of a secret it keeps) →
server returns handle + server-generated 8-digit PIN → Pi shows the PIN in **its own panel** →
admin types it into the server → confirmation showing name, model, agent version, source IP and
time → Pi claims the approval **with its request secret**.

**Threat model, stated plainly:**

- **The pairing address is not a secret.** It is public and may be published. Anyone who can
  reach it during an open window can create a pending request. That costs a bounded amount of
  server state and gets them nothing: no config, no token, no masjid name.
- **Real risk 1 — noise / denial of service on the window.** Mitigated by: ~10 minute request
  expiry, caps (5 pending total, 2 per source IP), per-IP and global rate limits with backoff,
  payload size caps, and the window being closable and default-15-minutes. Outside a window the
  route returns **the same plain 404 as a path that does not exist** — not 403, not "closed".
- **Real risk 2 — an admin is phished into typing an attacker's PIN.** This is the one that
  actually matters, because it ends with the attacker holding a device token and the masjid's
  camera addresses (which usually carry passwords). Mitigated by the confirmation step showing
  the Pi's name, model, agent version and source address, and by the warning *"Only enter a PIN
  that is showing on a Pi you control."* **Not fully mitigated** — see "what remains".
- Config is released **only after** PIN confirmation, for exactly that reason.

**What remains, deliberately:**

1. The confirmation details are attacker-chosen except the IP, and the IP is only trustworthy
   against a remote attacker (§0.3). A patient attacker can present a plausible name and model.
   The residual defence is the admin knowing which Pi they are standing in front of.
2. An attacker who can reach the masjid LAN can forge the source address shown.
3. An open window is a 15-minute period in which a stranger who knows the address can consume
   bounded state. We accept this; it is the cost of not having a secret URL, which the brief
   rules out as a non-goal.

**Secrets that must never be logged:** the PIN, the request secret, device tokens. Enforced by a
test that greps the log sink, not by discipline.

### Un-adopt always keeps a copy

Either side, including revocation. The Pi returns to standalone and keeps its last synced config
as ordinary editable local config. **The screen does not blank during the switch** — it keeps
drawing what it was drawing. If it has no local login, it asks for one through the setup-code
flow with the copied config kept. On the server, the Pi leaves the fleet and the timetables stay
in the library. Neither side deletes the other's copy. The connection type is cleared.

---

## 6. The Pi 4 guard

Replaces `install.sh:139-166`. The current check is a numeric generation comparison that accepts
Pi 5 and newer and deliberately lets unknown boards through; both rules invert.

Match the **model string**, because the integer parse is wrong for two of the three boards that
must pass (§0.5b):

| `/proc/device-tree/model` | Verdict |
| --- | --- |
| `Raspberry Pi 4 Model B …` | allow |
| `Raspberry Pi 400 …` | allow |
| `Raspberry Pi Compute Module 4 …` | allow |
| `Raspberry Pi 5 …`, `Raspberry Pi 3 …`, `Raspberry Pi Zero …` | refuse, by name |
| anything else, including unreadable | refuse |

The refusal names the board it found and says what is supported. An **already-installed** Pi 3 is
left alone by a re-run, exactly as the current script promises at `:162` — the guard is on
install, not on the running service, and a working screen in a masjid must not go dark because a
rule changed.

---

## 7. Dual-HDMI mirroring — the honest position

Today the agent writes `/dev/fb0` and nothing else (`framebuffer.ts:49`, `FB_DEVICE`). A recorded
measurement on real hardware says that framebuffer is **16bpp** on a Pi 4.

**I have not tested two connectors, and I will not claim fbdev can mirror them.** Under the Pi 4's
`vc4-kms-v3d` driver, fbcon exposes a single `/dev/fb0` bound to one CRTC; the second HDMI is a
second CRTC that fbdev does not surface. The expected answer is therefore that **fbdev cannot do
it** and the path is DRM/KMS: one rendered image, dumb buffers, one CRTC per connected
connector, each keeping its own negotiated mode with the content scaled and aspect preserved.
Hotplug is a DRM uevent. A single connected output must keep working, and the per-screen
resolution override and its auto-revert must survive.

**This needs a hardware test before it is designed further**, and it is the one phase I would not
start from a laptop. Phase 3 begins with that test; if fbdev surprises me and can mirror, the
smaller change wins.

---

## 8. Legacy RTSP decoders

Nothing is removed, hidden, degraded or deprecated. "Add screen" leads with Raspberry Pi
(recommended) and lists **RTSP decoder (Legacy)** beneath; legacy screens carry a small "Legacy"
label. MediaMTX, the timetable-to-RTSP renderer, on-demand camera and HDMI relay, Direct and
Most-compatible modes, Quick Sync and the decoder-link copy flow all keep working unchanged. A
regression test asserts a legacy decoder screen still renders, publishes and switches content
after every phase. Docs say "fully supported", with no removal date.

---

## 9. Phases

Each phase is its own reviewable commit series and must be green before the next starts.

1. **Shared core + capability-gated web app**, no behaviour change. Golden-image renderer tests
   and the visual-regression harness land here, green on server-vs-server, before anything
   depends on them.
2. **Standalone**: port 80, first-run claim, auth, device panel, storage, GitHub installer,
   self-update, Pi 4 guard.
3. **Dual-HDMI mirroring** — starts with the hardware test in §7.
4. **Adoption**: three flows, the pairing endpoint and its hardening, connection type and badge,
   sync and caching, direct-vs-compatibility rules, un-adopt with copy, migration of v0.70.x Pis.
5. **Server fleet UI** and the Legacy relabelling.
6. **Hardening, docs, real-hardware pass.**

Phases 1–3 do not depend on §0.1 or §0.2. **Phase 4 cannot start until §0.1 is decided.**

## 10. Deferred (say so, do not overpromise)

A flashable disk image; multi-location management; peer syncing between standalone Pis; RTSP
output from the Pi; remote access or tunnels on the Pi; terminal, widget or notifications in
standalone mode; Pi 3, Pi 5 and Zero support.
