<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# ACTION REQUIRED — items a human must decide or do

From the 2026-08-04 audit of `OpenMasjidDisplay` @ `c1080cd` (see
[`SECURITY_AUDIT.md`](SECURITY_AUDIT.md)). Nothing in this file was changed autonomously.

---

## 0. Read first: pushing to `main` publishes the image every masjid installs

`.github/workflows/build-image.yml` publishes
`ghcr.io/openmasjid-solutions/openmasjiddisplay:<manifest version>` **and `:latest`** to
GHCR on **every** push to `main`. That is why no work — audit or otherwise — is pushed there
autonomously.

> **Historical note.** This audit was carried out on a branch called
> `audit/security-2026-08-04`, which was merged and deleted after v0.66.0 shipped. The repo
> has since adopted a standing two-branch policy that generalises the same rule: **all work
> happens on `dev`, and `main` moves only as a deliberate release.** See
> [`CLAUDE.md`](../../CLAUDE.md) § *Branching policy* — that is the live rule; this section
> records why it exists. The version numbers quoted below are the ones current during the
> audit and are left as written.

---

## 0b. ~~The fixes are NOT shipped yet~~ — SHIPPED as v0.66.0 (DISPLAY-028) ✅

**Done on 2026-08-05.** Released as **v0.66.0** and live in the catalog, so masjids are now
offered the fixed build:

- image `ghcr.io/openmasjid-solutions/openmasjiddisplay:0.66.0@sha256:8b767f59…` (amd64 + arm64)
- registry pinned to `715139b589f3376315bc74af919a46565e443920`
- numbered **0.66.0, not 0.62.0**, because GHCR already had published images for 0.62.0–0.65.0
  (the withdrawn Pi-node releases); reusing one would make a published tag mean two different
  things — DISPLAY-010's hazard.
- verified the published image genuinely contains the fixes: its config carries the
  DISPLAY-019 `HEALTHCHECK`, which the previously-served digest does not.

The original problem, for the record:

**Every masjid installing or recreating still got the pre-audit image.** The fixes were
on `main`; they were not in the catalog.

- All four version files still read `0.61.0`.
- `docker-compose.yml` still pins `sha256:3642573141cf…` — the image built at `c1080cd`,
  *before* any fix.
- Verified live against GHCR: `:0.61.0` **and** `:latest` now resolve to
  `sha256:77f48427…` (built from the audited code), while the digest the catalog actually
  serves is now reachable by **no tag at all**.

So the crash (DISPLAY-001) and the silently-stale prayer times (DISPLAY-002) are still live in
the field. This is precisely the hazard DISPLAY-010 described, now materialised.

**Action:** cut a release when you're ready — bump the four version files, tag, let CI publish,
re-pin the **new** digest in `docker-compose.yml`, then point `registry.yaml` in
OpenMasjidAPPS at the digest-pin commit. I have not done it: deciding when masjids receive an
update is yours, and the follow-up branch below should land first so you ship the fixes
*without* the two regressions they introduced.

---

## 1. Secrets to rotate

**None.** No secret was found in the working tree or anywhere in git history. The history
was swept with `git log -p --all -S` for AWS keys, GitHub PATs and fine-grained tokens,
Stripe live keys, PEM private keys, Slack tokens and Google API keys. The single `AKIA`
match is a byte sequence inside `server/assets/fonts/NotoNaskhArabic-Regular.ttf`, not a
credential. No `.env`, `.pem`, `.key`, `.p12` or `credentials` file was ever committed.

Two things are *handled* as secrets and are correctly never logged or returned — no action
needed, listed so you know they were checked:

- `OPENMASJID_APP_SECRET` — injected by the platform at install; `/api/notify-test` returns
  only a `hasSecret` boolean, never the value.
- `<DATA_DIR>/session.secret` — generated on first run. **If you ever act on DISPLAY-003,
  note that regenerating this file signs every admin out.** That is the intended
  fail-closed behaviour.

---

## 2. Do not garbage-collect the `0.61.0` image digest in GHCR

The catalog rollback pins
`ghcr.io/openmasjid-solutions/openmasjiddisplay:0.61.0@sha256:3642573141cf042f4b5258e5fe3c5b4fbd4b8ae20eef26aeef99716500b38926`
(verified pullable). Because every push to `main` republishes the `:0.61.0` tag
(DISPLAY-010), that digest becomes **untagged** after the next build while remaining the
image every masjid installs.

**Action:** confirm no GHCR retention/cleanup policy deletes untagged manifests for this
package. If one exists, either exclude this digest or re-tag it (e.g. `:0.61.0-released`).
Deleting it would break installs for every masjid.

---

## 3. Container user change — needs a migration decision (DISPLAY-008)

The image runs the app, **ffmpeg** and **MediaMTX** as root. The correct fix is a non-root
`USER`, plus `no-new-privileges` and `cap_drop` in compose.

**Why this was not done autonomously:** adding `USER` changes the uid that must own `/data`,
and every existing install has a root-owned `data` volume. Shipping it without a migration
would leave masjids unable to read their own configuration after an update — losing
timetables, screens, cameras and schedules. This is a deployment/data-ownership change and
is explicitly out of scope for autonomous work.

**Action:** decide the migration. Options, roughly in order of preference:

