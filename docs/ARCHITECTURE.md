<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Architecture

OpenMasjid Display is a **single container** (`ghcr.io/openmasjid-solutions/openmasjiddisplay`) — one image to
install and update. Inside it run two cooperating parts:

| Part | Role |
|---|---|
| Control plane (Node) | Web UI + JSON API + WebSocket, the timetable renderer, the scheduler, and the orchestrator. It also spawns the ffmpeg processes that encode every stream. |
| MediaMTX | The RTSP server every screen's decoder connects to. Launched and supervised by the control plane (`mediamtxServer.ts`); the binary is copied from the official multi-arch `bluenviron/mediamtx` image at build time, so it's the same build — just bundled. |

Three ports are published to the host: the control panel (`8080` in the container, `7860` by default on the
host), the volunteer page (`8081` → `7861`), and RTSP (`8554`). MediaMTX's control API (`9997`) binds to
loopback only and is never exposed.

## Data model

All state is a single JSON document in the data volume (`/data/db.json`, written `0600` via tmp+rename):

- **Timetable** — a full-screen prayer display: theme/colours, layout, orientation, quality, location,
  calculation method, Asr madhab, timezone, per-prayer Iqamah rules, Jumu'ah times, and the on-screen
  extras (ticker, announcement slideshow, salah hadith, prohibited-time notice, Iqamah countdown,
  Iqamah-change reminder, Adhan offsets and pop-up, widget opt-in).
- **Source** — a camera or HDMI encoder: stream URL, and a mode (`direct` relay or `normalize` re-encode).
- **Screen (TV)** — a physical display with a stable id, a default content, and an optional manual override.
- **Schedule rule** — a weekly time window that points target screens at some content, with a priority.
- **Settings** — default picture quality, the schedule timezone, the volunteer-page switches, and the
  WhatsApp announcement settings (which group, which timetable, how many days ahead — all off by default). There is
  no server IP to set: the control panel builds each screen's RTSP link from the address it was opened
  with. Theme and wallpaper are per-browser preferences (localStorage), not stored here.
- **Credentials** — the admin's scrypt hash and the volunteer PIN hash. The session-cookie HMAC key lives
  beside the document in `session.secret` (`0600`), generated on first run.

Uploaded images (backgrounds, logos, announcement slides) are files under `/data/uploads`, referenced from
the document by filename and inlined into the rendered SVG as `data:` URIs.

## What each screen shows (content resolution)

Every reconcile, each screen's *effective content* is resolved with this precedence:

1. **Manual override** — a choice from the Screens page or the volunteer page (sticky until they pick again
   / resume).
2. **Schedule** — the highest-priority enabled rule whose weekly window is currently open (windows may wrap
   past midnight).
3. **Default** — the screen's normal content.

## MediaMTX path scheme

The orchestrator programs MediaMTX entirely through its control API (the file watcher is unreliable in
Docker), reconciling desired vs. actual paths:

- A timetable publishes to a runtime path named by its id (`tt_xxxx`) via ffmpeg.
- A **direct** source becomes a proxy path (`src_xxxx`, `sourceOnDemand: true`) — pulled only while watched.
- A **normalize** source is transcoded by us and published to `src_xxxx`.
- Each screen path (`tv_xxxx`) **self-relays** from `rtsp://127.0.0.1:8554/<contentPath>`. Switching a screen
  is one `PATCH` of that path's `source`; the decoder keeps the same URL (and sees a brief reconnect).

