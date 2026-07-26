<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Raspberry Pi display nodes — implementation status

Companion to `PI_NODE_SPEC.md`. The spec says what we are building; this says **what exists
in the tree today**, so nobody has to infer it from the code. Update it with each milestone.

As of this commit: **M0 is complete and verified. M1's software is written and tested
off-hardware; the image has never been built or booted. M2–M4 are not started.**

---

## What works today (M0 — no hardware needed)

| Spec area | Where | Notes |
|---|---|---|
| `packages/render-core` extraction | [packages/render-core/](../packages/render-core/) | Pure engine: prayer maths, the SVG builder, palettes, hadith library, Iqamah CSV + schedule. **Pixel parity proven** — 112 hashes across 28 configurations identical pre/post refactor. |
| Purity contract, enforced | [purity.test.ts](../packages/render-core/src/purity.test.ts) | `types: []` + no DOM lib make `process`/`window`/`Buffer`/`node:*` **compile errors**; the test additionally bans `Math.random()`/`Date.now()`/`new Date()`, which the compiler cannot catch, and guards the `export *` barrel against name collisions. |
| `packages/protocol` | [packages/protocol/](../packages/protocol/) | Frame types + validators shared by controller and agent. 20 tests covering round-trips, version negotiation, forward compatibility, hostile input. |
| Node registry | [types.ts](../server/src/types.ts), [store.ts](../server/src/store.ts) | `DB.nodes[]`, `Tv.kind`/`Tv.nodeId`, `Source.nodePlayback`/`videoCodec`, `Settings.piNodes`. Migration is automatic and defensive (a non-array `nodes` is discarded, not trusted). |
| Adopt by IP | [nodeAdopt.ts](../server/src/nodeAdopt.ts) | Private-range-only SSRF guard, cloud-metadata denylist, no redirects, bounded replies, identity cross-checked between the two calls. |
| Token auth | [nodeHub.ts](../server/src/nodeHub.ts) | 256-bit token, stored **only** as a scrypt hash with constant-time compare (same primitives as the admin password). Serial is a lookup key so exactly one scrypt runs per connection attempt; rate-limited. |
| Node hub (`/ws/node`) | [nodeHub.ts](../server/src/nodeHub.ts) | Content push with change-detection, identify/reboot/factory-reset, heartbeat freshness, reconnect supersedes, tunnel path prefix accepted. |
| Single upgrade router | [ws.ts](../server/src/ws.ts) | **Load-bearing:** two independent `upgrade` listeners would each destroy the other's sockets. One router dispatches by path. |
| Orchestrator branch | [orchestrator.ts](../server/src/orchestrator.ts), [nodeContent.ts](../server/src/nodeContent.ts) | Node screens contribute **nothing** to the ffmpeg/MediaMTX working set — the compute win. Direct-vs-relay decisions are a pure, unit-tested function. |
| Offline alerts | [orchestrator.ts](../server/src/orchestrator.ts) | Node liveness = socket + fresh heartbeat, on the same ~90 s debounce and Fabric notify path decoder screens use. Judged independently of MediaMTX reachability. |
| Admin API | [api.ts](../server/src/api.ts) | `/api/nodes/probe`, `/api/nodes/adopt`, `PUT`/`DELETE /api/nodes/:id`, `…/identify`, `…/reboot`. All 404 while `piNodes` is off. Credentials stripped from every response by `publicNode()`. |
| Mock-node acceptance | [nodeHub.test.ts](../server/src/nodeHub.test.ts) | A script speaking only the published protocol is adopted and driven over real sockets, with real scrypt and real frames. |
| Panel | [Screens.tsx](../web/src/routes/Screens.tsx), [Settings.tsx](../web/src/routes/Settings.tsx) | Screen-kind chooser (skipped entirely while the flag is off), the two-step adopt-by-IP flow with image/Etcher instructions, a "Pi node" badge, and a node drawer (model, serial, firmware, address, last seen, temperature, memory, Wi-Fi signal, decodable codecs) with Identify / Reboot / rename / un-adopt. The opt-in toggle lives in Settings. |

`cd server && npm run build && npm test` → **114 passing**. `cd web && npm run build` clean.

