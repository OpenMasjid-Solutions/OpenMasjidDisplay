<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Platform request: route each app's public path through the Cloudflare tunnel

> ## ✅ RESOLVED in OpenMasjidOS v0.37.0
> The platform now reverse-proxies `/<basePath>/*` from its HTTP front door to each
> app's `ports[0]`, **keeping the full path** (`system/ingress.ts`). That's option (1)
> below. **Display needs no change** — its widget route already matches the kept-prefix
> form (`/<appId>/w/:id`), the LAN form (`/w/:id`), and an admin-renamed basePath, and
> the editor builds the embed link from the Fabric `publicUrl` (so a renamed path just
> works). See **`REMOTE_ACCESS_INGRESS.md`** (the platform's answer) for the live chain
> and the one-Cloudflare-route setup. The rest of this file is kept as the original
> request, for history.

---

**Audience:** maintainers/agents of the **OpenMasjidOS** repo (and anyone wiring the
Cloudflare tunnel). **This is NOT a change to OpenMasjidOS that the Display app made —
it's a request.** Nothing in the platform repo was edited; this doc describes the gap
and the fix.

---

## Symptom

OpenMasjid Display added a public, embeddable prayer-times **widget**. The app asks the
Fabric for its public address (`GET /api/fabric/site`) and builds the embed URL from the
returned `publicUrl` + `/w/<timetableId>`, e.g.:

```
https://omos.openmasjidos.org/display/w/tt_6e46aea7
```

Opening that URL **loads a different app (OpenMasjid Donations), not the Display widget.**
So `publicUrl`/`basePath` are *advertised* but the tunnel doesn't actually route
`/<appId>/*` to that app's container — the hostname resolves to a single app and every
path falls through to it.

## Root cause (in the OpenMasjidOS repo)

- `packages/core/src/api/fabric.ts` → `GET /api/fabric/site` returns
  `publicUrl = https://<domain>/<appPath>` and `basePath = /<appPath>` and tells the app
  to "mount its routes/assets under this base path so links resolve behind the tunnel."
- `packages/core/src/system/cloudflared.ts` → `appBasePath()` / `appPublicUrl()` compute
  `/<getAppPath(appId)>`, **but** the file's own header says:
  > "Routing (which hostname/path → which app) is configured in the Cloudflare dashboard
  > … **path-based ingress is a planned enhancement (see docs).**"

So the **contract promises a per-app public path that nothing enforces.** Today the tunnel
points the whole hostname at one origin (the dashboard or whichever app owns the
hostname), and `/<appId>/...` is not dispatched to `<appId>`'s container.

## What's needed in OpenMasjidOS

Implement the planned **path-based ingress** so a request to
`https://<domain>/<appId>/*` reaches that app's **first published (control-panel) port** —
the same target the per-app HTTPS proxy already uses
(`ensureProxy(app.id, httpsPort, installed.ports[0])` in
`packages/core/src/apps/manager.ts`, via `system/app-proxy.ts`).

Any of these is acceptable; pick what fits the tunnel design:

1. **cloudflared ingress rules** — generate one ingress rule per installed app mapping
   `hostname=<domain>, path=/<appId>/*` → `http://127.0.0.1:<app ports[0]>` (or the app's
   HTTPS proxy port), with a final catch-all to the dashboard. Regenerate when apps are
   installed/removed (the same lifecycle hooks that call `ensureProxy`).
2. **A reverse proxy in front of the tunnel** (the existing `app-proxy`) that strips
   `/<appId>` and forwards to that app, with the tunnel pointing at the proxy.
3. Document the **manual** Cloudflare "Public hostname → Path" rule an admin must add per
   app, and have the dashboard surface the exact rule to paste.

### Path prefix: strip or keep — both are fine

The Display app accepts the widget at **both** `/w/<id>` and `/<appId>/w/<id>` (its route
matcher allows an optional leading path segment), and the widget page fetches its JSON
relative to its own URL. So whether the ingress **strips** `/<appId>` or **passes it
through**, the app serves correctly. Other apps should follow the same rule (mount under
`basePath`, use relative asset/fetch URLs).

### Until it's implemented

Display shows the public link when the platform reports remote access is on and this
timetable's widget is enabled, and the **LAN** link otherwise
(`/api/timetables/:id/widget-info` returns `{ enabled, publicUrl, publicConfigured }`).

> **Corrected 2026-09-01.** This section used to say Display *verifies* a candidate public URL by
> fetching `<publicUrl>/w/<id>.json` and checking for the marker `{"app":"openmasjid-display"}`
> before advertising it. That hairpin check no longer exists: it made the panel depend on the
> masjid's own tunnel being reachable *from inside the masjid*, which is not a thing that can be
> relied on, and a failure there hid a public link that in fact worked. The `app` marker itself is
> still on `/w/<id>.json` and is still part of that route's wire contract — nothing in the app
> hairpins to read it any more.
>
> The practical consequence for the platform is unchanged: Display advertises the public link on the
> platform's own say-so, so the link becomes correct the moment the path is routed, with no further
> app change needed.

**Suggested platform-side acceptance test:** with remote access on, `curl -s
https://<domain>/<appId>/w/<id>.json` must return that app's JSON (here, containing
`"app":"openmasjid-display"`), not another app's HTML.