Paths the app no longer needs (`tv_*`, `src_*`) are deleted on reconcile. RTSP is forced to **TCP** — set by
`MTX_RTSPTRANSPORTS=tcp` in the Dockerfile's environment, which overrides the bundled `/app/mediamtx.yml`
(MediaMTX's own default config, copied from its image) — for the widest, NAT-friendly decoder compatibility,
so only `8554/tcp` is published.

## Timetable render pipeline

Per active timetable, one pipeline runs (`render/renderer.ts`):

1. Once per second, the current state is built into an **SVG** (`render/svg.ts`) — a liquid-glass design
   honouring the timetable's layout preset (centered / clock-top / split), element toggles, theme/accent,
   and an optional custom background (frosted and inlined as a data: URI by `render/background.ts`).
2. resvg (`@resvg/resvg-js`, bundled native binary, fonts baked into the image) rasterises it to raw RGBA
   **on a worker thread** (`render/renderWorker.ts`, managed by `render/renderPool.ts`). resvg is synchronous
   and CPU-heavy; running it on the main thread once per second starved both ffmpeg's stdin and the
   MediaMTX/HTTP server, so streams took minutes to come online and the panel felt sluggish. The worker keeps
   the event loop free; at most one frame is in flight per pipeline, so a slow box just renders a little less
   often instead of stalling. Control-panel previews share a second worker (so editing never stalls a live
   stream). Only a small **curated set of base fonts** is loaded (`render/fonts.ts`) — loading every per-script
   Noto file made each render parse far more data and could even hang resvg on glyph fallback.
   Without a ticker the frame is rasterised at a **capped** longest side (`RENDER_CAP`, 1280) and ffmpeg
   upscales, which keeps each render comfortably inside its one-second slot on a two-core box; the upscale
   is a `scale` filter set once at spawn, so changing SVG content never respawns ffmpeg.
3. The RGBA frame is piped to **ffmpeg**, which encodes H.264: `libx264 -preset veryfast -tune zerolatency
   -profile baseline`, one keyframe per second, in-band SPS/PPS (`repeat-headers=1`), CBR at the
   timetable's configured bitrate cap, `yuv420p`, no audio — then publishes to MediaMTX over RTSP/TCP.
   Output is 15 fps normally; **with a scrolling ticker it is 20 fps** and the pipeline repeats the last
   render in real time so ffmpeg receives genuinely evenly-paced CFR frames (a once-a-second burst made
   hardware decoders play "move, stop, move").

The scrolling ticker is **not** in the SVG: the SVG paints only the band, and ffmpeg animates the text with
`drawtext` at the output frame rate. When the red Iqāmah-change reminder shares that band, `drawtext` — which
has no clip region — would slide over it, so the band's right-hand slice is cropped out, the text is drawn on
that slice, and the result is overlaid back (`timetableVfReserved`, a `-filter_complex` graph). Anything that
is baked into the ffmpeg arguments (ticker text, colour, speed, the reserved lane, dimensions, bitrate)
respawns ffmpeg when it changes; everything else is just new SVG content.

Because the frame is mostly static, encoding is cheap (duplicated frames cost almost nothing), which is what
keeps it viable on a Raspberry Pi. Pipelines self-heal: if ffmpeg exits, it is respawned with backoff.

**Encoder choice** (`render/encoder.ts`) is decided once per process. libx264 is the default and the only
option an App Store install has. `VIDEO_ENCODER=qsv|auto` selects Intel Quick Sync (`h264_qsv`) *if* the
ffmpeg build carries the encoder **and** a DRM render node exists — otherwise it logs the reason and falls
back, so a wrong setting is never a dark screen. QSV needs `/dev/dri` in the container, and the platform's
compose risk-check treats any `devices:` entry as blocking, so it is reachable only from a standalone
`docker compose up`. The x264 argument list is asserted byte-for-byte in the tests: it was tuned against
real decoder behaviour (baseline profile, in-band SPS/PPS, no B-frames, CBR HRD) and drift shows up as a TV
that won't play the stream.

Per-timetable touches the renderer honours: an optional uploaded **masjid logo** (`render/background.ts`,
inlined like the background), an optional **seconds** clock, a live **sun/moon with rays** that lights the
glass panels, **custom label overrides** (rename a prayer/masjid/footer), and per-day Iqamah times from
either a whole-year **CSV** (`iqamahCsv.ts`, keyed by `MM-DD`) or a **from-this-date schedule**
(`iqamahSchedule.ts`), overriding the rules on matching dates.

## Freshness: a frozen screen must not look healthy

A screen showing yesterday's Iqamah times with a stopped clock is worse than a dark one, because nobody
notices. Two independent faults are treated the same way:

- **Frozen** — the published frame is older than `STALE_AFTER_MS` (30 s, i.e. ~30 missed renders).
- **Clock** — the host clock reads earlier than `CLOCK_FLOOR_MS`, a floor moved forward at each release. The
  renderer is producing a perfect frame every second; every prayer time on it is simply wrong.

Either way the published frame is dimmed and given a red bar along the bottom (plain pixel arithmetic on the
RGBA buffer — the renderer is the thing that has failed, so nothing here may depend on it), the status feed
reports `contentStale` with the reason, the panel and the volunteer page badge it, and the Fabric alert says
which fault it is and what to do about it.

## Click-to-edit live editor

The studio preview is a server-rendered PNG. To let the user rename text by clicking it, a render can also
collect **hotspots**: when `renderDisplaySvg` is given a `sink`, each editable `text()` records its label id
and bounding box as fractions of the canvas (`POST /api/preview-meta` → `renderPool.meta`, which builds the
SVG only — no rasterization). The editor overlays a transparent button per hotspot and an inline `<input>`
on click; committing writes `masjidName` / `footerNote` / `labels[<key>]` back to the form. Hotspot collection
costs the video pipeline nothing (it never passes a sink).

## Reconcile loop

`store.update()` (any data change) and a 15-second timer both trigger `orchestrator.reconcile()`, which:

1. resolves effective content for every screen,
2. starts/stops timetable + transcode pipelines to match what's referenced,
3. adds/patches/deletes MediaMTX paths to match,
4. samples each screen path's live state and pushes a status update over WebSocket.

Reconciles are coalesced so overlapping triggers collapse into one trailing run.

## The Iqāmah-change announcement poster

A masjid announces a change twice: on the screens, and in the WhatsApp group. The screens are the red
bottom band; `render/announce.ts` is the second one — a 4:5 PNG the admin downloads from the Salah-times
tab (`GET /api/timetables/:id/iqamah-change.png`) carrying the masjid name, logo, the whole timetable for
the change date, and the changed rows marked with the time each is replacing.

Two things keep it honest. The detection is `nextIqamahChange` in `svg.ts` — the *same* function the
on-screen band formats its sentence from, so the poster and the wall cannot announce different things. The
times come from `buildModel`, evaluated on the change date and the day before it, so "what will Asr be" has
exactly one implementation. It renders on the preview worker like every other raster, because a synchronous
resvg call on the main thread would stutter every live screen the moment someone pressed the button.

## Public web widget

Any timetable can opt in (`widget.enabled`) to an embeddable prayer-times card served **unauthenticated** at
`/w/<id>` (HTML) and `/w/<id>.json` (data). It is the only public surface in the app, so it is deliberately
narrow: off by default, 404 (not 403) when off so an id isn't probeable, rate-limited per client
(`RequestLimiter`, keyed on the forwarded client address so tunnel visitors don't share one bucket), and it
sets its own `frame-ancestors *` because being framed by a masjid's website is the entire point. The page is
self-contained (inline CSS/JS, logo embedded as a data URI) and re-fetches its own JSON so the countdown
stays live. `print.ts` builds the printable month calendar from the same model.

## Volunteer page

A bone-simple mobile page, gated by a hashed 4–8-digit PIN and a **separate** short-lived cookie with its own
token audience (`aud: 'vol'`), so a volunteer token can never be replayed as an admin one. It serves the
*same* SPA bundle but injects `window.__OMD_VOLUNTEER__=true` (and the base path it is served under) into the
HTML, so the app boots into `VolunteerApp` instead of the admin dashboard. It exposes only
`/api/volunteer/{session,login,logout,tvs,tvs/:id/set,tvs/:id/resume}` — never an admin endpoint — and stays
inert (403) until an admin enables it and sets a PIN.

It is reachable two ways, from **one** handler instance (so both share a single PIN rate-limiter):

- on its own port (`VOLUNTEER_PORT`, container 8081 → host 7861), for a clean LAN URL that can be firewalled
  separately; and
- on the **main** port under `/volunteer`, so it rides the OpenMasjidOS tunnel with no platform change. That
  mount is gated by the `volunteerRemote` setting — turn it off and the path 404s, leaving the LAN port only.

## OpenMasjidOS Fabric (optional)

The **OpenMasjidOS Fabric** is the platform↔app appearance + SSO layer. When installed through
OpenMasjidOS the platform injects `OPENMASJID_BASE_URL`, `OPENMASJID_APP_ID`, and — for `sso: true` apps
(this one) — a per-app `OPENMASJID_APP_SECRET`. Everything here is additive: with those unset the app
behaves exactly as a standalone install. Full contract in [`FABRIC.md`](FABRIC.md).

- **Appearance inheritance** — on open, the dashboard appends a `#omos=<base64url json>` fragment
  (theme, wallpaper, custom wallpaper image). `prefs.ts` applies + persists it and clears the hash (no
  network needed). While "Match OpenMasjidOS" is on, it also polls `GET <base>/api/public/appearance`
  (~45 s and on focus) so live dashboard theme/wallpaper changes follow.
- **Single sign-on (identity-bound)** — the platform's `omos_session` cookie reaches us (same host,
  different port = same-site). The backend validates it **server-to-server** against
  `GET <base>/api/auth/session` (`fabric.ts`; positive results cached ~45 s, and outbound probes capped at
  10/s so an anonymous caller can't turn this app into a flood generator), **presenting our per-app secret
  in the `X-OpenMasjid-App-Secret` header** — the platform fails closed without it, so the shared cookie
  can't let another installed app validate as us. On success it mints a local session, so every other
  endpoint and the WebSocket stay a simple synchronous cookie check. It never trusts a browser-supplied
  identity, and falls back to the app's own password whenever the base URL/secret is unset, the cookie is
  absent, or the platform is unreachable.
- **Notifications** (`notifications: true`) — the app relays alerts to the masjid's configured webhook via
  `POST <base>/api/fabric/notify` (`fabric.ts` `notify()`), authenticated with the per-app secret. The app
  never sees the webhook URL (the platform owns the destination — no SSRF from the app). It **fails soft**:
  no platform / not enabled → `delivered:false` and the app carries on. Used by the screen monitor below.
- **Public URL** (`domain: true`) — `GET <base>/api/fabric/site` tells the app its public address behind the
  admin's Cloudflare tunnel, so the widget embed code and the volunteer link can point at it instead of a
  LAN address. Authoritative (the platform only answers when it is actually routing this app's path) and
  fails soft to the LAN link.
- **Admin commands** (`commands:`) — the ONLY inbound Fabric route. OpenMasjidOS calls
  `POST /fabric/commands/run` (`fabricCommands.ts`) when an admin picks one of this app's commands from a
  WhatsApp menu, presenting *our own* app secret plus `X-OpenMasjid-Caller-App: omos:platform`; both are
  required, and a request carrying any `x-forwarded-*` is refused, because a genuine platform call is
  direct and LAN-only. `iqamahWizard.ts` holds the conversation behind it — a follow-up token per sender,
  drafts that expire, and nothing written to the timetable until the admin sends `save`.
- **WhatsApp** (`whatsapp: true`) — the app posts the Iqāmah-change notice to a group the admin approved,
  via `GET/POST <base>/api/fabric/whatsapp` and `GET .../groups` (`fabric.ts`). The **platform owns the
  sending**: one paced queue shared by every installed app, because ban risk attaches to the masjid's
  number rather than to any one app. The app never learns the gateway address, its key, or which number
  is linked, and a post returns `202 {queued:true}` — accepted for later delivery, never a delivery
  receipt. `whatsappAnnounce.ts` decides *whether* and *what*: it re-checks the lead-time window every
  minute (so a change added on the day still goes out), announces each change exactly once by reading
  the dedupe key back out of the persisted `whatsappLog`, and gives up after 5 failures. It posts the
  **poster PNG** when the platform advertises `media` (checked *before* rendering, which is not free on
  a Pi) with a short caption naming what moved; every media failure falls back to the **full** text
  notice, never the caption alone. Both are built from the poster's own `PosterModel`, and the renderer
  is handed that model rather than re-detecting — its own rule skips a change taking effect today.

## Screen offline/online alerts

No probe or extra config — we reuse what the system already knows: whether a screen is **pulling its RTSP
stream**. Each screen's `tv_<id>` path is on-demand, so MediaMTX reports `readers ≥ 1` exactly when a decoder
is connected and showing the stream (`orchestrator.ts` sets `TvStatus.streamReady` from that). When a screen
stops pulling for more than ~90s (debounced so brief content switches / power-cycles don't flap), the
orchestrator relays an **offline** alert through the Fabric, and a **back-online** one when it resumes. A
screen that is *lit up but stale* raises the same alert, worded for that fault — wrong times on the wall are
worse than a blank screen. Screens intentionally set to **Off** are not monitored. The panel shows the badge
from the same signal. Alerts never affect streaming.

## Release channels

`main` and `dev` publish different images, and the branch decides which: `dev` publishes
`:X.Y.Z-dev.N` + `:dev`, `main` publishes `:X.Y.Z` + `:latest`, and `docker-compose.yml` on `main` is
additionally pinned by `@sha256`. A **`v*` tag publishes nothing** — deliberately: these builds are not
reproducible (BuildKit stamps `created` into the image config), so a tag build would republish `:X.Y.Z`
under a *new* digest and invalidate the very pin the release just made. `verify-release-tag.yml` runs on
the tag instead, and only compares what is pinned against what the registry serves. The version string is load-bearing — OpenMasjidOS detects an update by
comparing the catalog's version with the installed one — so CI refuses to publish a dev build without a
`-dev.N` suffix or a stable build with one. See [`../CLAUDE.md`](../CLAUDE.md) § *Branching policy*.

## Security & least privilege

- No `privileged`, host namespaces (`network/pid/ipc/userns/cgroup/uts: host`), `cap_add`, `devices`,
  `device_cgroup_rules`, `security_opt: unconfined`, `group_add`, Docker socket, sensitive mounts, or
  `extends:`/`include:` — passes the OpenMasjidOS compose risk-check at both catalog build and install
  (tightened in platform v0.19.2).
- Single-admin auth via a signed, HTTP-only, **audience-bound** session cookie; scrypt hashing and
  constant-time comparison. The `Secure` variants carry their own cookie names, because the app is published
  on both a TLS-proxied and a plain-HTTP port of the same host and a shared name would let the HTTPS cookie
  permanently block the HTTP fallback.
- OpenMasjidOS SSO (when present) is verified server-to-server and only ever trusts the cookie actually on
  the request; it augments, never replaces, the local password fallback. Under a *reachable* platform,
  `/api/setup` refuses an anonymous local-admin claim — otherwise it would stay permanently open, since
  under SSO no local password is ever set.
- Source URLs are **scheme-allowlisted** (`validate.ts`) and ffmpeg is always invoked with an argument
  array and a `-protocol_whitelist` of stream protocols only — never a string-interpolated command — so a
  crafted camera URL can neither inject arguments nor reach `file:`/`http:`.
- Uploaded images are validated by magic bytes, stored under a sanitised basename, and served with
  `nosniff` and a sandbox CSP (an uploaded SVG is active content).
- The platform injects no masjid profile; everything masjid-specific is collected by the app and stored in
  its own volume.

Known-open items, with the reasoning for each, are in [`audit/ACTION_REQUIRED.md`](audit/ACTION_REQUIRED.md).
