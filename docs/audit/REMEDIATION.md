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

## What shipped on this branch

16 findings fixed, **one commit each**, tests run on every commit. Where a test could be
made to fail without the fix, that was checked explicitly ("revert-verified").

| Finding | Sev | Commit | Fix | Verification |
|---|---|---|---|---|
| DISPLAY-001 | Critical | `08ac9f9` | Decode cookie values defensively; wrap the `'upgrade'` listener in try/catch so it can never again be the reason the app dies | Revert-verified — 3 tests fail with `URIError` without it, incl. an end-to-end test that the server still answers after the fatal request |
| DISPLAY-002 | Critical | `b6f2a26` | 15s deadline on `RenderWorker.request()` that rejects **and recycles the worker**; `lastFrameAt` stamp + 30s staleness threshold; visible on-screen mark (dim + red bar, plain pixel maths, no re-render); `contentStale`/`frameAgeMs` in `TvStatus`; "Times out of date" badge; stale counts as not-online so the alert fires; render failure `debug` → `warn` | Revert-verified — without the deadline the test file hangs until killed, the production symptom exactly |
| DISPLAY-003 | High | `77e1431` | Require ≥32 bytes or regenerate (fail closed); write atomically via tmp+rename | Revert-verified — fails with `short secret accepted for input ""` |
| DISPLAY-004 | Medium | `e003ff6` | SHA-pin all five actions, version in a trailing comment | SHAs resolved from the GitHub API; `checkout` matches the pin OpenMasjidAPPS already uses; no `@vN` remains; YAML parses |
| DISPLAY-005 | Medium | `8ff8afe` | `Secure` decided **per request** via `isSecureRequest(req)`, so the plain-HTTP LAN flow keeps working | 5 tests incl. chained `X-Forwarded-Proto` and the HttpOnly/SameSite guards |
| DISPLAY-006 | Medium | `3b9d815` | 10 probes/s budget on outbound session validation + 5s reachability cache with in-flight coalescing | Revert-verified — 4 of 5 fail without it; one test exists purely to pin the fail-closed direction |
| DISPLAY-009 | Medium | `669cb2c` | Digest-pin `node:22-slim` and `bluenviron/mediamtx:1.19.1` | Digests resolved live **and verified to be multi-arch indexes** (amd64+arm64), or the arm64 half of every release would break |
| DISPLAY-011 | Low | `6b7bf12` | Evict on inactivity via `lastSeen`; never prune a client still locked out | Revert-verified — 4 of 5 fail with the old predicate |
| DISPLAY-012 | Low | `396bbd1` | `overrides` postcss → 8.5.25 | `npm audit` 0 vulnerabilities; built bundle byte-identical (same asset hashes) |
| DISPLAY-013 | Low | `da46000` | `nosniff`, `Referrer-Policy`, `frame-ancestors 'self'` on panel + API; widget untouched | Widget's permissive policy deliberately preserved |
| DISPLAY-014 | Low | `5cadd87` | One-directional clock floor; reuses the DISPLAY-002 mark rather than touching the 2098-line renderer | 8 assertions incl. "no false positive on a 2030 clock" |
| DISPLAY-015 | Low | `703fd07` | `.github/dependabot.yml` for npm ×2, docker, github-actions | Structure + no-tabs checked; GitHub validates on push (not yet proven) |
| DISPLAY-016 | Low | `5cac6bb` | Reject an out-of-range month with 400 rather than silently substituting | — |
| DISPLAY-017 | Low | `2d09662` | 90 req/min/IP `RequestLimiter` + short `cache-control` | 2 tests; cap deliberately generous |
| DISPLAY-018 | Low | `4724346` | `db.json` written `0o600` (self-heals via rename) | Test asserts the mode **and** that the file really holds the credentials |
| DISPLAY-019 | Low | `7534f99` | `HEALTHCHECK` on `/healthz` | Exact CMD verified: exit 0 serving, exit 1 against a dead port |

## What deliberately does NOT ship

| Finding | Why held | Where recorded |
|---|---|---|
| **DISPLAY-007** (no session revocation) | **The fix in my own plan turned out to be unimplementable.** I planned a `tokenVersion` bumped on password change — then found this app has **no password-change endpoint or UI at all**. `tokenVersion` alone would change nothing observable; making it useful means adding new authenticated endpoints plus UI, which is a product feature, not a security patch. The finding is corrected in the report rather than patched to match the plan. | [`SECURITY_AUDIT.md` DISPLAY-007](SECURITY_AUDIT.md), [`ACTION_REQUIRED.md` §5](ACTION_REQUIRED.md) |
| **DISPLAY-008** (root container) | Changing `USER` changes the uid that must own `/data`; every existing install has a root-owned volume, so shipping this without a migration would lock masjids out of their own configuration. Data-ownership migration = not autonomous. | [`ACTION_REQUIRED.md` §3](ACTION_REQUIRED.md) |
| **DISPLAY-010** (tag overwrite policy) | Changes the release/update channel and interacts with the OpenMasjidAPPS catalog contract. Held for human review by rule. | [`ACTION_REQUIRED.md` §4](ACTION_REQUIRED.md) |

### One scope change I made, and why

DISPLAY-006's plan said "rate-limit unauthenticated `/api/session`". I bounded the
**outbound** platform calls instead. The harm was the outbound fan-out, which is now capped
at its source; adding an inbound limit to a GET the control panel legitimately polls would
risk breaking the UI for no further benefit. Noted here rather than left as a silent
divergence between plan and code.

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
