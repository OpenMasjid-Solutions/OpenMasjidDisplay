<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# New Fabric endpoints: Stripe vault + public URL

> **Status update.** When this was written neither capability applied to Display. One of them
> since did: **`domain: true` is now set** in [`../manifest.yaml`](../manifest.yaml) and used by
> `fabric.ts` `siteInfo()`, because the website widget and the volunteer page both need a public
> address when the admin has remote access on. The §"Does Display need `domain: true`?" answer
> below is the *original* answer and is no longer current — see the amendment under it.
>
> **Stripe is unchanged: Display does not take payments, so `stripe: true` stays off.**

## What's new on the platform

- **Stripe vault (OpenMasjidOS v0.29.0):** the admin stores named Stripe accounts once in
  Settings → Payments; apps fetch them via `GET /api/fabric/stripe?account=<name>` (manifest
  `stripe: true`). **Display doesn't take card payments, so do *not* set `stripe: true`** — skip it.
- **Remote access / public URL (v0.30.0):** the admin can run a Cloudflare Tunnel (Settings → Remote
  access). Apps can learn their public URL via `GET /api/fabric/site` (manifest `domain: true`).

## Does Display need `domain: true`?

**Not today.** Display's screens connect over RTSP on the LAN, and the control panel builds its links
from the address the browser opened it with — so it has no need for an externally-resolvable URL yet.

Consider `domain: true` **only if** a future feature needs an absolute, internet-reachable URL — e.g.
a public "view this screen / timetable" link or a QR code that works off-site. If that happens:

```
GET ${OPENMASJID_BASE_URL}/api/fabric/site
  X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>
→ { "enabled": true, "domain": "omos.example.org", "publicUrl": "https://omos.example.org/display" }
```

Until then, leave it off — least privilege (the platform only issues the per-app secret to apps that
opt into a Fabric capability).

### Amendment — that future arrived; `domain: true` is on

The "public link that works off-site" case above is exactly what shipped: the **website widget** hands
a masjid an embed snippet for their own site, and the **volunteer page** can be opened from outside the
masjid. Both need an absolute, internet-reachable URL, and only the platform knows it.

`fabric.ts` `siteInfo()` calls `GET /api/fabric/site` and treats the answer as authoritative — the
platform only returns a `publicUrl` when it is genuinely routing this app's path, so the app does not
try to verify it by hairpinning a request at itself from inside the container (that was unreliable even
when real visitors reached the path fine). It **fails soft**: no Fabric, tunnel off, or any error → the
panel builds a LAN link instead. Note `basePath` is admin-renameable, so read it rather than assuming
`/display`.

## History: the fix this note pointed at

It also flagged [`RESTORE_SSO_FIX.md`](RESTORE_SSO_FIX.md) — the sign-in lockout after a backup
restore — as the thing that actually mattered for Display. That is **fixed**; see the note at the top
of that file, which explains why the shipped fix is deliberately narrower than the one it proposed.

See OpenMasjidAPPS `docs/BUILDING_AN_APP.md` §7 for the full Fabric capability contract.
