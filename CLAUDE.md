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

1. Bump the version — **6 fields across 5 files**: `manifest.yaml`, `server/package.json`,
   `web/package.json`, and **both `package-lock.json`s, which each carry it twice** (the root object
   and the `packages[""]` entry). Miss a lockfile and `npm ci` reports a version the release isn't.
   Going to stable means **dropping the `-dev.N` suffix**: `0.67.0-dev.4` → `0.67.0`. Add a
   `## X.Y.Z` section to `CHANGELOG.md` for it — a test asserts the newest section matches the
   running version, so a forgotten entry fails the build rather than shipping silently.
2. Merge `dev` → `main`, and in that merge **repin `docker-compose.yml`** from `:dev` to
   `…:<new version>@sha256:<digest>`. The digest doesn't exist yet — use the previous
   release's temporarily, or land the merge and repin in the follow-up commit at step 5.
3. Tag `v<version>` and push it. CI builds multi-arch (amd64 + arm64) and publishes
   `:<version>` + `:latest`.
4. Fetch the **manifest-list** digest of the published image (not a per-arch one).
5. Commit the real `@sha256` pin to `docker-compose.yml` on `main`.
6. Update `registry.yaml` in **OpenMasjidAPPS**: `ref:` = the tag, `commit:` = the SHA of the
   digest-pin commit from step 5. Never hand-edit `catalog.json` — it is generated.

Every push to `main` republishes `:<version>` and `:latest`, so a published version tag is
**not** immutable (DISPLAY-010, [`docs/audit/ACTION_REQUIRED.md`](docs/audit/ACTION_REQUIRED.md)
§4). The `@sha256` pin is the only thing protecting existing installs. Never remove it.

Then return to `dev`, set the next prerelease (`0.68.0-dev.1`) across the same 6 fields plus
the compose reference, and keep working there.

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
- Don't weaken the security invariants noted in the code (stream-scheme allowlist, audience-bound
  tokens, scrypt + constant-time compare, array-form `spawn`, Fabric private-range SSRF guard).
- It must build (`cd server && npm run build`, `cd web && npm run build`) and pass `npm test` in
  `server/` before a PR.

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
- **Media pipeline:** keep the stream-scheme **allowlist** and **array-form `spawn`** (never build an
  ffmpeg/gstreamer command by string-interpolating a stream URL) — that stops SSRF + argument
  injection via a crafted source.
- **SSO is an identity assertion, not a credential** — verify it server-to-server against the
  platform; never trust a browser-supplied identity. Keep the Fabric private-range SSRF guard and
  audience-bound tokens.
- Behind the OS proxy you may trust `X-Forwarded-*` **only because the platform's ingress now
  sanitises them** — never trust them when the app is reached directly.
