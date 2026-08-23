<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# CLAUDE.md — OpenMasjidDisplay

> Single source of truth for the **OpenMasjidDisplay** app. Read it before writing any code.
> When in doubt, follow this document and the existing code over your own assumptions; if
> something is ambiguous, ask before guessing.

---

## 0. Branching policy — check this before your first edit

**This repo has two branches and they are not interchangeable. `main` is what every masjid
installs.**

**Session-start check — run it before changing anything:**

```sh
git branch --show-current      # must print: dev
```

If it prints anything else, `git checkout dev` first. Do not start work until it says `dev`.

### The rules

1. **All development happens on `dev`.** Every feature, every fix, every experiment, every
   docs change — this session and every future one.
2. **Never commit to `main`.** Not directly, not "just this once", not for a one-line docs
   typo, not for a hotfix.
3. **Never merge, rebase onto, or cherry-pick into `main` autonomously.** Not for a Critical
   security finding — that is what a fast `dev` → *"merge to main"* turnaround is for.
4. **`main` moves only when Hasan says the words "merge to main."** Nothing else authorises
   it: not a green CI run, not an urgent-looking bug, not an inference that he'd obviously
   want it.
5. **That merge is a release**, not a merge. It carries the full release chain in §5 below.

### The push protocol — every turn, without being asked

Work on `dev`, push to `dev`, and then **ask**:

> After finishing a piece of work and pushing it to `dev`, **end the reply by asking whether to push to
> `main`.** Keep working and keep pushing to `dev` for every following request. Do not push to `main` — and do
> not stop asking — until Hasan replies **"push to main"** (or "merge to main").

So the loop is: change → commit on `dev` → push `dev` → *"Do you want me to push this to `main`?"* → carry on
on `dev`. The question is a prompt for a decision, never permission you can assume you already have: an
unanswered ask, or silence, means the answer is still no. When the answer does come, treat it as the release
in §5 — not a fast-forward of `main`.

Dependabot is wired the same way: every entry in [`.github/dependabot.yml`](.github/dependabot.yml) sets
`target-branch: dev`, so automated bumps arrive where work belongs instead of as PRs against a branch nobody
may merge into.

### Channels: `dev` and `main` are wired to different images

OpenMasjidOS has an Update Channel toggle, and the dev catalog resolves this app from the
`dev` branch. So the branch you are on decides which image real devices pull:

| branch | `manifest.yaml` version | compose references            | CI publishes                   | who installs it              |
| ------ | ----------------------- | ----------------------------- | ------------------------------ | ---------------------------- |
| `dev`  | `X.Y.Z-dev.N`           | `…:X.Y.Z-dev.N`               | `:X.Y.Z-dev.N` **and** `:dev`  | the OpenMasjidOS dev channel |
| `main` | `X.Y.Z`                 | `…:X.Y.Z@sha256:<digest>`     | `:X.Y.Z` **and** `:latest`     | every masjid (stable)        |

### Dev builds must carry a real version — this is not cosmetic

**Every dev build gets its own version: `X.Y.Z-dev.N`,** where `X.Y.Z` is the release being
worked toward and `N` increments on every dev build you publish. If stable is `0.66.1`, dev
is `0.67.0-dev.1`, then `-dev.2`, and so on. When that work ships, stable becomes `0.67.0`
and dev moves to `0.68.0-dev.1`. **A dev version must never equal a stable one.** Ordering
is `0.66.1 < 0.67.0-dev.1 < 0.67.0` — ahead of the last release, behind the next.

Why it matters: **OpenMasjidOS detects an update by comparing the catalog's `version` with
the installed one.** A moving `:dev` tag republishing new content under an unchanged version
string changes nothing observable, so the platform cannot notify anyone and has nothing to
update to. That is exactly why the dev channel silently did nothing before 0.67.0-dev.1.
So `N` must be bumped for a dev build to reach anybody — an unbumped dev push is a no-op as
far as the platform is concerned.

The version therefore drives everything:

- CI tags the image with the **exact** `manifest.yaml` version, so the catalog can pin an
  immutable tag. `:dev` is still published as a convenience alias, and is never what the
  catalog pins.