Verified live against a running instance, not just by unit test: `/api/nodes/*` is 404 while
the flag is off and 401 unauthenticated; the address guard refuses a public IP and
`169.254.169.254` by name; identify/reboot/delete on a removed node return 404 ("no such
node"), distinct from 409 ("node is powered off"); `/api/state` carries `nodes` with the
credential stripped.

Two bugs this live pass caught that the type-checker could not:
- `statePayload` was silently missing `nodes` (a scripted edit that failed on CRLF), so the
  panel would have shown no nodes forever.
- identify/reboot reported "not connected right now" for a node that did not exist.

One design trap avoided in the panel: `Modal` binds Escape and its Tab trap to `window`, so
nesting a confirmation dialog inside the node drawer would close both on one Escape and make
the two focus traps fight over the same DOM. The removal confirmation is a state of the
drawer instead.

### Container change you must know about

`server/tsconfig.json` now compiles the shared packages in the **same tsc program**, so its
`rootDir` is the repo root and the output is one level deeper:

```
dist/server/src/index.js   ← the entry point (was dist/index.js)
dist/packages/…
```

Kept in step in three places: `server/package.json` `start`, the `Dockerfile` `CMD`, and
`config.ts`'s `SERVER_ROOT` (which resolves `publicDir` — verified to resolve to the same
path as before). The Dockerfile also copies `packages/` into the build stage. This was
smoke-tested by booting the compiled server and checking `/healthz`, `/api/state` (401) and
`/ws/node` (refused while the flag is off) — but **not** by building the image, because
there is no local Docker on the dev box. Watch the first CI image build.

---

## M1 — the device side (software done, hardware unverified)

| Piece | Where | Notes |
|---|---|---|
| `Platform` seam | [platform.ts](../node/agent/src/platform.ts) | Every Pi-specific thing — `/proc/cpuinfo`, `cog`, GStreamer, NetworkManager, reboot, wipe — behind one interface. **This is why M1 could be tested at all:** the real agent runs against the real controller on a dev box with a fake platform. No other agent module may touch `child_process` or `/proc`. |
| Agent state machine | [agent.ts](../node/agent/src/agent.ts) | starting → status_screen → timetable / stream / off. Holds the timetable until the clock is NTP-synced (no RTC on a Pi). |
| Controller client | [controller.ts](../node/agent/src/controller.ts) | Outbound WSS, jittered backoff that never gives up, heartbeats, acks. Ignores unreadable frames instead of disconnecting, so a newer controller cannot knock older nodes offline. |
| Display supervisor | [display.ts](../node/agent/src/display.ts) | Exactly ONE process at a time (512 MB: kiosk ~250 MB *or* player ~120 MB, never both). Crash → restart with backoff → after 5, fall back to a status screen that states the error rather than leaving a black TV. |
| Local API | [localApi.ts](../node/agent/src/localApi.ts) | `GET /api/status` open; `POST /api/adopt` **one-shot**, 409 forever after; `/api/view` loopback-only; everything else bearer-gated. Also serves the kiosk bundle. |
| Kiosk renderer | [node/kiosk/src/main.ts](../node/kiosk/src/main.ts) | Calls the **same `renderDisplaySvg`** the controller rasterizes, so parity is structural rather than reviewed. 56 KB bundle including the whole engine. |
| Asset sync | [nodeAssets.ts](../server/src/nodeAssets.ts), [assetCache.ts](../node/agent/src/assetCache.ts) | The masjid's own background photo and logo, content-addressed: fetched once per change, verified against the hash before being cached, shared between slots, pruned when unreferenced. The controller route is authenticated by NODE TOKEN (not an admin cookie) and the node resolves asset paths against the controller origin it already dials, so it works on a LAN, behind the tunnel and from the cloud alike. |
| Image + CI | [image/](../image/), [image.yml](../.github/workflows/image.yml) | pi-gen stage, systemd units, read-only root, zram, watchdogs, both factory-reset paths, `_omd-node._tcp` advert. |

`cd node/agent && npm test` → **38 passing**, including an end-to-end test where the real
agent is adopted over HTTP by the real `adoptNode`, dials the real `NodeHub`, and is driven
through timetable → stream → off over real sockets.

