<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Raspberry Pi display nodes — implementation status

Companion to `PI_NODE_SPEC.md`. The spec says what we are building; this says **what exists
in the tree today**, so nobody has to infer it from the code. Update it with each milestone.

As of this commit: **M0 is complete and verified. M1–M4 are not started.**

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

`cd server && npm run build && npm test` → **106 passing**. `cd web && npm run build` clean.

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

- **Uploaded background/logo assets are not synced to nodes.** The `assets[]` protocol field
  exists and is validated; the orchestrator sends `[]`. A node renders the themed scene, so
  a masjid's custom photo/logo would not appear. Belongs to M1 — it needs content-hashed
  asset serving plus a token-authenticated fetch route.
- **The panel has no mDNS discovery picker** (spec §9 step 1 offers one alongside manual
  entry). Typing the address shown on the TV works and is the documented path; discovery
  needs an mDNS browser on the controller, which is M1 work alongside the agent that
  advertises `_omd-node._tcp`.
- **The "Download the node image" button points at the repo's latest release**, which will
  not carry a `.img.xz` asset until `image.yml` exists (M1).
- `render-core` is **sequential, not re-entrant**: `renderDisplaySvg` writes module-level
  state (`HOT`, `COLON_DIM`, `LIGHTUI`) that `salahHadithView` reads. Fine for one render per
  process (the container's worker, a node's kiosk); do not call it concurrently.

## Not started

**M1** (image + first-boot + kiosk timetable), **M2** (stream mode, identify on device),
**M3** (agent OTA), **M4** (RO rootfs, watchdogs, zram, `PI_NODE_SETUP.md`). Nothing under
`node/` or `image/` exists yet. The open questions in spec §15 remain open; §9's on-screen
confirmation-code hardening is still the v1.1 seam.