- `docker-compose.yml` must name that same version, **for every service** — not just the
  primary one. A single un-updated `image:` line means the dev channel installs something
  other than this commit.
- Bump the version and the compose reference **together**, in the same commit.

### Enforcement, and the merge hazard

**`docker-compose.yml`'s `image:` line is the only file that differs between the branches**,
which makes it the one thing a careless merge breaks. The `channel` job in
[`.github/workflows/checks.yml`](.github/workflows/checks.yml) fails the build in every
direction that matters:

- a dev image (`:dev` or any `-dev.` tag) on `main`, or a `main` image not digest-pinned;
- a prerelease version on `main`, or a non-prerelease version on `dev`;
- a compose tag on `dev` that doesn't match `manifest.yaml` — stale **or** the bare `:dev`;
- any of the above on a **secondary** service, not only the first.

[`build-image.yml`](.github/workflows/build-image.yml) re-checks the version format before
it pushes anything, because the failure it prevents is silent: a dev build whose version
lost its `-dev.N` would publish `:X.Y.Z` **over the stable release tag of that name**.

Don't "fix" a red `channel` job by relaxing the check.

Also: after pushing to `dev` the image takes a few minutes to build, and the dev catalog
pins an exact tag. If the catalog is rebuilt inside that window it pins a tag that does not
exist yet and a masjid on Development gets a pull failure. Let the build finish before the
catalog picks the commit up.

### On "merge to main" — the release chain

Only when Hasan has said it. In order:

1. Bump the version — **7 fields across 5 files**: `manifest.yaml`, `server/package.json`,
   `web/package.json`, and **both `package-lock.json`s, which each carry it twice** (the root object
   and the `packages[""]` entry). Miss a lockfile and `npm ci` reports a version the release isn't.
   Don't count them by hand; the list is exactly what this prints, and it must come back empty
   afterwards:

   ```sh
   grep -rn "<old version>" --include='*.json' --include='*.yaml' --include='*.yml' . \
     | grep -v node_modules | grep -v /dist/
   ```

   It also lists the compose `image:` reference — the eighth place, and the one that is *not* a
   "version field" (hence the miscount this line used to carry: it said six). Do **not** update
   that one here; it is replaced whole at step 3, once the digest exists.
   Going to stable means **dropping the `-dev.N` suffix**: `0.67.0-dev.4` → `0.67.0`. Turn the
   `## Unreleased` section into the `## X.Y.Z` section per §0b below — a test asserts the newest
   released section matches the running version, so a forgotten entry fails the build rather
   than shipping silently.

   Merge `dev` → `main` carrying that bump. `docker-compose.yml` is the one file that conflicts,
   by design; resolve it to `main`'s form and **leave the PREVIOUS release's reference completely
   intact — tag and digest together**, e.g. keep `:0.66.1@sha256:<0.66.1's digest>` untouched
   while `manifest.yaml` already says `0.67.0`.

   That looks inconsistent and is deliberately so: it is *accurate*. The pair names the image
   that is actually pinned. The `channel` job only requires main to be digest-pinned and
   non-prerelease, so it passes. **What you must never write is a new tag beside an old digest**
   (`:0.67.0@sha256:<0.66.1's digest>`) — that pairing is a lie, and it is the exact bug in the
   box below. Replace the whole reference in one go at step 3, once the real digest exists.
2. **Push `main` and let CI publish the image.** Then fetch the **manifest-list** digest of the
   published image (not a per-arch one — a per-arch digest pins amd64 only and breaks every Pi).

   `main` is the **only** publisher of a stable image: `build-image.yml` deliberately does not
   build on `v*` tags. It must not, because these builds are **not reproducible** — BuildKit
   stamps `created` into the image config, so rebuilding an identical tree yields a different
   digest (`:0.66.1` went out twice, with two digests). A tag build would therefore republish
   `:X.Y.Z` over the digest pinned at step 3 and invalidate it on every single release.
