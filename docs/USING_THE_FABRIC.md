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

## What Display does NOT need — but exists

- **Stripe (`stripe: true`) — skip.** Display takes no payments. Do not set it.