1. Keep the entrypoint as root only long enough to `chown -R` the data dir, then drop to a
   non-root user (`gosu`/`setpriv`), so existing volumes self-heal on first start.
2. Ship non-root only for fresh installs and document a manual `chown` for upgrades.
3. Keep root, but add `no-new-privileges: true` and `cap_drop: [ALL]` (with the caps ffmpeg
   and MediaMTX actually need added back) as a partial improvement.

Whichever you pick, test against a **pre-existing** `data` volume, not a fresh one.

---

## 4. Release-workflow policy change — needs your call (DISPLAY-010)

Today `:latest` and `:<manifest version>` are republished on every push to `main`, so a
published version tag does not immutably identify a release.

**Recommended:** publish the version tag only from `refs/tags/v*`; from `main` publish only
a moving tag such as `:edge`.

**Why this was not done autonomously:** it changes the release channel and interacts with
the OpenMasjidAPPS catalog contract (`registry.yaml` `commit:` + the compose digest pin).
Per the audit rules, changes to the update/release channel are held for human review rather
than shipped.

---

## 5. Session revocation needs a product decision (DISPLAY-007)

There is **no way to revoke an admin session, and no way to change the admin password.**
`/api/setup` sets the local password once (409 afterwards) and `/api/login` checks it —
that is the whole of it. Tokens carry only `{ exp, aud }`, so an issued admin cookie is
valid for its full 30 days and nothing in the product can invalidate it. If a laptop is
lost or a volunteer signs in on a borrowed phone, the masjid's only options are to wait up
to 30 days or to delete `session.secret` out of the Docker volume by hand.

**Why this was not fixed autonomously:** my own remediation plan said "add a `tokenVersion`
and bump it on password change" — and there is no password change to bump it on. Adding
`tokenVersion` by itself would change nothing observable. Making it useful means adding new
**authenticated endpoints** (change-password, and/or "sign out other devices") together with
the UI for them. That is a product feature, and inventing auth endpoints unprompted during a
security review is how a review becomes a regression.

**Action:** decide whether you want this, and in what shape. My recommendation:

1. `POST /api/change-password` — verify the current password, re-hash, re-issue the caller's
   own cookie.
2. `tokenVersion` on `db.admin`, included in the token payload and checked in
   `verifyToken()`.
3. Bump it on password change and on an explicit "sign out other devices" button.

Under SSO the platform already owns identity, so this only needs to cover the local recovery
password. Until then, the honest workaround to document for admins is: stop the app, delete
`<data volume>/session.secret`, start it again — everyone is signed out.

---

## 6. Cross-repo

**No cross-repo API contract, wire protocol or shared schema change is required.** The
Fabric contract (`OPENMASJID_*` env names, the `x-openmasjid-app-secret` header, the
`omos_session` cookie, `/api/auth/session`, `/api/fabric/notify`, `/api/fabric/site`) is
untouched by every fix in this audit, and so is the catalog contract.

Two cross-repo *observations*, offered as information rather than required work:

- **A pattern worth copying into other apps.** DISPLAY-001 (an uncaught `URIError` from
  `decodeURIComponent` in a cookie parser, fatal because it fires inside a
  non-`try/catch`ed event listener) is the kind of bug shared by copy-paste. This app is
  the reference implementation other OpenMasjid apps copy their structure from
  (`CLAUDE.md` §1), so **check `parseCookies` in Donations, Kiosk, Students and the OS
  itself.** If they share this shape, they share the crash.
- **Two fixes here already exist elsewhere in the family** and are worth landing for
  consistency: session invalidation on password change (Students v0.45.0) and
  SHA-pinning every CI action (Kiosk v0.10.1, Students v0.45.0, OpenMasjidAPPS).

---

## 7. Verification only you can do

- **DISPLAY-002 on real hardware.** I proved the code path but cannot reproduce a genuine
  resvg/worker hang on demand. Once the timeout and staleness indicator land, confirm on a
  real screen that a wedged render surfaces visibly rather than freezing silently.
- **Whether the legacy plain-HTTP panel port is still needed** (DISPLAY-005). If you can
  drop it and serve the panel only over the platform's TLS proxy, the cleartext-cookie
  exposure disappears entirely and the per-request `Secure` logic becomes belt-and-braces.

---

## 8. Not a security finding, but you should know

The revert to `v0.61.0` removed two CI improvements that were independent of the Pi-node
work and are worth re-landing on their own merits:

- the **published-image smoke test** (boot the container, assert `/healthz`, `GET /` → 200,
  `GET /api/state` → 401) — this is the check that would catch a broken release before a
  masjid does; **still outstanding.**
- ~~the **`tsconfig.check.json` test-file typecheck** for `server/`~~ — **re-landed** in the
  2026-08-13 sweep as `npm run typecheck:tests`, wired into the `server` job in `checks.yml`.
  It justified itself on the first run, catching an assertion in `iqamahSchedule.test.ts` that
  read a property which is not on the type it was asserting against.

The GitHub Release for **v0.65.0 still exists and still advertises the Pi node image**, and
tags `v0.62.0`–`v0.65.0` remain. Nothing was deleted (no history was rewritten). If you
want the store and the repo to tell the same story, consider marking those releases as
pre-release or adding a note pointing at the rollback.
