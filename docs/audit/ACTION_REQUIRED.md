<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# ACTION REQUIRED — items a human must decide or do

From the 2026-08-04 audit of `OpenMasjidDisplay` @ `c1080cd` (see
[`SECURITY_AUDIT.md`](SECURITY_AUDIT.md)).

> ## ⚠ HISTORICAL — read the banner before acting on anything below
>
> This is the record of the **2026-08-04 audit**, kept because it is the only account of what was
> found and why. It is **not** current instruction, and it is annotated where later evidence
> contradicted it (look for *SUPERSEDED* notes). Two things in particular:
>
> - **Do not follow any release or rollback procedure in this file.** The authoritative chain is
>   [`../../CLAUDE.md`](../../CLAUDE.md) § *On "merge to main"*. Where this file and CLAUDE.md
>   disagree, CLAUDE.md is right and this file is the reason it says what it says.
> - **`main` moves only when Hasan says so**, never autonomously — including for a finding in here.
>
> Reviewed against the tree on **2026-09-01** (v0.70.0).

> **On the original "nothing here was changed autonomously":** that was true when written and is no
> longer. Several items have since been acted on in the ordinary course of work on `dev` — §0b's
> release did happen, and the release chain itself was rewritten after the tag order below produced
> three mis-tagged releases. What has never happened autonomously, and must not, is a push to `main`.

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

**Action:** cut a release when you're ready. *Deciding when masjids receive an update is yours.*

> **⚠ SUPERSEDED — do not follow the order this paragraph originally gave.** It said "bump the four
> version files, **tag**, let CI publish, re-pin the new digest", and following it exactly is what
> produced three releases whose tag points at a tree pinning the *previous* release's image
> (`v0.66.1` and `v0.67.0` are still in that state, permanently — a published tag is not rewritten).
> Tagging before the digest exists means the tag can only carry a stale one.
>
> The order is **publish → pin → tag**, and the version bump is **7 fields across 5 files**, not
> four. See [`../../CLAUDE.md`](../../CLAUDE.md) § *On "merge to main"*, which is authoritative and
> exists in that shape because of this paragraph.

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

**Recommended at the time:** publish the version tag only from `refs/tags/v*`; from `main` publish
only a moving tag such as `:edge`.

> **⚠ SUPERSEDED — this recommendation was examined and REJECTED on evidence, and must not be
> implemented.** These builds are not reproducible: BuildKit stamps `created` into the image config,
> so building the same tree twice yields two different digests (`:0.66.1` went out twice, with two
> digests, which is how this was discovered). A `v*` tag build would therefore republish `:X.Y.Z`
> under a **new** digest and invalidate the `@sha256` pin the release had just made — turning the one
> mechanism that protects existing installs into the thing that breaks them, on every single release.
>
> What was done instead: `build-image.yml` deliberately does **not** build on `v*` tags, and
> `verify-release-tag.yml` runs on the tag to compare the pinned digest against what the registry
> actually serves, publishing nothing. The `@sha256` pin in `docker-compose.yml` — not tag
> immutability — is what makes a release identifiable. DISPLAY-010's *diagnosis* stands; only its
> prescription does not.

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

---

## 9. The standalone Raspberry Pi screen — four things only you can decide

A Pi installed with `pi.sh` runs with no OpenMasjidOS behind it, which moves two things that the
platform used to hold: the TLS in front of the panel, and the provenance of an update. Neither is a
bug in what was built; both are **trust decisions that are now ours** and were the platform's, so
they belong here rather than in a changelog.

### 9.1 The standalone panel is plain HTTP, and a password crosses the LAN in the clear

`createPiPanel` is served by `http.createServer` on port 80 (`server/src/pi/index.ts:1850`). There
is no TLS, so the admin password typed at first run, the session cookie, and any camera credentials
pasted into **Sources** are readable by anything on the masjid's network. The cookie's `Secure` flag
is already decided per request (`isSecureRequest`), so it is simply never set here.

This is the same posture as the camera's own web interface and the router's, and it is **LAN-only**
— nothing is exposed to the internet. A managed screen does not have this problem, because the
platform terminates TLS in front of it.

**It cannot be fixed by just turning TLS on.** No certificate authority will issue a certificate for
`192.168.1.42`, so the options are a self-signed certificate (a browser warning at first run, every
time, which teaches a volunteer to click through warnings) or nothing. **Your call**, and the honest
third option is to leave it and say so plainly in the documentation, which
[PI_STANDALONE.md](../PI_STANDALONE.md) now does.

### 9.2 An update is authenticated by GitHub alone

`update.sh` downloads the release bundle and checks it against `SHA256SUMS` **published in the same
release**. That stops a corrupted download and a tampering network, and it does **not** stop anyone
who can publish a release to this repository — they would simply publish matching checksums.

