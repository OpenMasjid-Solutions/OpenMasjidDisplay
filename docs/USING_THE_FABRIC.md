<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# How to use the OpenMasjidOS Fabric (Display)

The **Fabric** is the platform↔app integration layer. Everything is **optional + backwards-
compatible**: without the platform, Display runs fully standalone (own login + appearance). The
canonical spec is OpenMasjidAPPS `docs/BUILDING_AN_APP.md` §7.

**Wire identifiers (never rename):** env `OPENMASJID_BASE_URL`, `OPENMASJID_APP_ID`,
`OPENMASJID_APP_SECRET`; header `X-OpenMasjid-App-Secret`; cookie `omos_session`.
**Golden rule:** read those env vars **every process start**; never persist them (or anything fetched
from the Fabric) to the data volume — the platform changes them across restarts/migrations.

## What Display uses today

```yaml
# manifest.yaml
sso: true            # sign in with the dashboard login
notifications: true  # alert the masjid when a screen goes offline/online
domain: true         # learn our PUBLIC url behind the admin's tunnel (widget + volunteer links)
https: true          # serve the control panel through the platform's TLS proxy
whatsapp: true       # post the Iqamah-change notice to a group the admin approved
commands:            # things an admin can run by messaging the masjid's number (!display)
fabric:              # what we PROVIDE to other apps: `timetable`, over the app-to-app broker
  provides:
    - capability: timetable
```

### 1. Single sign-on (implemented — keep it)

Forward the request's `omos_session` cookie to `${OPENMASJID_BASE_URL}/api/auth/session` with the app
secret; a `true` mints a local admin session (`server/src/fabric.ts`).

Two things there are load-bearing and must not be simplified away:

- **Never brick when the platform is unreachable.** `probePlatform()` reports *reachable* separately
  from *signed in*, so a momentary outage falls back to the local recovery password instead of locking
  the panel (the restore/migration bug — [`RESTORE_SSO_FIX.md`](RESTORE_SSO_FIX.md), now fixed).
- **But the recovery password is only offered while the platform is DOWN.** While it is reachable,
  `POST /api/setup` refuses an anonymous claim, because under SSO no local password is ever set and an
  unconditionally open setup endpoint is an unauthenticated admin takeover.

### 2. Appearance (implemented — keep it)

Match the dashboard's theme/wallpaper via the `#omos=` hash + `GET /api/public/appearance`
(`web/src/prefs.ts`).

### 3. Notifications (implemented — keep it)

Relay screen offline/online alerts: `POST ${OPENMASJID_BASE_URL}/api/fabric/notify` with the app
secret + `{ text, title?, level? }`. Fails soft.

### 4. Public URL / remote access (implemented — keep it)

`GET ${OPENMASJID_BASE_URL}/api/fabric/site` with the app secret tells us our public address behind the
admin's Cloudflare tunnel, so the **website-widget embed code** and the **volunteer page link** can point
somewhere that works off-site:

```
GET ${OPENMASJID_BASE_URL}/api/fabric/site
  X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>
→ { "enabled": true, "domain": "omos.example.org",
    "publicUrl": "https://omos.example.org/display", "basePath": "/display" }
```

Two rules:

- **Read `basePath`; never hardcode `display`.** The admin can rename it.
- **Be base-path aware.** The platform serves apps path-based under one `omos` subdomain and does **not**
  strip the prefix, so routes and assets must match both the LAN form (`/w/:id`) and the tunnelled form
  (`/<basePath>/w/:id`). Display already does — see `api.ts`'s widget and volunteer route patterns.

Treat the answer as authoritative and fail soft: the platform only returns a `publicUrl` when it is
actually routing this app's path, and no Fabric / tunnel off / any error simply means "use the LAN link".

### 5. HTTPS for the panel (implemented — keep it)

`https: true` puts the platform's TLS proxy in front of the **first** published port, which is what gives
the panel a secure context (clipboard for the embed code, `Secure` cookies). The plain HTTP port stays
published as a legacy fallback, and the volunteer port is deliberately not proxied. That dual-scheme
setup is exactly why the session cookies use **separate names** for their `Secure` variants — see the
comment in `server/src/auth.ts` before changing anything there.

