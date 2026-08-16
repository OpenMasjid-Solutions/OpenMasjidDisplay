<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# How to use the OpenMasjidOS Fabric (Display)

The **Fabric** is the platform↔app integration layer. Everything is **optional + backwards-
compatible**: without the platform, Display runs fully standalone (own login + appearance). The
canonical spec is OpenMasjidAPPS `docs/BUILDING_AN_APP.md` §7.

**Wire identifiers (never rename):** env `OPENMASJID_BASE_URL`, `OPENMASJID_APP_ID`,
`OPENMASJID_APP_SECRET`; header `X-OpenMasjid-App-Secret`; cookie `omos_session`.
**Golden rule:** read those env vars **every process start**; never persist them (or anything fetched
from the Fabric) to the data volume — the platform changes them across restarts/migrations.

## What Display uses today

```yaml
# manifest.yaml
sso: true            # sign in with the dashboard login
notifications: true  # alert the masjid when a screen goes offline/online
domain: true         # learn our PUBLIC url behind the admin's tunnel (widget + volunteer links)
https: true          # serve the control panel through the platform's TLS proxy
whatsapp: true       # post the Iqamah-change notice to a group the admin approved
commands:            # things an admin can run by messaging the masjid's number (!display)
```

### 1. Single sign-on (implemented — keep it)

Forward the request's `omos_session` cookie to `${OPENMASJID_BASE_URL}/api/auth/session` with the app
secret; a `true` mints a local admin session (`server/src/fabric.ts`).

Two things there are load-bearing and must not be simplified away:

- **Never brick when the platform is unreachable.** `probePlatform()` reports *reachable* separately
  from *signed in*, so a momentary outage falls back to the local recovery password instead of locking
  the panel (the restore/migration bug — [`RESTORE_SSO_FIX.md`](RESTORE_SSO_FIX.md), now fixed).
- **But the recovery password is only offered while the platform is DOWN.** While it is reachable,
  `POST /api/setup` refuses an anonymous claim, because under SSO no local password is ever set and an
  unconditionally open setup endpoint is an unauthenticated admin takeover.

### 2. Appearance (implemented — keep it)

Match the dashboard's theme/wallpaper via the `#omos=` hash + `GET /api/public/appearance`
(`web/src/prefs.ts`).

### 3. Notifications (implemented — keep it)

Relay screen offline/online alerts: `POST ${OPENMASJID_BASE_URL}/api/fabric/notify` with the app
secret + `{ text, title?, level? }`. Fails soft.

### 4. Public URL / remote access (implemented — keep it)

`GET ${OPENMASJID_BASE_URL}/api/fabric/site` with the app secret tells us our public address behind the
admin's Cloudflare tunnel, so the **website-widget embed code** and the **volunteer page link** can point
somewhere that works off-site:

```
GET ${OPENMASJID_BASE_URL}/api/fabric/site
  X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>
→ { "enabled": true, "domain": "omos.example.org",
    "publicUrl": "https://omos.example.org/display", "basePath": "/display" }
```

Two rules:

- **Read `basePath`; never hardcode `display`.** The admin can rename it.
- **Be base-path aware.** The platform serves apps path-based under one `omos` subdomain and does **not**
  strip the prefix, so routes and assets must match both the LAN form (`/w/:id`) and the tunnelled form
  (`/<basePath>/w/:id`). Display already does — see `api.ts`'s widget and volunteer route patterns.

Treat the answer as authoritative and fail soft: the platform only returns a `publicUrl` when it is
actually routing this app's path, and no Fabric / tunnel off / any error simply means "use the LAN link".

### 5. HTTPS for the panel (implemented — keep it)

`https: true` puts the platform's TLS proxy in front of the **first** published port, which is what gives
the panel a secure context (clipboard for the embed code, `Secure` cookies). The plain HTTP port stays
published as a legacy fallback, and the volunteer port is deliberately not proxied. That dual-scheme
setup is exactly why the session cookies use **separate names** for their `Secure` variants — see the
comment in `server/src/auth.ts` before changing anything there.

### 6. WhatsApp (implemented — keep it)

`whatsapp: true` lets the app post the **Iqāmah-change notice** to a group the OpenMasjidOS admin
approved. Three calls, all server→server with the app secret, all failing soft
(`server/src/fabric.ts`):

```
GET  ${OPENMASJID_BASE_URL}/api/fabric/whatsapp         → { available, reason, media, maxMediaBytes }
GET  ${OPENMASJID_BASE_URL}/api/fabric/whatsapp/groups  → { groups: [{ id, label }] }
POST ${OPENMASJID_BASE_URL}/api/fabric/whatsapp         → 202 { queued: true }
     { "group": "…@g.us", "text": "…",
       "media": { "data": "<base64>", "mimeType": "image/png", "filename": "…" } }
```

The rules that are not ours to bend:

- **We never touch the gateway.** No URL, no API key, no session, no idea which number is linked.
  The platform runs **one paced queue** shared by every installed app — randomised gaps, typing
  indicators, per-recipient cooldowns, rolling caps, quiet hours — because ban risk attaches to the
  masjid's *number*, not to whichever app had something to say. It only works because no app can go
  around it.