So the trust chain for software that auto-installs on every standalone screen is: GitHub's TLS, and
the account security of whoever can cut a release here. Today that is one person.

The step up is a signature the installer can verify against a public key baked into it — `minisign`
or `cosign` — which separates "can publish a release" from "can sign a release". That is real
key-management work and a real way to brick every screen if the key is lost, so it is a decision,
not an obvious yes. **Until it is made, treat the release-publishing credentials for this repository
as equivalent to root on every standalone screen**, and keep 2FA on that account.

### 9.3 Every standalone screen tells GitHub it exists, a few times a day

One unauthenticated call to `api.github.com` per update check, from the masjid's own IP address. No
identifier, no masjid name and nothing about the screen is sent — but the IP and the timing are
visible to GitHub, and to anyone watching the masjid's outbound traffic, as "this building runs
OpenMasjidDisplay". Worth stating rather than fixing; a masjid that minds can block it and update by
re-running the installer.

### 9.4 ~~A standalone screen that loses Wi-Fi needs someone to stand next to it~~ — DONE

The standalone panel now has the Wi-Fi page, through the same control spool a server-managed Pi
uses and with the same component in the panel. One thing about it is worth knowing rather than
re-deciding:

**A standalone join is never "verified", and that is correct.** Root proves a join worked by
fetching something from the display server over `wlan0`, and rolls the join back if it cannot —
the safeguard that stops a screen stranding itself on a guest VLAN. A standalone screen has no
server to fetch from, so root reports `unverified` and the new IP address instead, and does not
roll back. Rolling back there would make Wi-Fi unusable on exactly the screens that most need it.

The panel words that outcome differently for a standalone screen: it leads with the new address,
because this panel is served BY the screen, so a join is what changes where the admin types to
reach it. The managed wording ("leave the cable in") is about a dashboard elsewhere staying
reachable, which is not the situation here.

**The route is Wi-Fi only, on purpose.** `reboot`, `update`, `reinstall` and the root terminal are
all verbs this device's spool will act on, and all of them would be reachable the moment that route
forwarded whatever it was given. A test asserts each one is refused.

### Already decided, recorded so it is not re-litigated

- **The setup code is rate-limited** by the same `LoginLimiter` as the password, so the 8 digits
  cannot be walked. An unclaimed screen stays claimable indefinitely by design: it is showing the
  code on a television in the room, and expiring it would strand a screen nobody got to in time.
- **The updater refuses rather than risks.** Unreachable GitHub, a release with no bundle, missing
  checksums, bytes that do not match, an archive that will not unpack — every one leaves the screen
  on the version it has. A screen that keeps showing yesterday's software is a screen showing
  today's prayer times.
- **The agent still cannot write `/opt`.** Updates run as a separate root unit, exactly as on a
  managed screen.

### 9.5 ~~Adoption is a one-way door for the admin~~ — the status page is DONE, the un-adopt button is not

**An adopted Raspberry Pi now serves a read-only status page** (`pi/managedPanel.ts`), decided by
Hasan on 2026-10-16. Verified on hardware: adopted, port 80 answers 200; the local server was then
killed, and ~105 seconds later the page reported *not in contact* with the time of last contact,
while the screen kept drawing and the panel stayed up. That is the day this exists for.

It is a SEPARATE handler rather than the standalone panel with its writes disabled, so nothing that
writes is registered at all — a test reads the file and asserts it contains no writer. It is
unauthenticated on the LAN, because a Pi installed from a server never had a local password and
demanding one would lock an admin out of precisely the screens that need this page; the payload is
therefore held to what the television already shows anybody in the room, and `content` is a KIND
(`timetable`/`camera`/`off`) rather than an id, because a camera's name can carry a room name and
its URL carries a password.

**Still outstanding: an un-adopt button on that page.** Returning to standalone means clearing
`SERVER` from `trust.env`, which only root can write, so it needs a spool verb. That verb would be
far narrower than §11.2's — it only ever CLEARS, so the worst it can do is make a screen
standalone — but it is still a new member of the closed set, and §9.6 applies: it must write
`CHANNEL` and `VERSION` too, or the screen silently stops updating.

Two decisions sit behind fixing it, both written up in
[`../PI_STANDALONE_DESIGN.md`](../PI_STANDALONE_DESIGN.md) §11:

- **A "join a server" button in the standalone panel cannot be built as things stand.** It would
  need root to fetch and run a script from an address the unprivileged agent supplied — the exact
  inversion of what makes the existing `reinstall` verb safe, which takes its address from the
  root-owned `trust.env`. On the brief's stop-and-ask list. Three options are set out there; the
  recommendation is to leave it and keep documenting `curl … | sudo sh`.
