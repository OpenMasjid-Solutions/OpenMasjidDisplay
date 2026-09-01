<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Contributing to OpenMasjid Display

Thanks for helping! A few ground rules.

## Branch: work on `dev`, never on `main`

This repo runs **two channels**, and they are not interchangeable:

| branch | version         | CI publishes                  | installed by                 |
| ------ | --------------- | ----------------------------- | ---------------------------- |
| `dev`  | `X.Y.Z-dev.N`   | `:X.Y.Z-dev.N` **and** `:dev` | the OpenMasjidOS dev channel |
| `main` | `X.Y.Z`         | `:X.Y.Z` **and** `:latest`    | every masjid (stable)        |

**Branch from `dev` and open your pull request against `dev`.** A push to `main` publishes the container
image every masjid installs, so `main` only ever moves as a deliberate release by a maintainer. A PR
against `main` will be asked to retarget. (Dependabot is configured the same way — every entry sets
`target-branch: dev`.)

CI enforces the difference: the `channel` job fails if `docker-compose.yml` references a dev image on
`main`, an un-pinned image on `main`, or a stale/moving tag on `dev`. Don't "fix" a red `channel` job by
relaxing the check — it is guarding what a masjid installs.

## Note your change in the changelog

`CHANGELOG.md` has an **`## Unreleased`** section at the top. Add a line there describing your change in
plain language — what a masjid admin would notice, not the implementation. Every change gets an entry:
fixes, small behaviour changes, and internal work all count, because that section is also how the next
release is written.

Released sections below it are different: they carry only the changes worth telling a masjid about. A
maintainer condenses `Unreleased` into one when cutting the release, so write your entry for a reader, and
don't worry about which half of it survives.

The panel serves this file as "What's new" (it ships inside the image), so keep it readable: no ticket
numbers, no commit hashes, no internal jargon.

## Licensing

This project is licensed **AGPL-3.0-only** (see [`LICENSE`](LICENSE)) and contributions are
governed by the **Contributor License Agreement** ([`CLA.md`](CLA.md), the canonical text). By
submitting a contribution you agree it is licensed under **AGPL-3.0-only**, you certify the
[Developer Certificate of Origin](https://developercertificate.org/) (the work is yours to
contribute), and you accept the CLA. Sign your commits off:

```
git commit -s -m "..."
```

**Signing the CLA.** You sign **once**, automatically, on your first pull request: the CLA bot
comments with a link to [`CLA.md`](CLA.md) and asks you to reply with the exact sentence

> I have read the CLA Document and I hereby sign the CLA

The CLA keeps the public tree AGPL-3.0 while letting OpenMasjid-Solutions also offer
commercial/dual licenses; you keep your copyright. If you cannot accept the relicensing grant
(§2 of the CLA), say so in your PR and we'll take it AGPL-only or discuss.

## Code

- Keep it **AGPL-3.0-only** — every source file carries an SPDX header
  (`// SPDX-License-Identifier: AGPL-3.0-only`, in the right comment syntax for the file type), followed by
  `Copyright (C) 2026 OpenMasjid-Solutions`. Add one to new files; never remove or alter an existing one.
- Never add code, assets or dependencies under a licence incompatible with AGPL-3.0. In particular, never
  copy from umbrelOS / `umbrel-apps` (PolyForm-Noncommercial) — reimplement from behaviour.
- Match the surrounding style; UI follows the OpenMasjidOS design language
  (dark default, WCAG AA, RTL-ready, honors `prefers-reduced-motion`).
- Don't weaken the security invariants noted in the code (stream-scheme allowlist, ffmpeg's
  `-protocol_whitelist` and array-form `spawn`, audience-bound tokens, scrypt + constant-time compare,
  server-to-server SSO verification, the `/api/setup` guard under a reachable platform).
- There are **two kinds of inbound** Fabric route and they are **not** the same trust boundary. Both
  authenticate the same single way — the caller presents our OWN `OPENMASJID_APP_SECRET` back to us,
  constant-time compared — and everything else about them differs. The shared primitives live in
  `server/src/fabricInbound.ts`; what they must never share is a handler or a caller rule.
  - `POST /fabric/commands/run` — the **platform** calling us, with no session cookie. It is the only
    inbound route that can **write** prayer times. It requires **both** the secret **and**
    `X-OpenMasjid-Caller-App: omos:platform` (a value no app id can be — the colon is outside the
    app-id charset). Never accept one header alone. It is registered at that exact path only, *and*
    refuses any request carrying `x-forwarded-*`, because the router derives the path with `new URL()`
    which normalises `/display/../fabric/commands/run` straight onto it.
  - `POST /fabric/timetable/{list,get,logo}` — **another app** reading this masjid's prayer times and
    logo through the app-to-app broker (the `timetable` capability in `manifest.yaml`'s
    `fabric.provides`). Read-only, and asserted so by a test that reads the module. The secret is the
    authentication; the **path** is the authorisation, because the broker maps
    `…/app/display/<capability>/<method>` onto `/fabric/<capability>/<method>` — so never keep a second
    copy of the platform's grant list here. The caller id is checked for **shape only** and is not a
    security control. LAN-only is enforced by comparing the **raw request line**, not by refusing
    forwarding headers: the broker *is* a proxy, so that test would kill the route silently on a real
    box. See `docs/USING_THE_FABRIC.md` §8.
- WhatsApp messages are **queued, never sent** — nothing may report delivery — and message bodies, captions
  and image data are never logged.

## Run it locally

```bash
cd server && npm ci && npm run build && npm test
cd web    && npm ci && npm run build
```

For a live loop, run the server with `MEDIAMTX_MANAGED=no` (so it won't launch the bundled MediaMTX)
alongside your own `mediamtx`, and `cd web && npm run dev` — the Vite dev server proxies `/api` and `/ws`
to the server.

## Before you open the PR

Everything below is what CI runs, so running it first saves a round trip:

```bash
cd server && npm run build && npm run typecheck:tests && npm test
cd web    && npm run build && npm audit --audit-level=high
```

- `npm run build` (server) compiles, but **deliberately excludes `*.test.ts`** — the tests are never emitted
  into the image. `npm run typecheck:tests` is what typechecks them; the runner (tsx) strips types without
  checking, so without it a broken test can still pass.
- `web`'s `npm run build` is `tsc --noEmit && vite build`, so it typechecks as well as bundles.
- New behaviour wants a test. The server suite is plain `node:test` — no framework to learn.