### 6. WhatsApp (implemented — keep it)

`whatsapp: true` lets the app post the **Iqāmah-change notice** to a group the OpenMasjidOS admin
approved. Three calls, all server→server with the app secret, all failing soft
(`server/src/fabric.ts`):

```
GET  ${OPENMASJID_BASE_URL}/api/fabric/whatsapp         → { available, reason, media, maxMediaBytes, outcomes }
GET  ${OPENMASJID_BASE_URL}/api/fabric/whatsapp/groups  → { groups: [{ id, label }] }
POST ${OPENMASJID_BASE_URL}/api/fabric/whatsapp         → 202 { queued: true, id }
     { "group": "…@g.us", "text": "…",
       "media": { "data": "<base64>", "mimeType": "image/png", "filename": "…" } }
GET  ${OPENMASJID_BASE_URL}/api/fabric/whatsapp/status/<id>
                                                        → { id, state, reason?, at, target }
```

**Minimum platform versions.** Sending needs OpenMasjidOS **0.51.0+**; the message id, the status
lookup and a send queue that survives a restart need **0.51.1+**; a per-app outcome history (rather
than one ring every app shared, where a single roster run evicted everybody else's records) needs
**0.51.1-dev.8+**. Below any of those the `outcomes` field is simply absent, which — like `media` —
must read as `false` rather than be assumed. A `404` from `/status/<id>` is **unknown**, never a
delivery failure: it covers an unknown id, another app's id, an evicted record and a platform too old
to have the endpoint.

The rules that are not ours to bend:

- **We never touch the gateway.** No URL, no API key, no session, no idea which number is linked.
  The platform holds all of it, and one queue shared by every installed app, because ban risk
  attaches to the masjid's *number* rather than to whichever app had something to say.
- **The pacing is gone, and that moves the responsibility here** (0.51.1). Quiet hours, the hourly
  and daily caps, the per-recipient and per-group cooldowns, the warm-up ramp and the random gap
  between messages have all been removed; a typing indicator sized to the message is the only pause
  left. The platform used to refuse to send too much. It does not any more, so **nothing but this app
  bounds what this app sends** — see the note below on what actually bounds it.
- **`queued` is not `sent`.** A 202 is acceptance. There is no delivery receipt from WhatsApp, so
  even a `sent` verdict means "handed over", never "read". Nothing here blocks on it.
- **Ask what became of it, once you can.** The 202 carries an `id`; `/status/<id>` answers
  `queued` / `sent` / `failed` / `expired`, scoped to this app's own messages and holding no
  message text and no recipient. The platform keeps **500 outcomes per app for 24 hours** (its own
  `MAX_OUTCOMES_PER_SOURCE` / `OUTCOME_MAX_AGE_MS`) — per app since 0.51.1-dev.8, so no other app's
  traffic can evict ours. We store the id on the log entry and reconcile it on the announcer's own
  minute tick, **for as long as the platform will answer**: see WA_OUTCOME_WINDOW_MS for why
  stopping early loses an announcement rather than merely losing a status.
- **Status lookups are not sends.** Reads have their own counter (600/minute per app) separate from
  the 120/minute that messaging a recipient costs, so polling cannot refuse a send or vice versa.
  Our worst case is about two reads a minute, and none at all when nothing is outstanding.
- **"Could not ask" is not "did not arrive".** A 404, a timeout, an older platform and an unreachable
  box all mean *no verdict*, and every one of them has to leave the entry alone. Collapsing them into
  a failure would re-announce a change the group already has, which is worse than not knowing.
- **Nothing auth-critical, ever.** No login codes, no password resets, no OTPs — WhatsApp is an
  unofficial client and the number can be restricted overnight. Those go by email.
- **Ask before offering the feature.** `reason` is one of `ready` / `not-configured` / `not-linked` /
  `unreachable`, each needing a different sentence; we add `not-allowed` (the platform's 403) and
  `no-fabric` (running standalone). Without this, the switch looks available on every install and
  fails only when a real announcement was due.
- **Only approved groups.** The list holds nothing but what the admin put in front of us, approval
  can be withdrawn at any time, and an empty list means hide the feature rather than error. An id we
  were not given is refused with a 403.
- **Never log a message body.** The log we keep is event + group id + timestamp + the change's date.

**The poster goes as an image, when the platform can carry one** (OpenMasjidOS 0.50.5+). Three rules
here, each of which was a bug waiting to happen:

- **Read `media` before rendering.** Rasterising a 1080×1350 poster is real work on a Pi, and on an
  older platform every byte of it is thrown away. An absent `media` field MUST read as `false`.
- **Read `maxMediaBytes`; never hardcode it.** It is the platform's number to change (2 MB today; a
  poster is 150–400 KB). Over it, we fall back to text rather than eat a refusal after the upload.
- **Never degrade to the caption alone.** The caption is written to sit *under* an image — it names
  what moved and nothing else — so posting it by itself would be an announcement with no timetable in
  it. Every media failure (no capability, render threw, over the cap) falls back to the **full**
  `announceText`, and a test pins that.

Both forms are built from the poster's own `PosterModel`, so image and text cannot disagree about
times or tense. `renderPool.announce()` takes that model rather than re-detecting: its own rule is the
download button's ("next change, else the most recent past one"), which **skips a change taking effect
today** — exactly the case the announcer exists to catch.

A 202 still is not delivery: the platform validates mime, size, caption length and its queue depth
while our request is open — those refusals reach us as a `400` with a sentence worth showing an admin
— but what happens after that used to be invisible. It is not any more: the `id` is stored and the
verdict is written back onto the log entry, so a poster that never made it says so instead of reading
as "queued" forever. Nothing anywhere reports a poster as *published*.

**A failed image is never downgraded to its caption.** That rule is the platform's too, now: a media
send that fails comes back `failed`, not as a half-success with the caption alone. Our fallbacks all
happen *before* sending — no capability, a render that threw, over `maxMediaBytes` — and each one
sends the **full** text notice.

Which event goes out, to whom, and how early is **our** setting, not the platform's: its alerts matrix
has no WhatsApp column for apps, because those rows route to the admin's one number and our messages
are for the congregation.

**What bounds this app's sending, now that the platform's caps are gone.** All of it is structural
rather than a limiter bolted on, which is the point — there is no code path here that can loop:

- **One approved group, never a person.** This app has no per-recipient send at all: it posts to the
  one group an admin approved. One message reaching a whole congregation is the safe shape, and it is
  the only shape available here.
- **One message per change.** The dedupe key is group + the change's effective date, read back out of
  the persisted log, and a `sent` verdict counts as handled just as `queued` does — so a confirmed
  message cannot become a duplicate.
- **Five attempts, thirty minutes apart**, and the wait runs from *the verdict*, not from when the
  message was queued. A permanent refusal stops rather than retrying forever.
- **One post in flight**, shared by the timer and the admin's "Send now" button.
- **No retry around a 202.** A queued message is queued; asking again would duplicate it. The only
  thing that retries is a message the platform said did not go.

### 7. Admin commands (implemented — keep it)

`commands:` declares what an admin can run by messaging the masjid's WhatsApp number. The platform
owns everything except the doing — it decides who may run them, renders the numbered menu from our
manifest order, and formats the reply. We serve one route, `POST /fabric/commands/run`
(`server/src/fabricCommands.ts`), and it is the **only inbound route that can write** — §8 below
adds a second, read-only one under the same `/fabric/` prefix, which is not a permission.

The envelope, all of which is load-bearing:

- **Both headers or nothing.** `X-OpenMasjid-App-Secret` must equal our OWN
  `OPENMASJID_APP_SECRET` (constant-time compare) **and** `X-OpenMasjid-Caller-App` must be exactly
  `omos:platform`. That value can never be an app id — the colon is outside the app-id charset — so
  it identifies the platform by construction rather than by an allow-list. Checking only the secret
  would let anything that ever learned it drive the wizard.
- **Exact path only, which IS the LAN-only enforcement.** Behind the tunnel this app is served under
  `/<basePath>/…` and the platform does not strip the prefix, so a tunnelled request arrives as
  `/display/fabric/commands/run` and does not match. We never register the prefixed form. There is no
  header to trust for this.
- **10 s to answer, and we cap the request body at 8 KB** (the platform caps its own at 4 KB, and its
  reply cap is 16 KB). Someone is holding a phone. Reply text is plain, ≤1000 chars.
- `404 {code:'unknown_command'}` for an id we don't serve, `503 {code:'not_ready'}` before we have a
  secret, `200 {ok:false,error}` for a refusal we can explain — an HTTP error there would become a
  generic "that did not work" instead of our own words.
- **Never put `commands` in `fabric.provides`.** It is reserved and refused at install: it would
  expose this same handler to other apps through the app-to-app broker, a different trust boundary
  sharing a path prefix.

**Follow-up exchanges (OpenMasjidOS 0.51.0-dev.11+).** Return `followUp: { token }` beside the text
and the sender's next *plain* message comes straight back with `followUpToken` set — so an admin
answers questions instead of retyping `!display 1` on every line. Omitting `followUp` ends the
exchange. The token is ours; the platform stores it against that one sender and keeps no other state.

Four rules, all of which this app depends on:

- **An `ok: false` ENDS the exchange.** So a misread date or a time with no am/pm answers `ok: true`
  and asks again. Answering "that was wrong" with a failure would drop the admin out of the flow for
  a typo. `ok: false` is reserved for the terminal cases (no timetable, no location).
- **The exchange can end without us** — three minutes idle, fifteen total, twelve turns, an exit
  word, or the sender starting any other `!` command — with no notification. Nothing is applied
  until `save`, so an abandoned flow leaves a draft that expires, never a half-written change.
- **The token is the sender.** The body still carries no phone number, but the platform binds a token
  to one person, so keying sessions on it keys them per admin. A call with **no** token is always a
  fresh start — an older platform's `!display 1 <answer>` is indistinguishable from a second admin
  beginning their own change, and picking wrong puts one person's answers in another's draft.
- **`done` is one of the platform's own exit words** (with exit/quit/cancel/stop/nevermind). It ends
  the conversation above us and we are never called, so it must never be a "save" word here — the
  change would vanish while the admin believed they had saved it. We ask for `save`.

**`confirm: true` is deliberately OFF.** The platform's confirmation fires per call, so it would
demand a code before *every* step. The wizard's own `save` is the confirmation, and nothing is
written before it. `argument.required` is **false**, which is what makes a bare `!display 1` legal.

### 8. Providing `timetable` to other apps (implemented — keep it)

This is the only thing Display **provides**. Everything else above is Display consuming the
platform; here another app on the same box consumes Display, through the platform's **app-to-app
broker**, and the platform is the only route between them.

```yaml
fabric:
  provides:
    - capability: timetable
```

**Why it exists.** Display owns prayer-time correctness in this family of apps. The calculation,
the Iqamah rules, the CSV per-day overrides, the scheduled "from this date" changes, the masjid's
timezone and its Hijri offset all live here and nowhere else. **OpenMasjidCompanion** — the
installable PWA musallis add to their phones — shows a prayer timetable as its home screen and
fires its push notifications from those times, and is forbidden by its own rules from calculating
any of it. So it reads ours. `server/src/fabricTimetable.ts`.

**Three methods, on the control-panel port, at the exact unprefixed paths:**

```
POST /fabric/timetable/list   → { v:1, timetables:[{ id, name }] }
POST /fabric/timetable/get    ← { id, from:"YYYY-MM-DD", days:1..45 }
POST /fabric/timetable/logo   ← { id }
```

`TIMETABLE_PATHS` and `TIMETABLE_METHOD_BY_PATH` in `fabricTimetable.ts` are the one source of
truth for that mapping in both directions, so the path the dispatcher matched and the path the
envelope re-checks cannot drift. **A new method is additive and does not change `v`.**

**Probing for a method an older Display does not serve gets `401 {"error":"Please sign in."}` —
not a 404.** Verified against a running server, and it surprises people, so: an unmatched path
falls past every branch above to this app's session gate, and a Fabric call carries no session
cookie. There is no route to 404 *from*. So a consumer must treat **any** non-200 as "not
available, fall through", and must not branch on 404 specifically — from these methods a 404
means `unknown_timetable`, i.e. *the id was wrong*, which is a completely different problem from
*this Display is too old*.

The broker proxies `POST ${OPENMASJID_BASE_URL}/api/fabric/app/display/timetable/<method>` onto
those, injecting **our own** `OPENMASJID_APP_SECRET` as `X-OpenMasjid-App-Secret` and the trusted
caller id as `X-OpenMasjid-Caller-App`.

`get` answers with the timetable's `masjidName`, its **`timezone`** (IANA), `language`,
`hourCycle`, and one object per day carrying `date`, `hijri.label`, `sunrise`, the five prayers as
`{adhan, iqamah}`, and `jumuah`. The exact shape is the `Fabric*` interfaces in
`server/src/fabricTimetable.ts` — those are the written contract, and `fabricTimetable.test.ts`
holds it to them.

Four things about that payload are load-bearing and easy to get wrong later:

- **The wire is 24-hour `"HH:mm"`, always** — `hourCycle` is what this timetable *displays*, not
  what it sends. The trap is reusing the renderer's `fmtShort(h, tt.timeFormat)`, which would hand
  a consumer `"9:25 PM"` to parse and an em dash where it expected nothing. `hhmm()` floors the
  minute exactly as the screens do, because a phone showing a time a minute later than the board
  on the wall is a discrepancy nobody can explain.
- **Every override is already applied**, per day — CSV, scheduled change, Adhan offsets, the
  Iqamah rule, in that precedence. What a musalli standing in the masjid on that date would read
  off the screen is what goes on the wire. That is the whole point of asking us rather than
  calculating.
- **`timezone` is the zone the times were actually computed in**, which is *not* always
  `tt.timezone`: that field is `''` for "this box's zone", and the engine also falls back to the
  host zone for a name Intl does not recognise. A consumer schedules notifications from this, so
  reporting the stored string would be silently an hour or more out for everyone.
- **`jumuah` is emitted only on days that are Friday in the masjid's zone**, with `adhan: null`.
  The screens carry the Jumu'ah strip on *every* day as a standing reference; repeating that here
  would assert a jamā'ah on a Tuesday. The null is a fact, not a gap — a timetable configures
  Jumu'ah as jamā'ah times only, and the Friday countdown on the wall runs to the calculated
  **Dhuhr** adhan relabelled "Jumu'ah", so that day's `prayers.dhuhr.adhan` is the time to use.

**`logo` — the masjid's own mark, so a musalli's home-screen icon is theirs.** Answers
`{v:1, id, logo:{mime, bytes, data}}` with `data` base64 and **no `data:` prefix**, or
`{v:1, id, logo:null}` when the timetable uses the built-in mark. `bytes` is the *decoded*
length, so a consumer can sanity-check before decoding. Companion resolves
*Display's timetable logo → the platform's `/api/public/logo` → its own mark*, and this is the
first link: it is the logo already on the wall in front of the musalli, and the one more likely
to be set at all, because a masjid configures its screens long before it visits
OpenMasjidOS → Settings → Customize.

Four things about it:

- **A separate method, not a field on `get`, deliberately.** `get` is polled on a cadence and
  its whole virtue is being small. A logo is 10–200 KB, byte-identical on every poll, and
  changes maybe once in the life of an install; inlining it would multiply the steady-state cost
  of the feed by an order of magnitude. Fetched separately it is cached until the masjid changes
  it.
- **Raster only, as an allowlist** (`image/png`, `image/jpeg`, `image/gif`) — never "anything but
  SVG". SVG is refused with `415 {error:'logo_not_raster'}` even though a masjid can upload one
  and the screens render it perfectly: an SVG is a script container, and this particular image
  becomes an app icon on a phone after a consumer has parsed and re-encoded it. WebP is absent
  for an unrelated reason — `checkUploadedImage` already refuses it at upload because resvg
  cannot decode it, so a WebP logo is not on the screens either.
- **The bytes decide the type, never the file extension.** `sniffImageMime` reads the magic
  bytes, so an SVG saved as `logo.png` is still refused — which is exactly the case a check on
  the extension would wave through.
- **Capped at 175 KB decoded** (`TIMETABLE_LOGO_MAX_BYTES`), *derived* from the broker's 256 KB
  ceiling rather than picked: base64 costs a third more, so the encoded answer is ~239 KB and a
  test recomputes that arithmetic. Over the cap is `413 {error:'logo_too_large'}`, because a
  response that overruns the ceiling arrives **truncated** — a corrupt image that nothing in the
  chain would report as corrupt.

A `logoImage` that names a missing file, or one that tries to escape `/data/uploads`, answers
`logo: null` — not an error. The screens fall back to the built-in mark in exactly that
situation, so it is the honest answer. `logo` needs no location, unlike `get`.

**The envelope**, and which part of it is doing what — because only one of these is the
authentication:

- **The secret is the authentication.** `X-OpenMasjid-App-Secret` must equal our own
  `OPENMASJID_APP_SECRET`, length-checked then constant-time compared. It proves the call came
  *through the platform*.
- **The path is the authorisation.** The broker maps `…/app/display/<capability>/<method>` onto
  `/fabric/<capability>/<method>`, so the capability the admin granted **is** the path segment,
  and a grant for one cannot reach another's handler. The grant list stays with the platform;
  a second copy here would only ever drift.
- **The exact *raw* path is the LAN-only rule** — and this is the one place this route is
  deliberately stricter than §7. `/fabric/commands/run` enforces LAN-only by refusing any request
  carrying `x-forwarded-*`, on the reasoning that the platform builds its headers from scratch.
  That reasoning does not transfer: the broker *is* a proxy, and if it appends
  `X-Forwarded-For` the route would be dead on arrival, silently, and only on a real box. So this
  route compares the **request line** against the path it matched instead. That is strictly
  stronger for the case that actually matters — `pathname` comes from `new URL()`, which collapses
  dot segments, so `/display/../fabric/timetable/get` reaches an "exact path" match while the raw
  target never equals the bare path. No tunnelled spelling of the request can pass.
- **The caller id is neither.** Anything holding the secret can spell it however it likes. It is
  *required* because a genuine broker call always carries one, it is checked for **shape only**,
  and it is kept because a refusal in the log is worth little without knowing who was asking.
  Never turn it into an allow-list of apps: a route that refused a caller the platform
  legitimately started using would fail closed and silently.

**Read-only, and asserted rather than intended** — nothing in the module touches `store.update`,
and a test reads the file to prove it. A provider that can write turns a leaked secret into an
attacker repointing a masjid's prayer times.

`days` is capped at **45** server-side. That keeps the answer far inside the broker's 256 KB
response ceiling (a 45-day answer with eight Jumu'ah jamā'āt and Arabic labels is well under
128 KB), but the cap is really about CPU: every day is a fresh solar computation in the same
process that runs the 1 fps loop drawing the actual screens. There is also a 60/min socket-keyed
limiter for the same reason. Outside 1–45 is `400`, not a clamp.

The full error set, since a consumer has to branch on it: `400 {error:'bad_request'}`,
`403 {error:'forbidden'}` (the envelope — deliberately not saying which part of it failed),
`404 {error:'unknown_timetable'}`, `405 {error:'method_not_allowed'}` (all three methods are
POST), `409 {error:'no_location'}` (the timetable exists but the admin never set coordinates —
retrying will not fix it, and answering anyway would compute for latitude 0, longitude 0 and
return times that look entirely reasonable), `413 {error:'logo_too_large'}`,
`415 {error:'logo_not_raster'}`, `429 {error:'too_many_requests'}`, and
`503 {error:'not_ready'}` before we have a secret. An unexpected throw becomes the dispatcher's
generic 500, so treat any 5xx as "ask again later".

**This capability is not the public widget.** `/w/<id>.json` is gated on `widget.enabled`, shaped
for an iframe and open to the internet with CORS. That opt-in governs whether the masjid publishes
times on their own *website*, which has nothing to do with whether they granted another app on
their own box the capability to read them — so `list` deliberately does **not** apply it. Copying
that gate would hide timetables the admin clearly meant to share; ignoring it in the other
direction, on the public route, would expose ones they never published.

**Adding a field is additive and bumps nothing; changing or removing one is a new `v`.** A
consumer must ignore fields it does not know.

## What Display does NOT need — but exists

- **Stripe (`stripe: true`) — skip.** Display takes no payments. Do not set it.
