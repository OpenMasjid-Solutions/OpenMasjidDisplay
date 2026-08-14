<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# OpenMasjidOS Fabric — appearance + single sign-on (the "Fabric")

> **The OpenMasjidOS Fabric** is the platform↔app integration layer: the unified appearance + single
> sign-on / API that lets an installed app inherit the dashboard's look and (opt-in) share its login.
> "The Fabric" is the shorthand. It is **optional and backwards-compatible** — this app works fully
> standalone (its own appearance + own login) when the Fabric is absent.
>
> **Status (2026-06-21): live on both sides, including identity-bound SSO.**
> - Platform: appearance (A1 `#omos=` fragment, A2 `GET /api/public/appearance`) since **v0.18.0**;
>   **identity-bound SSO since v0.19.x** — `GET /api/auth/session` now **fails closed** and is bound to
>   the calling app: a valid `omos_session` cookie alone is no longer enough, the app must present its
>   per-app secret in the **`X-OpenMasjid-App-Secret`** header (see `packages/core/src/api/fabric.ts`).
> - OpenMasjid Display: consumes appearance in `web/src/prefs.ts` and SSO in **`server/src/fabric.ts`**.
>   As of **v0.14.0** it is compliant with the identity-bound contract — `manifest.yaml` sets `sso: true`
>   (so the platform issues `OPENMASJID_APP_SECRET` at install), and the introspection call sends that
>   secret in `X-OpenMasjid-App-Secret`. `ssoConfigured()` now requires the secret, so on an older
>   platform that doesn't issue one, SSO simply stays off and the app uses its own login.
> - **Notifications (since v0.20.0):** `manifest.yaml` sets `notifications: true`; `fabric.ts` `notify()`
>   relays alerts via `POST /api/fabric/notify` (per-app secret, `{text,title?,level?}`). The app never
>   sees the webhook URL and the call fails soft. Used to alert when a screen stops/starts pulling its RTSP
>   stream (offline/online), decided in `orchestrator.ts` from MediaMTX reader counts — no probe/config.
> - **Public URL (since v0.30.0):** `manifest.yaml` sets `domain: true`; `fabric.ts` `siteInfo()` reads
>   `GET /api/fabric/site` so the website-widget embed code and the volunteer-page link can point at the
>   admin's tunnel address instead of a LAN one. Authoritative + fails soft to the LAN link. `basePath`
>   is admin-renameable — read it, never hardcode `display`.
> - **HTTPS panel:** `manifest.yaml` sets `https: true`, so the platform fronts the FIRST published port
>   with its TLS proxy (secure context → clipboard + `Secure` cookies). The plain HTTP port stays as a
>   legacy fallback and the volunteer port is not proxied — which is why `auth.ts` gives the `Secure`
>   cookies their own names.
> - **Compose security:** the app passes the platform's tightened compose risk-check (v0.19.2) — no
>   privileged / host-namespace / `cap_add` / `devices` / `device_cgroup_rules` / `security_opt:unconfined`
>   / `group_add` / Docker-socket / sensitive-mount / `extends:`/`include:`; pins the image, named volume.
>
> The wire identifiers are the shared Fabric contract and must stay byte-for-byte: env vars
> `OPENMASJID_BASE_URL`, `OPENMASJID_APP_ID`, `OPENMASJID_APP_SECRET`; header `X-OpenMasjid-App-Secret`;
> cookie `omos_session`; endpoints `/api/auth/session`, `/api/public/appearance`, `/api/fabric/notify`.
> "Fabric" names the layer, not a prefix on those identifiers.
>
> The sections below are the original contract, kept as the spec of record; the authoritative normative
> contract now lives in the platform repo's `docs/APP_MANIFEST_SPEC.md` ("OpenMasjidOS Fabric" section)
> and `OpenMasjidAPPS/docs/BUILDING_AN_APP.md` §7.
>
> **App-side hardening (from the 2026-06 OpenMasjid Display audit), all in place:** audience-bound local
> tokens, login rate-limiting, short (~1 h) SSO session, ~45 s positive cache, cookie read only from the
> request + charset-sanitized before forwarding, `redirect:'error'` + timeout, and now the per-app
> secret so SSO is identity-bound end to end.
>
> **Transport note — set an https `OPENMASJID_BASE_URL` for cross-host deployments.** By default the app
> talks to the platform over the trusted LAN in plain http (e.g. `http://openmasjidos.local`), which is fine
> — same host/LAN, nothing leaves the network. But the per-app Fabric secret is sent in the
> `X-OpenMasjid-App-Secret` header on every `/api/auth/session` and `/api/fabric/notify` call, so if the
> platform lives on a **different, public host** reached over plain http, that secret crosses the network in
> cleartext. For any cross-host setup, point `OPENMASJID_BASE_URL` at an **https** address so the secret is
> encrypted in transit. The app logs a one-time warning (in `server/src/fabric.ts`) if it detects the secret
> going to a public host over plain http; it never refuses to send, so the LAN default keeps working untouched.