3. **Commit the real `@sha256` pin to `docker-compose.yml`.** That commit must touch compose and
   nothing else: `build-image.yml`'s `paths-ignore` excludes it, so it publishes nothing and
   cannot invalidate the digest it just pinned. Confirm no `Build image` run appears for it.
4. **Tag `v<version>` at the digest-pin commit from step 3 — not the commit before it.** The
   release commit and the digest-pin commit are adjacent, and tagging the release commit "because
   that's the release" is off by exactly one. That parent is the commit whose compose still names
   the *old* digest, so the tag ends up on the one tree in the whole repository that is wrong.

   Tag it explicitly rather than relying on where `HEAD` happens to sit:

   ```sh
   git tag -a v<version> <digest-pin SHA> -m "…"     # not `git tag v<version>` on a stale HEAD
   git rev-list -n1 v<version>                        # must print the digest-pin SHA
   ```
5. Propose the catalog change in **OpenMasjidAPPS** — §0c below, which is a PR against its `dev`,
   never a push to its `main`.

> ### ⚠ Tag the digest-pin commit, not the commit before it
>
> **The tag must point at a commit whose `docker-compose.yml` already carries the digest of the
> image that version publishes.** Tag earlier and the tag advertises the new version number over
> the *previous* release's bytes, so anyone who pins the tag ships the wrong code under the right
> name. **This has now happened three times** — most recently `v0.67.0`, whose tagged commit
> carries `@sha256:3a789623…`, which is 0.66.1's image.
>
> Note the shape of the mistake: it is **off by one commit**, not off by a step. The release
> commit — the version bump, the merge, the changelog — *feels* like the thing to tag, and it is
> the immediate parent of the digest-pin commit. Tag it and everything looks right: the tag exists,
> the version matches, the image is fine. The only thing wrong is the digest one commit further
> down. So the check is not "did I tag after publishing" but **"does `git rev-list -n1 v<version>`
> print the digest-pin SHA?"**
>
> The third time was this file's fault: the chain used to say *"the digest doesn't exist yet — use
> the previous release's temporarily"*, tag at step 3, and repin at step 5. Following it exactly
> produced the bug. The order above is the fix — **publish, pin, then tag** — and there is no
> "temporarily" any more. If you find yourself typing a digest you did not just read out of the
> registry for *this* version, stop.
>
> Check the local tag **before** pushing it — after the push the image is already published under
> it, and a red CI run is all that is left to tell you:
>
> ```sh
> git rev-list -n1 v<version>                                              # the digest-pin commit?
> git show v<version>:docker-compose.yml | grep -oE 'sha256:[0-9a-f]{64}'  # must equal…
> # …the digest GHCR serves for :<version>
> ```
>
> `verify-release-tag.yml` asserts the same thing on every `v*` tag — it compares the digest
> pinned in the tagged tree against what GHCR actually serves for that version, and fails when
> they differ. It builds and publishes nothing, so pushing the tag cannot disturb the pin. It is a
> backstop, not the guard: getting the SHA right at `git tag` is the actual fix, and the local
> check above costs nothing.

Every push to `main` republishes `:<version>` and `:latest`, so a published version tag is
**not** immutable (DISPLAY-010, [`docs/audit/ACTION_REQUIRED.md`](docs/audit/ACTION_REQUIRED.md)
§4). The `@sha256` pin is the only thing protecting existing installs. Never remove it.