- **A read-only status page on an adopted Pi** needs a call on what it shows without a login,
  since a server-installed Pi never had a local password, and an un-adopt button on it would need
  a new (clear-only, therefore narrow) spool verb.

Nothing here is a regression: an adopted Pi has never served a panel. It is written down because
the measurement made the cost concrete and the brief asks for the page.

### 9.6 Un-adopting by hand silently stops all updates

Clearing `SERVER` from `trust.env` by hand leaves no `SERVER` and no `CHANNEL`, so the updater
exits with *"nothing to update from"* and the screen receives nothing again, for ever, while
looking perfectly healthy. Re-running `pi.sh` is the supported route and writes both back. The
documentation now says so, and any un-adopt feature must do the same rather than just clearing a
field.

### 9.7 Security sweep, 2026-10-16 — what it found and what was fixed

A pass over the whole app, not just the Pi. `npm audit` is clean at `--audit-level=low` in both
packages. The unauthenticated route surface was enumerated and every entry is deliberate:
`/api/{login,logout,session,setup}`, `/healthz`, the PIN-gated volunteer page, the public widget,
and `/fabric/commands/run` (secret + caller-header authenticated). No authorisation gap was found.
No log call anywhere in the server writes a secret — the one match was the word "token" inside an
English sentence.

**Two real findings, both fixed in the same commit:**

1. **An uploaded file was served without sandboxing headers by four routes out of five.** An
   uploaded image may be an SVG, which is a script container: served with its real type and opened
   directly it runs in this app's origin. `api.ts`'s announcement-thumbnail route had the sandbox
   CSP *and a paragraph explaining why*; the Pi agent's asset route, the browser screen's asset
   route and a standalone Pi's own preview did not, and the volunteer page had a third hand-written
   copy that had already drifted (it omitted `media-src`). Now one `UPLOAD_HEADERS` constant in
   `httpio.ts`, used by all five, with a test that fails if a sixth caller appears without it.

   Severity is modest and worth stating plainly: uploading requires an admin session and the asset
   routes require a session or a device token, so this is admin-to-admin rather than a way in. It is
   fixed because the project already decided stored SVG is active content — `fabricTimetable.ts`
   refuses it outright by magic bytes — and four routes had not got the message.

2. **The standalone updater used a GitHub release tag unvalidated.** `update.sh` took `tag_name`
   straight from the API response into a URL, a filename, and — through `record_version` — the
   replacement half of a `sed` expression writing `trust.env`, **which update.sh sources as root on
   its next run**. A tag carrying a quote leaves that file unbalanced; one carrying `;` leaves a
   command in it. Publishing a tag needs repository write access, so an attacker who could use this
   could already ship a malicious bundle — but it needed no attacker at all: `release/1.0` is a tag
   git accepts and would have corrupted the file on the first update. Now an allowlist of the
   characters our tags use, plus refusals of a leading dash and of `..`, with seven hostile tags
   pinned in `update.test.sh` and each watched to pass when the guard is removed.

**Not a finding, recorded so it is not re-investigated:** `server/src/pi/panel.ts` keeps its own
`SECURITY_HEADERS` rather than importing the server's. It is not a drifted copy — it sends
`x-frame-options: DENY` where the server sends `frame-ancestors 'self'`, which is stricter. Only
the comment claiming it mirrored the server was wrong, and that has been corrected.

### 9.8 Two words on an Arabic screen are still English, and translating them is a content decision

Found by pointing a capture card at the Pi's HDMI and actually looking, which is the only way this
class of thing gets noticed: every string is individually plausible.

Two were fixed on sight (the Simple table header read “الصلاة TIMES”; the next-prayer ring printed
the Arabic name twice). **This one is not fixed, because it is not mine to decide.** The countdown
on both designs reads, in Arabic:

    2 HOURS 52 MINUTES UNTIL الأذان

`HOURS`, `MINUTES` and `UNTIL` have no entry in the label table (`PRAYER_LABELS` carries prayer
names and a handful of words, and none of those three). Adding them is not a matter of looking up
three words:

- **Arabic counted nouns are grammatical, not just plural.** 2 takes the dual, 3–10 takes the
  plural, 11 and above takes the singular. “2 ساعات” is wrong where “ساعتان” is right, and a
  masjid reading a grammatically wrong countdown off a wall all day is worse than one reading an
  English word it already recognises.
- The layout reserves width per string (`approxWidth` over-estimates, and letter-spacing is in
  constant px), so longer words may need the countdown re-fitted.

**What is needed:** the correct Arabic and Urdu forms for hour/hours, minute/minutes and “until”,
including the counted-noun rules, from somebody who speaks them. Then it is a small change to
`countdownText` and the label table, with the golden fixtures regenerated for the Arabic and Urdu
shots only.