---

## ✅ Resolved — the Fabric env wasn't reaching this container (app-side compose fix)

**Root cause (v0.20.5):** the platform injects `OPENMASJID_BASE_URL` / `OPENMASJID_APP_ID` /
`OPENMASJID_APP_SECRET` by writing them to the app's `.env` and running `docker compose --env-file`. That
only feeds **`${VAR}` substitution** — it does **not** push vars into the container. This app's
`docker-compose.yml` never *referenced* `${OPENMASJID_*}` in its `environment:`, so the container saw none of
them (`/api/notify-test` reported Platform URL / App ID / secret all "(not set)"). That silently disabled
**both** SSO and notifications. Fixed by referencing them in compose:
`OPENMASJID_BASE_URL: ${OPENMASJID_BASE_URL:-}` (+ APP_ID, APP_SECRET). This is exactly what the contract's
"reference settings as `${KEY}` and pass them via `environment:`" rule requires — it also applies to the
Fabric vars. Platform side (catalog capability + env injection) was correct; the gap was the app's compose.

---

## (Historical) Open item for the OpenMasjidOS agent — Fabric notify isn't delivering

**Symptom (reported by a masjid running this app):** a screen-offline alert never reached the webhook.
The platform's own **Settings → Notifications → "test webhook"** *does* post successfully, so the webhook
destination is fine — but messages **relayed by an app** through `POST /api/fabric/notify` don't arrive.

**App side is verified correct** (`server/src/fabric.ts` `notify()`): it POSTs to
`${OPENMASJID_BASE_URL}/api/fabric/notify` with header `X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>`,
body `{ text, title?, level? }`, `redirect:'error'` + timeout, and fails soft. The app exposes a diagnostic
**`POST /api/notify-test`** that returns `{ baseUrlSet, hasSecret, baseUrlLoopback, delivered, reason }` — run
it (Settings → Notifications → "Send a test notification") to see the exact `reason` from the app's side.