- **`queued` is not `sent`.** Delivery is seconds to minutes away and hours inside quiet hours. There
  is no delivery receipt. Nothing here blocks on it and nothing tells an admin a message arrived.
- **Nothing auth-critical, ever.** No login codes, no password resets, no OTPs — WhatsApp is an
  unofficial client and the number can be restricted overnight. Those go by email.
- **Ask before offering the feature.** `reason` is one of `ready` / `not-configured` / `not-linked` /
  `unreachable`, each needing a different sentence; we add `not-allowed` (the platform's 403) and
  `no-fabric` (running standalone). Without this, the switch looks available on every install and
  fails only when a real announcement was due.
- **Only approved groups.** The list holds nothing but what the admin put in front of us, approval
  can be withdrawn at any time, and an empty list means hide the feature rather than error. An id we
  were not given is refused with a 403.
- **Never log a message body.** The log we keep is event + group id + timestamp + the change's date.

**The poster goes as an image, when the platform can carry one** (OpenMasjidOS 0.50.5+). Three rules
here, each of which was a bug waiting to happen:

- **Read `media` before rendering.** Rasterising a 1080×1350 poster is real work on a Pi, and on an
  older platform every byte of it is thrown away. An absent `media` field MUST read as `false`.
- **Read `maxMediaBytes`; never hardcode it.** It is the platform's number to change (2 MB today; a
  poster is 150–400 KB). Over it, we fall back to text rather than eat a refusal after the upload.
- **Never degrade to the caption alone.** The caption is written to sit *under* an image — it names
  what moved and nothing else — so posting it by itself would be an announcement with no timetable in
  it. Every media failure (no capability, render threw, over the cap) falls back to the **full**
  `announceText`, and a test pins that.

Both forms are built from the poster's own `PosterModel`, so image and text cannot disagree about
times or tense. `renderPool.announce()` takes that model rather than re-detecting: its own rule is the
download button's ("next change, else the most recent past one"), which **skips a change taking effect
today** — exactly the case the announcer exists to catch.

A 202 still is not delivery, and now less so: the platform validates mime, size, caption length and its
queue depth while our request is open, but a gateway-side failure lands in *its* log, not our response.
Nothing here reports a poster as published.

Which event goes out, to whom, and how early is **our** setting, not the platform's: its alerts matrix
has no WhatsApp column for apps, because those rows route to the admin's one number and our messages
are for the congregation.

### 7. Admin commands (implemented — keep it)

`commands:` declares what an admin can run by messaging the masjid's WhatsApp number. The platform
owns everything except the doing — it decides who may run them, renders the numbered menu from our
manifest order, and formats the reply. We serve one route, `POST /fabric/commands/run`
(`server/src/fabricCommands.ts`), and it is the **only inbound Fabric surface this app has**.

The envelope, all of which is load-bearing:

- **Both headers or nothing.** `X-OpenMasjid-App-Secret` must equal our OWN
  `OPENMASJID_APP_SECRET` (constant-time compare) **and** `X-OpenMasjid-Caller-App` must be exactly
  `omos:platform`. That value can never be an app id — the colon is outside the app-id charset — so
  it identifies the platform by construction rather than by an allow-list. Checking only the secret
  would let anything that ever learned it drive the wizard.
- **Exact path only, which IS the LAN-only enforcement.** Behind the tunnel this app is served under
  `/<basePath>/…` and the platform does not strip the prefix, so a tunnelled request arrives as
  `/display/fabric/commands/run` and does not match. We never register the prefixed form. There is no
  header to trust for this.
- **10 s / 16 KB.** Someone is holding a phone. Reply text is plain, ≤1000 chars.
- `404 {code:'unknown_command'}` for an id we don't serve, `503 {code:'not_ready'}` before we have a
  secret, `200 {ok:false,error}` for a refusal we can explain — an HTTP error there would become a
  generic "that did not work" instead of our own words.
- **Never put `commands` in `fabric.provides`.** It is reserved and refused at install: it would
  expose this same handler to other apps through the app-to-app broker, a different trust boundary
  sharing a path prefix.

**The wizard is ours, because the contract is one-shot.** The platform holds a menu snapshot and a
pending confirmation per sender, but it has no "ask the next question and wait" — an argument must be
typed inline (`!display 1 <answer>`) or it answers `missing-argument` itself. So `argument.required`
is **false** (which is what makes a bare `!display 1` legal, and is how the flow starts), each later
answer arrives as another call, and `server/src/iqamahWizard.ts` remembers where we were.

Two consequences worth knowing before changing it:

- **There is one session, not one per person.** The request body is
  `{command, text, requestId, locale}` — no sender. So state cannot be keyed per admin. Every reply
  restates the whole gathered change, and a session expires after 15 minutes.
- **`confirm: true` is deliberately OFF.** The platform's confirmation fires per call, so it would
  demand a code before *every* step. The wizard's own `save` is the confirmation, and nothing is
  written before it — which is also what makes it safe to infer am/pm from the prayer.

## What Display does NOT need — but exists

- **Stripe (`stripe: true`) — skip.** Display takes no payments. Do not set it.