Then return to `dev`, merge `main` back, restore compose to the **dev** form (the merge carries
main's digest-pinned line across), set the next prerelease (`0.68.0-dev.1`) across the same 7
fields plus the compose reference, re-open an empty `## Unreleased` in `CHANGELOG.md`, and keep
working there.

That last step is not tidying. **OpenMasjidAPPS only accepts a dev entry that is at or *ahead of*
the stable release**, so a `dev` branch left behind the version it just released makes the dev
catalog silently fall back to stable — the dev channel stops testing anything while looking
perfectly healthy.

---

## 0c. The catalog is somebody else's `main` — you may only propose

Publishing the image is not the release. **OpenMasjidOS installs from `catalog.json` in
[OpenMasjidAPPS](https://github.com/OpenMasjid-Solutions/OpenMasjidAPPS), and stable moves only
through a catalog release run by a catalog maintainer.** That repo has its own branching policy,
and it is not ours to override — being told "merge to main" *here* authorises nothing there.

**What we may do — and the whole of it:**

Open a **pull request against `OpenMasjid-Solutions/OpenMasjidAPPS`, base branch `dev`**, changing
**only this app's own entry** in `registry.yaml`:

```yaml
  - id: display
    ref: v0.67.0                                       # the tag just published — the human label
    commit: <40-char SHA of the TAGGED commit>         # what is actually fetched
```

- `commit:` is what the catalog builder fetches; `ref:` is only a label for humans. Get it with
  `git rev-list -n1 v<version>` — and if §0 step 4 was done right, that **is** the digest-pin
  commit, which is the whole point of tagging that commit rather than its parent.
- **If `ref:` and `commit:` ever disagree, pin the commit that carries the correct digest**, and
  say so in the PR. A wrong `commit:` ships the wrong build to every masjid; a stale `ref:` is
  only a mislabel. (That is the state `v0.67.0` is in: `commit:` names the digest-pin commit,
  `ref:` names a tag one commit behind it.)
- Touch no other app's entry, and never hand-edit `catalog.json` — it is generated, and
  `build-catalog.yml` regenerates and commits it per channel.

**Then stop.** Do not push to the catalog's `main`. Do not merge the catalog's `dev` into its
`main`: the two branches legitimately hold **different builds of `catalog.json`** (dev channel vs
stable channel), so merging them is not a fast-forward of the same content — it publishes dev
builds to every masjid. A catalog maintainer runs the release that moves `main`.

Until that happens, **the stable catalog keeps serving the previous version**, and that is the
correct state to report — "released" means the tag and image exist, not that masjids are being
offered it.

### The dev channel needs none of this

`registry.yaml`'s `dev_ref: dev` tracks our `dev` branch on its own and rebuilds hourly (plus
whenever `build-image.yml` dispatches a rebuild). Nothing has to be proposed, reviewed or merged
in the catalog for a dev build to reach the people who opted into it. Two things are required of
us, and they are the ones in §0's dev rules:

1. keep the prerelease version (`X.Y.Z-dev.N`) and the version-tagged image current, and
2. **publish the image before pushing the version bump** — the catalog pins an exact tag, so an
   entry that lands before its image exists is a pull failure on a real masjid's screen.

---

## 0b. The changelog has two audiences — write for both

`CHANGELOG.md` ships **inside the image** (the Dockerfile copies it, `/api/changelog` parses it,
and the panel's account menu renders it as *"What's new"*). So it is not a developer artefact:
a masjid admin whose app was updated in the background by OpenMasjidOS reads this file to find
out what changed. That is the whole reason it exists offline.

Two sections, two jobs, and **they are not written to the same standard**:

### `## Unreleased` — on `dev`, and it is the working log

The top section is always `## Unreleased`. **Every dev change gets an entry there, not just the
notable ones** — fixes, small behaviour changes, dead code removed, a CI gate added, a doc
correction. Write it when you make the change, in the same commit, in plain language. Be
specific: *what changed, and what someone would notice.* "Fixed a bug" is not an entry.

Why everything, when the release only tells the headline story: the section IS how the release
notes get written. A change that was never written down is a change nobody remembers at release
time, and the alternative — reconstructing three weeks of work from `git log` while cutting a
release — is exactly how a real fix goes unmentioned and an admin never learns their problem
was solved.

### `## X.Y.Z` — on a release to `main`, and it is **major changes only**

When Hasan says *"merge to main"*, the `## Unreleased` section is **condensed** into the new
`## X.Y.Z` heading. Keep only what a masjid would actually want to be told: new features,
behaviour they will see on a screen or in the panel, fixes to things that were visibly wrong,
security fixes worth naming. Drop the internal detail — refactors, test scaffolding, CI
plumbing, comment corrections, dead code.

This is a **rewrite, not a copy**. Several `Unreleased` lines usually collapse into one sentence
about the thing they add up to. The released section is read by someone standing in a masjid
office wondering whether to click Update, and a wall of internal churn buries the one line that
answers that.

**Rules that hold for both:**

- Newest section first; `## Unreleased` above every released section.
- No ticket numbers, commit hashes, branch names or internal jargon — an admin is reading it.
- Never rewrite a released section after it ships; a masjid running that build reads it as-is.
- After the release, open a fresh empty `## Unreleased` on `dev`.
- The parser (`server/src/changelog.ts`) is deliberately small and covers only the constructs
  this file already uses: `##` headings, `-`/`*` bullets, plain paragraphs, and `###` subheadings.
  Its tests parse the **real** file, so an exotic construct fails the build rather than silently
  vanishing from the panel.

---

## 1. What we are building (one paragraph)

**OpenMasjidDisplay** is an app for
[OpenMasjidOS](https://github.com/OpenMasjid-Solutions/OpenMasjidOS) that drives the screens in a
masjid: prayer timetables, camera feeds, and HDMI output over **RTSP**. It runs as **one Docker
container** (a `server/` + `web/` split), is configured via the platform, looks and feels like the
rest of the OpenMasjid family, and is the **reference implementation** that other OpenMasjid apps
(e.g. OpenMasjidDonations) copy their structure from.

---

## 2. Licensing & headers — non-negotiable (read first)

This repository is **AGPL-3.0-only** and **every contribution is bound by the Contributor License
Agreement** ([`CLA.md`](CLA.md), enforced by [`.github/workflows/cla.yml`](.github/workflows/cla.yml)).
**This is a hard rule for all future work** — *every line written here is AGPL-3.0 and CLA-covered:*

- **Every new source file MUST begin with the SPDX header**, in the right comment syntax for its type,
  followed by `Copyright (C) 2026 OpenMasjid-Solutions`:
  - `.ts` / `.tsx` / `.js` / `.cjs` / `.mjs` / `.css`: `// SPDX-License-Identifier: AGPL-3.0-only`
  - `.yml` / `.yaml` / `.sh` / `Dockerfile`: `# SPDX-License-Identifier: AGPL-3.0-only`
  - `.md` / `.html`: `<!-- SPDX-License-Identifier: AGPL-3.0-only -->`
- **Never** remove or alter an existing SPDX header.
- **Never** add code, assets, or dependencies under a license incompatible with AGPL-3.0. In
  particular, **never copy from umbrelOS / `umbrel-apps`** (PolyForm-Noncommercial) — reimplement
  from behaviour.
- The CLA keeps the **public tree AGPL-3.0** while letting **OpenMasjid-Solutions** also offer
  commercial/dual licenses; contributors keep their copyright. Contributors sign once, automatically,
  on their first PR (the CLA bot → reply *"I have read the CLA Document and I hereby sign the CLA"*).
- The `manifest.yaml` `license:` field is **AGPL-3.0-only** for this app.
- Include a visible **"Source code"** link to this repo in the admin UI (AGPL §13 network clause).

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full contribution + signing flow.

---

## 3. Structure & conventions

- **`server/`** — the backend (Node + TypeScript): platform single-sign-on + theme/wallpaper
  matching done **server-to-server** (never trusting the browser, with a local-password fallback),
  RTSP/stream handling with a scheme allowlist, least-privilege posture.
- **`web/`** — React + Vite + TypeScript, styled with the OpenMasjidOS design tokens (dark default,
  WCAG AA, RTL-ready, honors `prefers-reduced-motion`).
- One-container `Dockerfile`; `docker-compose.yml`, `manifest.yaml`, `icon.png`, and `screenshots/`
  follow the OpenMasjidAPPS catalog contract (see
  [`OpenMasjidAPPS/docs/BUILDING_AN_APP.md`](https://github.com/OpenMasjid-Solutions/OpenMasjidAPPS)).
- Don't weaken the security invariants noted in the code (stream-scheme allowlist, ffmpeg's
  `-protocol_whitelist` + array-form `spawn`, audience-bound tokens, scrypt + constant-time
  compare, server-to-server SSO verification, the `/api/setup` guard under a reachable platform).
- **Before a PR, run what CI runs** — anything less is a weaker signal than it looks:

  ```sh
  cd server && npm run build && npm run typecheck:tests && npm test
  cd web    && npm run build && npm audit --audit-level=high
  ```

  `server/tsconfig.json` **excludes `**/*.test.ts`** so tests never reach `dist/` or the image,
  which means `npm run build` typechecks none of them — and the runner (tsx) strips types without
  checking. `npm run typecheck:tests` (`tsconfig.check.json`) is the only thing that compiles
  them; it caught a live assertion reading a property that isn't on the type the day it was
  added. `web`'s build is `tsc --noEmit && vite build`, so it typechecks as it bundles.

When this file and the actual code disagree on a mechanism, **read the code and follow it**, then fix
this file.

---

## 4. Security invariants — DO NOT REGRESS (v0.39.0 sweep)

- **First-run `/api/setup` under SSO:** when OpenMasjidOS SSO is configured AND the platform is
  **reachable**, refuse an anonymous local-admin claim (return 403). Under SSO the admin signs in
  through the dashboard and never sets a local password, so `store.db.admin` stays null for the life
  of the deployment — an unguarded `/api/setup` is therefore permanently open = unauthenticated admin
  takeover (attacker can then repoint RTSP sources / reconfigure every screen). The local-password
  path is a recovery ONLY when the platform is **unreachable** (restore/migration/outage). Keep the
  `probePlatform(req).reachable` guard; standalone (no-SSO) behaviour is unchanged.
- **Media pipeline:** keep the stream-scheme **allowlist** (`validate.ts`), ffmpeg's
  **`-protocol_whitelist`** of stream protocols only, and **array-form `spawn`** (never build an
  ffmpeg/gstreamer command by string-interpolating a stream URL) — together those stop SSRF,
  local-file reads and argument injection via a crafted source. The two lists must agree: a
  protocol the app accepts but ffmpeg refuses is a source that saves fine and then silently
  won't play. The whitelist may grow to cover a **stream** protocol, never `file:`/`http:`/`concat:`.
- **SSO is an identity assertion, not a credential** — verify it server-to-server against the
  platform; never trust a browser-supplied identity. Keep the audience-bound tokens, and keep
  **`redirect: 'error'`** on every outbound Fabric fetch — that is the actual SSRF guard there,
  stopping a compromised or misconfigured platform from bouncing us (and our per-app secret) at
  some other internal host. (`isPrivateHost()` next to it is *not* that guard: it only decides
  whether to warn that the secret is crossing a public network in cleartext.)
- Behind the OS proxy you may trust `X-Forwarded-*` **only because the platform's ingress now
  sanitises them** — never trust them when the app is reached directly.
- **`POST /fabric/commands/run` is the only INBOUND Fabric route** (v0.69.0): the platform calling
  *us* to run an admin's WhatsApp command, with no session cookie, and it can write prayer times.
  Three things hold it shut and all three are load-bearing:
  - **Both headers, never one.** `X-OpenMasjid-App-Secret` must equal our own `OPENMASJID_APP_SECRET`
    (constant-time, length-checked first) **and** `X-OpenMasjid-Caller-App` must be exactly
    `omos:platform` — a value no app id can be, since the colon is outside the app-id charset. The
    secret alone is not enough: anything that ever learned it could otherwise drive the wizard.
  - **The exact path only.** Behind the tunnel this app is served under `/<basePath>/…` and the
    platform does not strip the prefix, so a tunnelled request arrives as
    `/display/fabric/commands/run` and matches nothing. *Not registering the prefixed form IS the
    LAN-only enforcement* — there is no header to trust for it. Never add one.
  - **Nothing is written before `save`.** The exchange can end without us (idle, turn cap, an exit
    word, a new `!` command) and we are never told, so a half-answered flow must leave a draft that
    expires, never a partial change.
- **WhatsApp is queued, never sent.** `202 {queued:true}` means accepted for later delivery. The 202
  now carries an `id` and `/api/fabric/whatsapp/status/<id>` answers `queued`/`sent`/`failed`/
  `expired` (OpenMasjidOS **0.51.1+**, advertised as `outcomes` — absent must read as false; per-app
  history from **0.51.1-dev.8**). Even `sent` means "handed to WhatsApp": there is no delivery receipt
  anywhere and nothing may claim one. **A verdict we could not obtain — a 404, a timeout, an older
  platform — is not a failure**; treating it as one re-announces a change the group already has.
  **Keep asking for as long as the platform will answer** (24h, `WA_OUTCOME_WINDOW_MS`): `expired` is
  the verdict that re-opens a retry, and an entry left `queued` reads as *handled*, so giving up early
  strands the announcement silently and for ever.
- **The platform no longer paces us, so this app has to** (0.51.1 removed quiet hours, the caps, the
  cooldowns, the warm-up and the random gap). Ban risk still attaches to the masjid's *number*, it is
  shared by every app on the box, and a blocked number cannot be recovered. What holds here is
  structural and must stay that way: **one approved group and never a per-person send**, one message
  per Iqamah change deduped through the persisted log (where `sent` counts as handled exactly as
  `queued` does, or a confirmed message becomes a duplicate), five attempts thirty minutes apart timed
  from the *verdict*, one post in flight, and **no retry around a 202**. Never add a loop over a
  roster. Nothing auth-critical may ever go this way. Message bodies, captions and image bytes are
  never logged; the app's own log keeps event + group id + timestamp + the change's date + the
  platform's id.
- **Read `media`/`maxMediaBytes` from the platform before rendering a poster**, and never fall back to
  the caption alone: the caption is written to sit under an image and, delivered by itself, is an
  announcement with no timetable in it. Every media failure falls back to the full text notice.
- **An alert that fires on an EXTERNAL failure needs its own floor.** The screen-offline alert is the
  one of these this app has, and the shape is a decoder that FLAPS rather than one that dies: the
  notified flag latches, so a screen that stays down is reported once, but every recovery re-arms it —
  around 950 email-and-webhook pairs a day at a 90-second debounce. The platform gates on whether the
  admin wants that alert type, not on how often it arrives, and the per-recipient cooldown that used
  to absorb this class of thing was removed in 0.51.1. `ALERT_MIN_GAP_MS` in orchestrator.ts floors the
  DOWN alert only — a recovery can only follow a down alert already sent, and suppressing one would
  leave an admin believing a screen is dead. Delay such an alert, never drop it.
- **The Pi terminal is a ROOT shell, and that was a deliberate change.** It used to run as the
  screen's own unprivileged account under `NoNewPrivileges`, which made `sudo` unusable and
  `reboot` impossible — a debugging window rather than a terminal. It is now the whole machine, to
  match what OpenMasjidOS's own dashboard offers. Understand what that means before touching it: a
  stolen dashboard session is root on every screen the masjid owns. Four things hold it shut and
  all four are load-bearing:
  - **The panel mints, the device dials OUT.** Nothing connects to a Pi and no port is opened on
    one. The session is offered on the device’s own state poll and it opens the socket.
  - **The secret never reaches a browser.** `openShellSession` returns it so the API can put it on
    the COMMAND for the device; the panel is given the id alone. Single-use, and a wrong secret
    ends the session rather than allowing another try.
  - **Three clocks, on the server:** 60s to claim, 10 idle minutes, one hour maximum. The agent
    keeps its own backstop (`SHELL_SESSION_MAX_MS`) for a socket that wedges rather than closes.
  - **The spool still names verbs, it does not run strings.** The `shell-session` verb carries a
    session id, a one-time secret and a terminal size — never command text. That distinction is
    what keeps the rest of the closed verb set worth anything, and `piConsole.test.ts` asserts it
    in both directions: `shell` (which DOES carry a string) must never become a root verb, and the
    root terminal's arm must never interpolate a field from its request into a command line.
  Nothing about a session is ever logged — not the keystrokes, not the output, not a sample. The
  one-shot console (`shell`) is deliberately still unprivileged; it is the fallback for a screen
  whose agent is too old to offer a terminal, and the panel says so rather than letting it look
  broken.
