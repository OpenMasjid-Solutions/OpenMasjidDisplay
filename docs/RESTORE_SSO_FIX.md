<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Bug: the panel locks you out after an OpenMasjidOS backup is restored / the box is migrated

> ## ✅ FIXED — but **not** the way §"The fix" below proposes. Read this box first.
>
> This document is kept for the diagnosis, which is still correct and still worth
> understanding. **Its proposed fix is not what shipped, and following it verbatim today would
> re-open an unauthenticated admin takeover.**
>
> Step 1 below says to drop the SSO refusal from `POST /api/setup` outright. That cannot be
> done: under SSO the admin signs in through the dashboard and *never* sets a local password,
> so `store.db.admin` stays `null` for the life of the deployment — and an unconditionally
> open `/api/setup` is therefore a permanently open door for anyone who can reach the port to
> claim admin and repoint every screen.
>
> What shipped is the conditional version, which fixes the lockout without opening that door:
> `/api/setup` refuses an anonymous claim **only while the platform is actually reachable**
> (`probePlatform(req).reachable`). Platform up → sign in through the dashboard. Platform down
> — restore, migration, outage, i.e. exactly this bug — → the local recovery password is
> available, as it must be. Steps 2 and 3 shipped as written.
>
> That guard is a standing invariant ([`CLAUDE.md`](../CLAUDE.md) §4). Do not remove it.

**Severity:** high (no way into the control panel until fixed).
**Where:** `server/src/api.ts` — `GET /api/session` and `POST /api/setup`.
**Applies to:** any OpenMasjidOS-integrated app; the same trap existed in OpenMasjid Donations.

---

## Symptom

After the admin restores an OpenMasjidOS backup (especially onto a **new machine**), opening
OpenMasjid Display shows the first-run screen ("This panel uses your OpenMasjidOS sign-in" with
**"I've signed in — continue"** and **"Set a password instead"**), but:

- "I've signed in — continue" does nothing (SSO never completes), and
- "Set a password instead" fails with **"This panel signs in through OpenMasjidOS."**

→ There is **no way to get into the panel.**

## Root cause

The app gates the local-password path on `ssoConfigured()`:

```ts
// server/src/api.ts
needsSetup: !store.db.admin && !ssoConfigured(),   // /api/session
...
if (ssoConfigured()) return sendJson(res, 403, { error: 'This panel signs in through OpenMasjidOS.' }); // /api/setup
```

and `ssoConfigured() = !!omosBaseUrl && !!omosAppSecret` (both read from the platform-injected env).

After a restore those env vars are **still present**, so `ssoConfigured()` stays `true`. But the SSO
probe (`platformUser()` → `GET ${OPENMASJID_BASE_URL}/api/auth/session`) **fails** whenever the
platform can't be reached — e.g. the OS injected the **old machine's IP** as `OPENMASJID_BASE_URL`
(migration), or the platform is briefly down during the restore. With SSO unreachable **and** local
setup refused, the panel is bricked.

> The platform side of the migration case is fixed in **OpenMasjidOS v0.27.0** (it now re-resolves
> `OPENMASJID_BASE_URL` to the current machine when it restarts the apps after a restore) and
> **v0.28.0** adds a "Reset sign-in" recovery. Ask the admin to update OpenMasjidOS. **But the app
> must still be resilient** — a momentarily-unreachable platform should never permanently lock the panel.

## The fix (app-side)

**1. Make the local-password path an always-available recovery.** Don't hard-refuse `/api/setup`
while SSO is configured — that's what makes "Set a password instead" lie. Keep the "already set up"
guard; drop the SSO refusal:

```ts
// POST /api/setup
if (store.db.admin) return sendJson(res, 409, { error: 'The control panel is already set up.' });
// (remove the `if (ssoConfigured()) return 403 …` line)
const pw = String(body.password ?? '');
...
```

SSO stays the convenient default; the local password becomes the recovery that's always reachable.
On a trusted LAN this is the right trade-off (the same one the first-run UI already implies by
offering both buttons).

**2. Tell the UI whether the platform is reachable**, so it can guide the admin instead of looping.
Have the session endpoint distinguish "SSO not configured" from "SSO configured but unreachable":

```ts
// GET /api/session — when ssoConfigured() but platformUser() couldn't connect (network error,
// not just "not signed in"), report it so the web app can show:
//   "Can't reach OpenMasjidOS right now. [Retry]  or  [Set a password to get in]"
sso: { enabled: ssoConfigured(), reachable, username }
```

(Have `platformUser()` / a small `probePlatform()` return a distinct "unreachable" result vs.
"reachable but not signed in".)

**3. Never persist the Fabric env to the data volume.** `OPENMASJID_BASE_URL` and
`OPENMASJID_APP_SECRET` must be read from `process.env` **every process start** (your `config.ts`
already does this — keep it). The platform **changes the base URL across restarts/migrations**, so a
cached copy in `db.json` would re-introduce exactly this bug. (Your `store.secret` is correctly
persisted — that's fine and unrelated.)

## How to verify

1. Run the app with `OPENMASJID_BASE_URL=http://10.255.255.1` (an unreachable host) and
   `OPENMASJID_APP_SECRET=anything`.
2. Open the panel → you must be able to get in via **"Set a password instead."**
3. Point `OPENMASJID_BASE_URL` back at a running platform, sign into the dashboard, reopen → SSO
   signs you in automatically.

## Also recommended (separate, see the OpenMasjidAPPS contract)

The platform now offers a **Stripe vault** over the Fabric (`GET /api/fabric/stripe?account=<name>`,
manifest `stripe: true`) — Display doesn't take payments so this doesn't apply here, but the same
"read from the Fabric, don't store platform-owned secrets locally" principle is now in the contract.