**Please check on the platform (`packages/core/src/api/fabric.ts` + `notify/notify.ts`):**
1. **Capability + secret are granted on UPDATE, not just first install.** This app was likely installed
   before it declared `notifications: true`, so its stored app record may still have `notify:false` (→ the
   route's `if (!app || !app.notify) return 403`) and/or no `OPENMASJID_APP_SECRET` injected. Confirm that
   *updating* an installed app re-reads the manifest, re-grants capabilities, and (re)injects the secret —
   otherwise the only fix is remove + reinstall, which is bad UX.
2. **`sendNotification(payload, appId)` actually posts to the webhook** — i.e. the app-relay path hits the
   *same* delivery code as the working Settings "test webhook" button, loads the configured destination, and
   doesn't just return `{delivered:true}` without sending. A divergence between the two paths fits the
   symptom exactly (Settings test works, app relay doesn't).
3. The route is **registered/deployed** in the running build (`registerFabric`) — an older platform returns
   404 for `/api/fabric/notify`.
4. It isn't being silently dropped by the **per-app / platform rate limit** or a `disabled` short-circuit.

The wire contract is unchanged and correct on the app side; this is about the platform delivering relayed
notifications. (OpenMasjid Display ≥ v0.20.2.)

> Audience: the **OpenMasjidOS** core developer. This describes small, optional,
> backwards-compatible platform features so apps (e.g. **OpenMasjid Display**) can
> (A) **inherit appearance** — dark/light + wallpaper — and (B) optionally share a
> **single login** with the dashboard. Nothing here moves masjid data into the
> platform: the platform still holds **no** masjid profile. These are presentation
> + auth conveniences only.
>
> Grounded in the current code: sessions in `packages/core/src/auth/sessions.ts`
> (cookie `omos_session`, HttpOnly, **SameSite=Strict**, opaque in-memory token),
> `auth.me` in `packages/core/src/trpc/routers/auth.ts`, the "Open" URL in
> `packages/ui/src/lib/apps.ts`, install env in `packages/core/src/apps/manager.ts`.

## Design principles

1. **Optional & graceful.** An app must work perfectly standalone. If these hooks
   are absent, the app uses its own appearance prefs and its own login. Integration
   only *enhances*.
2. **Presentation only.** The platform shares theme/wallpaper/locale — **never**
   masjid/prayer data. That stays in each app.
3. **Same-host assumption.** Cookie sharing works because the dashboard and the app
   are the same host on different ports (same-site). If an app is on another host,
   SSO simply doesn't engage and the app falls back to its own login.

---

## Part A — Appearance & preference inheritance (recommended; low effort)

Share the viewer's presentation prefs: `theme` (`system|dark|light`), `wallpaper`
(preset id), `wallpaperImage` (optional URL), `accent` (optional), `lang`.

### A1. Hand-off on the "Open" link (instant, no network, cross-origin-safe)

When the dashboard opens an app, append the prefs as a **URL fragment** (the part
after `#` is never sent to any server or written to logs):

In `packages/ui/src/lib/apps.ts`, change the open URL builder to append:

```
#omos=<base64url(JSON.stringify({ v:1, theme, wallpaper, wallpaperImage, accent, lang }))>
```

Example:
```
http://192.168.4.50:7860/#omos=eyJ2IjoxLCJ0aGVtZSI6InN5c3RlbSIsIndhbGxwYXBlciI6Im9jZWFuIn0
```

The app reads `location.hash` on load, applies + persists the values, then clears
the hash. (OpenMasjid Display is ready to consume this.) Payload is **presentation
only**; the `v` field is a version for forward-compat.

> **Security:** the fragment is **not a trust channel** — anyone can hand a user a
> link with a crafted `#omos=…`. Never put a token, identity, or any security-relevant
> value in it (presentation only). Apps must sanitize what they read (OpenMasjid Display
> validates the `wallpaperImage` URL before using it).

### A2. Live read endpoint (optional — for live theme changes without reopening)

Add a tiny **public** read of the current presentation prefs:

```
GET /api/public/appearance
→ 200 { "v":1, "theme":"system", "wallpaper":"ocean", "wallpaperImage":"", "accent":"cyan", "lang":"en" }
```

- **Presentation only — must never expose anything tied to the session** (it is
  browser-fetched cross-origin and may be unauthenticated). No masjid data, no identity.
- For an app's **browser** to read it cross-origin, send
  `Access-Control-Allow-Origin: *` (or echo the app origin) on **this route only** —
  do not widen CORS to authenticated routes (especially not `/api/auth/session`).
- Apps poll this occasionally (or on focus) to follow live theme/wallpaper changes.
- The platform already persists these in its prefs store (`packages/ui/src/lib/prefs.ts`);
  this endpoint just exposes the presentation subset.

> A1 alone already covers "looks right when I open it." A2 adds live sync.

---

## Part B — Single sign-on (optional; medium effort) — **feasible**

**Verdict:** yes, an app can share the dashboard login, because the `omos_session`
cookie (set for the host) is delivered by the browser to the app's port too
(same-site). The app cannot validate the opaque token itself, so the platform must
expose a way to **introspect** it. Two implementation options:

### Option B1 — Cookie introspection (lighter; keeps direct-port apps)

1. **Tell apps where the platform is + who they are.** On install, the platform
   injects into an `sso: true` app's env (in `packages/core/src/apps/manager.ts`):
   ```
   OPENMASJID_BASE_URL=http://<lan-ip-or-host>:8723
   OPENMASJID_APP_ID=display
   OPENMASJID_APP_SECRET=<random per-app secret>   # only for sso: true apps — a credential
   ```
2. **Expose a stable introspection route** (a plain-REST mirror of the existing
   `auth.me`, so apps don't depend on the tRPC envelope):
   ```
   GET /api/auth/session        (reads the omos_session cookie + X-OpenMasjid-App-Secret header)
   → 200 { "authenticated": true, "username": "admin" }   // or { "authenticated": false }
   ```
3. **App flow (server-to-server, never trust the browser):** the app's *backend*
   takes the incoming `omos_session` cookie from the request and forwards it to
   `${OPENMASJID_BASE_URL}/api/auth/session` **together with its own identity** in the
   `X-OpenMasjid-App-Secret` header (the per-app secret from step 1). The platform
   returns `authenticated:true` only when the cookie is valid **and** the secret
   matches a known SSO-capable app — so a valid cookie alone is no longer enough, and
   one installed app can't impersonate the session as another. If `authenticated` is
   true, the app treats the request as signed-in (SSO). Cache the positive result
   briefly (~45 s) per token to avoid a round-trip on every call.
4. **Fallback:** if `OPENMASJID_BASE_URL` **or `OPENMASJID_APP_SECRET`** is unset, the
   platform is unreachable, or no `omos_session` is present, the app uses its **own**
   password login. So SSO is purely additive and degrades gracefully on older platforms.

**Security requirements (must-haves) — `/api/auth/session` is the trust anchor.**
A single `{"authenticated":true}` from this route causes an app to grant a signed-in
session (in OpenMasjid Display it mints a local **admin** session). Treat it accordingly.
These were hardened/validated during the OpenMasjid Display security audit (2026-06):

- **Fail closed and be strict.** Return `authenticated:true` *only* for a genuinely
  valid, unexpired, not-logged-out `omos_session`. Never return true for a missing/
  empty/garbage cookie or a revoked session. Read the token **only from the cookie** —
  never accept it via query string, header, or body (those are spoofable and end up in
  logs). Keep the response shape exactly `{ authenticated: boolean, username?: string }`;
  apps treat `username` as an untrusted display string (cap/escape it).
- **Bind validation to the calling app's identity (the shared-cookie problem).** Because
  `omos_session` is delivered by the browser to **every port on the host**, *every*
  installed app receives the user's cookie and can forward it to `/api/auth/session` —
  so one malicious/compromised app can validate as that user (and, for apps that mint
  admin, become admin). The route currently ignores `OPENMASJID_APP_ID`. **Require the
  calling app to present its `OPENMASJID_APP_ID`** (or, better, a per-app secret/token
  issued at install) and scope/audit the result per app — don't hand every app a global
  "yes" for the whole session. This is the most important fabric-side hardening.
- **`OPENMASJID_BASE_URL` is a trust input — set it only from the platform**, to the
  platform's own address (loopback/internal preferred). If an attacker can influence
  this env at install time, the app's validation is redirected to a server they control
  → instant elevated session. (App side already uses `redirect:'error'` + a timeout and
  charset-sanitizes the forwarded cookie, but the env itself is the platform's to protect.)
- **Revoke promptly.** After a user logs out or is deprovisioned, `/api/auth/session`
  must start returning `authenticated:false` quickly — apps re-validate on a short cache
  (~45 s) and on session expiry (OpenMasjid Display caps SSO sessions at ~1 h), so a
  stale "true" leaves a lingering app session for that long. Add a revocation signal /
  shorter max-validity to the contract if tighter is needed.
- **Transport.** B1 assumes same-host (LAN, plain HTTP, cookie `SameSite=Strict`/HttpOnly —
  keep both). If the platform or an app can ever live on another host, `/api/auth/session`
  must be **HTTPS-only** and `omos_session` must be `Secure` (else the bearer cookie
  crosses the network in cleartext). Cross-host SSO otherwise belongs to B2.
- **Token hygiene (if the platform issues its own/per-app tokens).** Bind an
  audience/scope into the signed token and verify it — never let a token's *name* (or
  cookie name) be the only thing separating two trust levels. (OpenMasjid Display had a
  bug where the admin and volunteer tokens shared a secret and differed only by cookie
  name; one could be replayed as the other. Fixed by embedding+verifying an `aud` claim.)
- The introspection call is **server→server** over the LAN; do not rely on CORS for it.
- Keep the app's own CSRF posture (its API is same-origin to its own UI).

### Option B2 — Forward-auth reverse proxy (the "Umbrel-style" ideal; larger change)

The platform proxies each app's **web UI** under its own origin, e.g.
`http://<host>:8723/apps/display/`, runs its auth middleware there, and injects a
trusted `X-OpenMasjid-User` header to the upstream app (which trusts that header
only from the proxy). This gives true SSO, one origin (also removes the cross-port
cookie nuance), and a tidy URL — at the cost of a proxy layer.

Caveat for this app specifically: **RTSP (port 8554) cannot be HTTP-proxied** — only
the control panel would sit behind the proxy; the RTSP video links stay direct. So
B2 helps the panel SSO but doesn't change how TVs connect.

**Recommendation:** start with **A1 + B1** (small, safe, direct-port-friendly).
Consider B2 later if the platform wants a unified origin for all app UIs.

---

## Minimal platform change checklist

- [ ] A1: append `#omos=<base64url json>` to the app open URL (`apps.ts`). Presentation
      only — never a token/identity (it's an attacker-craftable, untrusted channel).
- [ ] A2 (optional): `GET /api/public/appearance` exposing **only** presentation prefs;
      scope `Access-Control-Allow-Origin` to this route, never to authenticated ones.
- [ ] B0: inject `OPENMASJID_BASE_URL` (+ `OPENMASJID_APP_ID`) into app env on install —
      set **only** by the platform, to the platform's own address.
- [ ] B1: `GET /api/auth/session` returning `{authenticated, username}` from the cookie —
      **fail closed**, cookie-only, strict; do not return true for missing/revoked sessions.
- [ ] B1 hardening: **bind validation to `OPENMASJID_APP_ID`** (or a per-app secret) so a
      shared `omos_session` can't let one installed app act as the user toward another.
- [ ] Revoke promptly: `/api/auth/session` flips to `false` on logout/deprovision (apps
      cache ~45 s and cap their SSO session ~1 h).
- [ ] If apps can ever run cross-host: serve `/api/auth/session` over HTTPS and mark
      `omos_session` `Secure`.
- [ ] Keep everything optional — apps must still work with none of it.

On the app side, OpenMasjid Display will: read the A1 fragment on load; (if A2) poll
appearance; (if B0+B1) accept the platform session with its own password as fallback.