**The kiosk was rendered in a real browser and looked at**, not just built: a headless
screenshot of the timetable (Arabic shaping, celestial glow, glass cards, countdown ring,
Hijri date, Jumu'ah band) and of the status screen. That retires the biggest render-core
risk — resvg and a browser do not accept identical SVG.

Bugs this pass caught that unit tests could not:
- `index.ts` resolved its version with `require('../../package.json')`, which from
  `dist/node/agent/src/` points at nothing. `require` throws, so the `?? '0.0.0'` fallback
  never ran and **the agent crashed on boot** while all 25 tests passed. Nothing executed the
  entry point. Fixed, and `image.yml` now boots the built dist and asserts the version.
- The status screen printed "Ready to adopt" twice — once derived from `adopted`, once from
  `note`. `note` is now for exceptional states only.

### Still unverified without a Pi (M1's remaining acceptance)

Flash → boot → portal (or Ethernet skip) → IP on the TV → adopt → timetable renders, then
pull the controller's plug and confirm it keeps ticking. Specifically unproven: the pi-gen
build itself, HDMI with the TV off at boot, `v4l2h264dec` hardware decode, `cog` on DRM/KMS,
the `wifi-connect` portal, read-only-root behaviour, and **whether a full-frame SVG re-render
at 1 Hz is fast enough on a Zero 2 W** — the most likely thing to need work.

---

## Deliberate deviations from the spec

1. **`packages/protocol` uses hand-written validators, not zod** (spec §5/§10). `zod`
   imported from `packages/…` cannot resolve — Node walks up from the importing *file* and
   never reaches `server/node_modules`. Every fix (npm workspaces at a new repo root, or a
   per-package install) changes how the Dockerfile installs dependencies, which cannot be
   verified without local Docker. The hand-rolled validators give the same guarantee with
   zero new runtime dependencies and no container risk, in the idiom `server/src/validate.ts`
   already uses. Swapping in zod later is a single-file change — the exported surface is the
   contract. See the DEVIATION note at the top of `packages/protocol/src/index.ts`.
2. **The screen type is `Tv` with `db.tvs[]`**, not `Screen`/`screens[]` as the spec writes.
   Followed the code, per CLAUDE.md §3.
3. **`Tv.kind`/`Tv.nodeId` are not writable through `PUT /api/tvs/:id`** — they are owned by
   the adoption flow, the same way `iqamahYear`/`iqamahSchedule` are owned by their own
   endpoints. A normal screen save can never orphan a node or repoint a binding.
4. **`Source.videoCodec` is learned only from a node's `unsupported_codec` event**, never
   from a request body, so no admin (or compromised SSO session) can force every source to
   be relayed by claiming a codec.
5. **Relay refuses to fight a decoder screen.** Transcoding publishes to `src_<id>`, which is
   the same path a *direct* source's MediaMTX proxy occupies. If an undecodable source is
   also feeding a decoder screen directly, we do **not** start the transcode; the admin gets
   a message naming the fix (set the source to "normalize"). A legacy screen must never
   regress to make a node work.

## Known gaps in what is built

- **The panel has no mDNS discovery picker** (spec §9 step 1 offers one alongside manual
  entry). Typing the address shown on the TV works and is the documented path. The agent side
  is done (the image advertises `_omd-node._tcp`); the controller still needs an mDNS browser.
- **The "Download the node image" button points at the repo's latest release**, which only
  carries a `.img.xz` once `image.yml` has run for a tag — so it 404s until the first tagged
  build.
- `render-core` is **sequential, not re-entrant**: `renderDisplaySvg` writes module-level
  state (`HOT`, `COLON_DIM`, `LIGHTUI`) that `salahHadithView` reads. Fine for one render per
  process (the container's worker, a node's kiosk); do not call it concurrently.

## Not started

**M2** (identify/stream verified on hardware, `docker stats` proof), **M3** (agent OTA
self-update — the agent NAKs `update` explicitly so a controller sees why), **M4** (72 h soak
with hourly power cuts, `PI_NODE_SETUP.md`). Spec §15's open questions remain open; §9's
on-screen confirmation-code hardening is still the v1.1 seam.

---

## Asset sync (the last M1 software gap, now closed)

A masjid's own background photo and logo reach a node addressed by **content hash**, which
buys several things at once: a re-push costs zero bytes, two screens sharing a photo transfer
it once, bytes are verified against the hash before being cached (so a corrupt download is
detected rather than drawn forever on a read-only-rootfs box), and unreferenced files are
pruned so trying five wallpapers does not slowly fill the card.

The asset URL is a **path**, resolved by the node against the controller origin it already
dials for its WebSocket. That sidesteps "what address am I reachable at?" entirely — the
honest answer differs between a LAN install, a tunnelled one and a cloud-hosted controller.

The kiosk is handed a **local URL** rather than a data URI. The controller must inline base64
because resvg only embeds data URIs; a browser fetches `<image href>` happily, and
base64-ing a multi-megabyte photo into the document every second on a 512 MB board would
not end well. Same bytes, same pixels.

### Two bugs this work surfaced, both invisible to the type-checker

1. **The asset route was placed below the admin auth gate.** Every node request 401'd on a
   missing admin cookie, so no node could ever fetch its masjid's logo — while the code's own
   comment claimed it was placed above the gate. Found by driving the real server with curl.
   `nodeAssets.test.ts` now covers it, and that test was validated by reintroducing the bug
   and watching it fail.
2. **Test files were never typechecked.** `tsconfig.json` is the build config and excludes
   `*.test.ts`; tsx does not typecheck. So adding a required `AgentOpts` field left eight test
   call sites silently broken, and a bad `import('node:events')` shape sat unnoticed. Both
   projects now have a `tsconfig.check.json` that includes the tests, run first by `npm test`.

---

## Ports — checked against OpenMasjidOS

`OpenMasjidOS` binds **80:80, 443:443 and 8443-8452** on its host (its `docker-compose.yml`).
Nothing in this feature competes with that:

| Who | Ports | Note |
|---|---|---|
| OpenMasjidOS (host) | 80, 443, 8443-8452 | the platform |
| Display container (host) | 7860, 7861, 8554 | unchanged by this work |
| A Pi node | 80 **on its own board** | a dedicated appliance; nothing else runs there, so an admin types just the IP off the TV |
| `devnode` harness (dev box) | 8099 | **must not** be :80 — it runs on the machine the OS is on |

The spec left ":80 vs a high port" open (§15 Q1). Settled: **:80 on a real node** (dedicated
device, best possible UX — no port to mistype off a TV across a hall), **a high port for the
dev harness**, and `nodeOrigin` therefore accepts `host:port` **only for loopback**. A LAN
address with a port stays refused, because accepting one would turn the adoption endpoint
into a port scanner for the masjid's network. IPv6 is refused outright rather than parsed —
`::1` would otherwise mis-split into host `::` and port `1`.

---

## Getting the pi-gen image build green — what was actually wrong

Seven CI rounds. Recorded because none of it is guessable from the outside, and the first
three failures all *looked* like environment problems when two were bugs in our own stage.

**1. `Cannot find module 'ws'` typechecking the agent.** Not a missing dependency — a
missing *install*. `node/agent`'s end-to-end test drives the real controller hub, so its
tests-included typecheck compiles part of `server/` and needs the server's `node_modules`.
It passed locally only because that directory already existed. CI now installs it.

**2. `qemu-user-binfmt` Conflicts with `qemu-user-static`.** They register the same
interpreters, so asking for both gives apt "held broken packages". pi-gen's dependency check
names `qemu-user-binfmt`, so that is the one to keep.

**3. pi-gen wants `FIRST_USER_PASS` when the first-boot rename is disabled** — and it is
right to. A passwordless account on a device on a masjid's network is a hole; a *fixed* one
baked into a published image is worse. The build now mints a random password per build, masks
it from the logs, and the stage then **locks and expires** the account. Nothing needs it: the
agent runs as `omd`, SSH ships disabled.

**4. pi-gen master is armhf.** 64-bit lives on the `arm64` branch. The tell was the
pre-flight line changing to "Checking native armhf executable support". `RELEASE` must be
left unset on that branch or it warns that it does not match.

**5. THE STAGE WAS DOING NOTHING.** pi-gen only executes substage *directories*
(`for SUB_STAGE_DIR in ${STAGE_DIR}/*; if [ -d ... ]`). `00-packages` and `01-run.sh` sat
loose in `stage-omd/`, so they were silently skipped — visible only as `Begin stage-omd`
immediately followed by `End stage-omd`. They now live in `stage-omd/00-omd/`. The stage also
needed `prerun.sh` (without it `${ROOTFS_DIR}` is empty instead of stage2's rootfs) and
`EXPORT_IMAGE` (without it pi-gen builds a rootfs and never writes an `.img`, so `deploy/`
stays empty). **A successful bootstrap would still have produced a stock Raspberry Pi OS
image with none of our customizations** — the most expensive class of bug, because it looks
like success.

**6. Stage ordering.** pi-gen's default `STAGE_LIST` is a sorted glob of `stage*`, and
`stage-omd` sorts *before* `stage0` (`-` < `0`). Our stage ran first, against nothing.
`STAGE_LIST` is now explicit, which also skips the desktop stages without `SKIP` files.

**7. `debootstrap: E: Unable to execute target architecture` is the FIX-BINARY flag.** Not a
missing package. Without `F` the kernel resolves the qemu interpreter *inside* the chroot,
where it does not exist yet; with `F` it is opened up front and carried in.
`docker run --privileged multiarch/qemu-user-static --reset -p yes` re-registers every
handler with `F`. pi-gen's pre-flight reports "arm64: ok" either way, because it only tests
qemu on the host — which is why this looked like it was already working.

The substage is now **self-contained**: the workflow assembles `00-omd/files/` with the
agent, the kiosk bundle and the overlay, so nothing reaches back into the repo and no
environment variables have to cross into the build. That also keeps the door open to
pi-gen's `build-docker.sh` without another restructure.
