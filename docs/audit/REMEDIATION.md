<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Remediation plan — audit of 2026-08-04

Companion to [`SECURITY_AUDIT.md`](SECURITY_AUDIT.md). Branch:
**`audit/security-2026-08-04`**, based on `c1080cd` (tree identical to `v0.61.0`).

**Autonomous push to `main` is disabled** — `build-image.yml` publishes a production
container image on every push to `main`. Everything below lands on the audit branch and
merges only through a reviewed PR.

Ground rules followed for every commit: **one finding per commit**, message
`fix(security): <description> [DISPLAY-NNN]`, and **`npm test` run on that commit** — not
once at the end.

---

## What ships on this branch

| # | Finding | Sev | Fix | Test added |
|---|---|---|---|---|
| 1 | DISPLAY-001 | Critical | Decode cookie values defensively; add a process-level `uncaughtException` guard so no throw in an event listener can kill the app | Yes — regression test asserting a malformed cookie yields no throw, and a live-server test that the process survives `GET /ws` with `Cookie: omd_session=%` |
| 2 | DISPLAY-002 | Critical | Timeout on `RenderWorker.request()` that rejects and recycles the worker; `renderedAt` stamp + staleness threshold in the write pump; on-screen stale indicator; raise repeated render failure from `debug` to `warn` and surface it in `TvStatus` | Yes — a hung worker must not wedge the pipeline; a stale frame must stop being served and must mark the screen not-fresh |
| 3 | DISPLAY-003 | High | Require a ≥32-byte secret or regenerate (fail closed); write it atomically via tmp+rename | Yes — empty/short/malformed secret files each produce a fresh strong key, and a token forged with an empty key is rejected |
| 4 | DISPLAY-011 | Low | Track `lastSeen` and evict on inactivity, so the sweep can actually delete | Yes — an entry with `fails > 0` is evicted once idle |
| 5 | DISPLAY-016 | Low | Clamp/reject `month` outside 1–12 and constrain `year` | Yes |
| 6 | DISPLAY-018 | Low | Write `db.json` and its tmp file with `mode: 0o600` | Covered by existing store tests + manual mode check |
| 7 | DISPLAY-013 | Low | `nosniff`, `Referrer-Policy: no-referrer`, `CSP: frame-ancestors 'self'` on panel + API, leaving the widget's deliberate `frame-ancestors *` alone | Yes — headers present on panel/API, absent-by-design on the widget |
| 8 | DISPLAY-004 | Medium | SHA-pin all five actions in `build-image.yml`, version in a trailing comment (house convention) | N/A — CI config; verified by the workflow running green |
| 9 | DISPLAY-009 | Medium | Digest-pin `node:22-slim` and `bluenviron/mediamtx:1.19.1` | N/A — verified by the build succeeding |
| 10 | DISPLAY-012 | Low | Override `postcss` to a patched version | N/A — verified by `npm audit` reaching 0 and the web build passing |
| 11 | DISPLAY-015 | Low | Add `.github/dependabot.yml` for `server/`, `web/`, docker and github-actions | N/A |
| 12 | DISPLAY-005 | Medium | Mark the session cookie `Secure` **per request** when the request arrived over HTTPS, so the plain-HTTP LAN flow keeps working | Yes — HTTPS request → `Secure`; plain HTTP → no `Secure` |
| 13 | DISPLAY-006 | Medium | Rate-limit unauthenticated `/api/session` and `/api/setup`; add a short reachability cache in `fabric.ts` so N requests collapse to one probe | Yes |
| 14 | DISPLAY-007 | Medium | `tokenVersion` in `db.admin`, carried in the token and bumped on password change | Yes — old token rejected after a password change, current session re-issued |
| 15 | DISPLAY-014 | Low | Clock-sanity check with a discreet on-screen warning when the clock looks implausible | Yes |
| 16 | DISPLAY-017 | Low | Per-IP limit + short `cache-control` on the public widget | Yes |
| 17 | DISPLAY-019 | Low | `HEALTHCHECK` on `/healthz`; report render freshness there once #2 lands | N/A |

## What deliberately does NOT ship

| Finding | Why held | Where recorded |
|---|---|---|
| **DISPLAY-008** (root container) | Changing `USER` changes the uid that must own `/data`; every existing install has a root-owned volume, so shipping this without a migration would lock masjids out of their own configuration. Data-ownership migration = not autonomous. | [`ACTION_REQUIRED.md` §3](ACTION_REQUIRED.md) |
| **DISPLAY-010** (tag overwrite policy) | Changes the release/update channel and interacts with the OpenMasjidAPPS catalog contract. Held for human review by rule. | [`ACTION_REQUIRED.md` §4](ACTION_REQUIRED.md) |

---

## Ship gate

The branch is only offered for merge when **all** of these hold:

- [ ] `cd server && npm run build` clean
- [ ] `cd server && npm test` — **≥ 50 passing, 0 failing** (baseline was 50/50)
- [ ] `cd web && npm run build` clean (includes `tsc --noEmit`)
- [ ] `cd web && npm audit` — 0 high/critical
- [ ] Every commit ran the tests, not just the tip
- [ ] Nothing unverified claimed as fixed
- [ ] No force-push, no history rewrite, no bypassed protection rule

---

## Rollback

### Roll back the whole audit branch (nothing merged yet)

Nothing on `main` has changed, so there is nothing to undo. To discard the branch:

```bash
git checkout main
git branch -D audit/security-2026-08-04
git push origin --delete audit/security-2026-08-04   # only if it was pushed
```

### Roll back after the PR is merged

Find the merge commit and revert it as a whole:

```bash
git checkout main
git pull
git log --oneline --merges -5                 # identify the audit merge commit <MERGE_SHA>
git revert -m 1 <MERGE_SHA>                   # -m 1 keeps main's first parent
git push origin main
```

**If CI fails on `main` after the merge, do this immediately** — a broken `main` is worse
than any finding in the report. Then confirm the follow-up `Build image` run goes green.

### Roll back one finding's fix

Each fix is its own commit, so a single finding can be reverted without touching the others:

```bash
git log --oneline --grep '\[DISPLAY-001\]'    # find the commit
git revert <SHA>
cd server && npm test                          # confirm the suite still passes
git push origin main
```

### Return the app to its pre-audit state entirely

The pre-audit tip is tagged:

```bash
git show pre-audit-2026-07-27                  # a32816bf5e3e3576b4a0bcfb400713b12383e98f
```

Note that tag is the **pre-revert v0.65.0** tree, not v0.61.0. To restore the audited
baseline (v0.61.0 + digest pin) as a forward commit, without rewriting history:

```bash
git checkout main
git read-tree -u --reset c1080cd
git commit -m "revert: return to the audited v0.61.0 baseline"
git push origin main
```

### Roll back the published image / catalog

Masjids install from the digest pinned in `docker-compose.yml`, so reverting the code is not
enough on its own — the catalog entry must point at a commit whose compose pins the image
you want:

```bash
# in OpenMasjidAPPS
#   registry.yaml -> apps: - id: display -> set ref: + commit:
npm run lint && npm test && npm run build      # regenerates catalog.json
git commit -am "display: pin to <ref>" && git push origin main
```

The currently-pinned image is
`ghcr.io/openmasjid-solutions/openmasjiddisplay:0.61.0@sha256:3642573141cf042f4b5258e5fe3c5b4fbd4b8ae20eef26aeef99716500b38926`
(verified pullable). **Never hand-edit `catalog.json`** — regenerate it.

---

## Reproducing the two exploited findings

Kept so the fixes can be shown to actually close them.

**DISPLAY-001** — start the app, then:

```bash
printf 'GET /ws HTTP/1.1\r\nHost: h\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'\
'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n'\
'Cookie: omd_session=%%\r\n\r\n' | nc 127.0.0.1 8080
curl -sS http://127.0.0.1:8080/healthz     # before the fix: connection refused (process died)
```

**DISPLAY-003** — with the app stopped, truncate the secret, restart, and sign a token with
an empty HMAC key:

```bash
: > "$DATA_DIR/session.secret"              # simulates a crash / full disk mid-write
node -e '
 const c=require("node:crypto");
 const p=Buffer.from(JSON.stringify({exp:Date.now()+3600e3,aud:"admin"})).toString("base64url");
 console.log(p+"."+c.createHmac("sha256",Buffer.alloc(0)).update(p).digest("base64url"));'
# before the fix: that cookie returns HTTP 200 from /api/state
```
