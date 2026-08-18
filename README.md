<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->
<p align="center">
  <img src="assets/Display - rounded corners.png" alt="OpenMasjid Display" width="280"/>
</p>

<h1 align="center"><b>OpenMasjid Display</b></h1>

<p align="center">
  <a href="#what-it-does">Features</a> |
  <a href="#-whatsapp">WhatsApp</a> |
  <a href="#how-it-works">How it works</a> |
  <a href="#put-your-prayer-times-on-your-website">Website widget</a> |
  <a href="#install-through-openmasjidos">Install Guide</a> |
  <a href="#license">License</a>
</p>

<div align="center">
  <a href="https://github.com/OpenMasjid-Solutions/OpenMasjidDisplay/releases">
    <img src="https://img.shields.io/github/v/release/OpenMasjid-Solutions/OpenMasjidDisplay?style=flat-square&color=blue" alt="Latest Release" />
  </a>
  <a href="https://github.com/OpenMasjid-Solutions/OpenMasjidDisplay">
    <img src="https://img.shields.io/github/stars/OpenMasjid-Solutions/OpenMasjidDisplay?style=flat-square&color=blue" alt="Stars" />
  </a>
  <a href="https://discord.gg/MpPDbyQfaF">
    <img src="https://img.shields.io/badge/Discord-Join-blue?style=flat-square&logo=discord" alt="Discord" />
  </a>
</div>

<h5 align="center">
Leave a star if you like the project! ⭐️
</h5>

---

OpenMasjid Display turns one small computer (a mini-PC, a Raspberry Pi, or a Proxmox container) into the
control room for every TV in your masjid. Each screen gets its own network video link (**RTSP**) that you
point a cheap RTSP-to-HDMI decoder box at **once** — then you decide, from your phone or a computer, what
each screen shows. No app on the TV, no browser to babysit, nothing to log into at the screen.

<div align="center">
<img src="screenshots/1.svg" width="49%" alt="Prayer timetable display" />
<img src="screenshots/3.svg" width="49%" alt="Control panel" />
</div>

## What it does

Everything below is in the app today.

### 🕌 Prayer timetables

Beautiful, full-screen prayer clocks **calculated on the device** — no internet needed, no subscription, and no
third-party service that can go down or start charging. Make **as many as you need** (up to 40), each with its own colours
to match the room it hangs in, and design them in a **live editor** with a preview that updates as you type.

**Layout and look**

- **Three layouts** — centered, a next-prayer **spotlight**, or a split view with a big countdown.
- **Layout carousel** — optionally rotate through the layouts over the day to gently avoid TV burn-in.
- **Portrait or landscape**, 720p or 1080p, with an optional **bitrate cap per size** if your network is tight.
- **Theme presets**, plus your own **accent colour**, **gold accent** (Arabic names, Jumu'ah, the next-prayer
  highlight) and **text colour** — or leave text on **auto-contrast**, which adapts to a light photo behind it.
- **Your own background image** and **masjid logo** (PNG, JPEG, GIF or SVG), or the built-in themed scene
  and mark.
- **A live sun and moon** arcing across the sky by your local time, casting rays and glow onto the glass.
- **Rename anything by clicking it in the preview** — any prayer name, the masjid title, or the footer.
- **Element toggles** — turn off individually: the countdown, Hijri/Gregorian dates, Sunrise, the logo, clock
  seconds, the footer line, the sun & moon, and even the masjid name itself (for a logo-only header).
- A **masjid name on screen** separate from the timetable's own name in the panel, plus an optional **location
  line** underneath (e.g. "Lansdale, Pennsylvania") and a **footer note**.

**Times and calculation**

- **Every prayer's Adhan and Iqamah**, plus **Sunrise** and **Jumu'ah** — up to six khutbah times, and
  they can start from a date you choose.
- **Calculation methods**: MWL, ISNA, Egypt, Makkah, Karachi, or **Custom** with your own Fajr and Isha
  sun-depression angles. Asr by the **Standard** (Shafi'i/Maliki/Hanbali) or **Hanafi** opinion.
- **Your own time zone**, 12-hour or 24-hour clock, and a live big clock with optional ticking seconds.
- **Hijri and Gregorian dates**, each nudgeable by ±days for local moon sighting.
- **Precautionary Adhan delay** — add up to 60 minutes per prayer if your masjid calls the Adhan after the
  astronomical time. It shifts the displayed Adhan, the countdown, and offset-based Iqamah with it, while
  Sunrise and the sun/moon position stay on the true astronomical times.
- **English, Arabic and Urdu** for dates and labels, right-to-left aware.
- **A calculation-method footnote**, so anyone reading the screen can see how the times were derived.

**Iqamah times, however your masjid keeps them**

- Per prayer: a **fixed clock time**, **minutes after the Adhan**, or **none at all** (e.g. no separate Maghrib
  Iqamah).
- **Upload a whole year as a CSV** — download the ready-to-edit example first, **export** what's currently set,
  and clear it again in one click. Each day takes effect on its own date, in that timetable's time zone.
- **Or set scheduled changes** — "from this date the times are these, until the next change."
- **Tell the congregation before it happens**: an upcoming change appears as a plain-language heads-up —
  *"From Friday, Asr will be at 5:30 PM"* — starting however many days ahead you choose.
- **Download an announcement image** for the change — a portrait card with your masjid name and logo, the date
  it takes effect, and the whole timetable for that day with the changing prayers highlighted and the time each
  one replaces struck through beside it. It follows the timetable's own theme, language and 12/24-hour setting,
  so it looks like your screens. Print it for the noticeboard or send it to the congregation. If nothing is
  scheduled ahead it gives you the most recent change instead, worded for it.
- **Post it to a WhatsApp group automatically** — see [below](#-whatsapp).
- **Check any future day now** with the *Preview date* box, without waiting for it to arrive.

**Around salah**

- **Adhan pop-up** — a brief "it's time for Fajr" over the normal layout when the Adhan arrives.
- **Full-screen Iqamah countdown** for the last few minutes before the jama'ah.
- **Hadith during salah** — while the congregation prays, the screen shows ahadith on salah over a dimmed
  background, rotating through a **built-in library** (turn individual ones off) plus **any you add yourself**,
  in Arabic and/or English.
- **Or blank the screen entirely** during salah, if you'd rather nothing be a distraction at all.
- **Prohibited-time (zawāl) notice** before the Dhuhr Adhan — full-screen, or as a red message along the bottom.

**Announcements**

- **Scrolling ticker** along the bottom for short messages, each with its **own daily time window**, at a
  **scroll speed** you pick from 1 to 10.
- **Image slideshow** — upload announcement images and they cycle as the backdrop between spells of the normal
  display, with prayer times still readable on top. You set how long the timetable shows, how long the
  slideshow runs, how long each image stays up, and an optional daily window.

**Managing them**

- **Duplicate** a timetable to make a variant for another room, **delete** one, and open the editor in its own
  tab. Settings are grouped into tabs so a long form stays navigable.

### 💬 WhatsApp

If your masjid has WhatsApp set up in OpenMasjidOS, Display can announce an Iqamah change to a group and let you
add one from your phone. Both are **off until you turn them on** in Settings → WhatsApp.

**Posting the change to a group**

- Pick an approved group and how far ahead to post — from a fortnight before down to **on the day itself**.
- Add a change later than that, even for today, and it goes out **within a minute** of you saving it. There's no
  separate "urgent" setting; the window simply catches it.
- It posts the **announcement image** above, with a short caption naming what moved. On an older OpenMasjidOS
  that can't send pictures it sends the same notice as text instead, and the page tells you which you'll get.
- Each change is announced **once**. If you edit a time afterwards, **Send now** posts the correction.
- There's a **preview of the exact message** before anything is sent, and a log of what's been queued.

**Adding a change from WhatsApp**

Message the masjid's number with `!display`, pick **Add a scheduled Iqamah change**, and answer the questions —
the date, then a numbered list of prayers, then the time for each. Send **save** to apply it or **exit** to stop.
Nothing is written until you save, and the whole change is read back to you first. Useful when a screen needs
fixing and you're nowhere near a computer.

> **Messages are queued, not sent.** OpenMasjidOS spaces every message out to protect the masjid's number from
> being blocked by WhatsApp, so delivery is a few minutes away — longer inside the quiet hours set there. The app
> will never tell you a message arrived, because it cannot know. WhatsApp is also an unofficial channel: nothing
> here is ever used for anything that has to work, and alerts still go by email and webhook.

Which events go out and to whom is **this app's setting**, not the platform's — OpenMasjidOS's alerts screen only
covers its own alerts, because those go to the admin while these go to the congregation.

### 📷 Cameras and 🖥️ HDMI sources

- Bring in any IP/security camera or an imam camera and put it on a screen with one tap — great for overflow
  rooms and the women's section. Works with **RTSP**, secure **RTSPS**, and **RTMP/RTMPS**, including **UniFi** cameras (turn on
  RTSP in UniFi Protect and paste the link it shows).
- Plug a laptop or a recording into an HDMI-to-network encoder and send it to the screens you choose.
- **Test a link before you save it**, so a typo tells you immediately instead of at the screen.
- Each source is relayed **Direct** (lightest — almost no CPU) or re-encoded for **Most compatible** if a
  stubborn decoder won't play it directly, with its own picture quality for the re-encode.
- **Enable or disable** a source without deleting it.
- Any username and password in a camera link is **kept private** and never shown back in the panel.

### 🖼️ Screens

- Add a screen per TV, give it a **name** and a **room**, and set what it **normally shows**.
- **Copy its link** with one tap — it already points at this server, so there's no IP to look up.
- A **live status dot** per screen, and a badge telling you whether what's showing is the screen's **Default**,
  a **Scheduled** choice, or a **Manual** override — with *"Back to schedule"* to undo the override.
- Change what any screen shows instantly; the decoder keeps the same URL and never needs touching again.

### 🗓️ Schedules

- Weekly rules: **name** it, pick **what to show**, pick **which screens** (or all of them), pick **which days**,
  and set a **from / until** window — which may run **past midnight**.
- **Priorities**, so when two rules overlap you decide which one wins.
- Classic use: switch to the imam camera for Jumu'ah, then back to the timetable afterwards, automatically.

### 📱 Volunteer page

- A bone-simple phone page on **its own address**, unlocked with a **4–8 digit PIN**, so a volunteer can see every
  screen and switch what each shows with a tap — **no admin login**, and you only share that one address.
- Optionally make it **reachable over remote access**, so a volunteer can use it from outside the masjid.

### 🌐 Website widget and 🖨️ printable calendars

Both covered in detail [below](#put-your-prayer-times-on-your-website): an embeddable prayer-times card for your
masjid's own website (live countdown, browsable week table, opt-in per timetable), and printable month calendars.

### 🚨 It tells you when something is wrong

A frozen screen is worse than a dark one: nobody notices a clock that stopped, so the congregation trusts
**wrong Iqamah times**. So:

- If a timetable stops updating, the screen **dims itself and marks a red bar across the bottom**, the control
  panel badges it **"Times out of date"** with how long ago it froze, and you get an alert.
- If the machine's clock is clearly wrong — a dead battery, or it booted with no internet — screens say
  **"Clock is wrong"** rather than showing confident, wrong prayer times.
- If a screen stops pulling its stream you get a **"Screen offline"** notification, and a **"Screen back
  online"** one when it recovers. A screen that's intentionally off is never reported as offline.

Alerts relay through OpenMasjidOS to whatever Slack, Discord or webhook destination your masjid has configured —
the app never sees the URL. There's a **Send a test** button that tells you in plain language exactly why a test
didn't arrive (notifications not turned on, permission not granted, platform address unreachable, and so on).

### ⚙️ The control panel itself

- **Light and dark**, matching the OpenMasjidOS look, with a theme toggle in the account menu; a live wall clock
  in the header; and a bottom dock so it works properly on a phone.
- **Appearance matching** — pull the theme and wallpaper straight from your OpenMasjidOS dashboard, or set them
  here, including a **custom wallpaper image URL**.
- **Defaults** for new timetables (picture quality) and the **time zone schedules run in**.
- Step-by-step *"Connecting a screen"* help right in Settings.
- **"What's new"** in the account menu — the release notes for the version you're actually running, every
  release back to the first, readable with **no internet** because they ship inside the app. OpenMasjidOS
  updates apps quietly in the background, so otherwise nothing ever tells you the app changed under you.
- A **"Source code (AGPL-3.0)"** link in the account menu, as the licence requires.

### 🔌 OpenMasjidOS integration

- **Single sign-on** — click *Open* and you're already signed in with your dashboard login, verified
  server-to-server. Standalone installs use their own control-panel password instead.
- **HTTPS for the control panel** through the platform's TLS proxy, which is what makes clipboard copy and
  `Secure` cookies work.
- **Notifications** relayed to the masjid's configured destination (above).
- **Remote access** — when it's on, the widget embed code and the volunteer page can use your public address
  automatically instead of a LAN one.
- **WhatsApp** — post an Iqamah change to a group, and run the "add a scheduled Iqamah change" command by
  messaging the masjid's number ([above](#-whatsapp)). The app never sees the gateway, its key or the linked
  number: the platform owns the connection and paces every message.

## How it works

```
  Phone / laptop ─▶ Control panel (web)               ┌─ Timetable renderer (SVG → ffmpeg) ─┐
                         │  REST + WebSocket           │                                     ▼
                         ▼                             │                              ┌─────────────┐
                  OpenMasjid Display (Node)  ──────────┘   add/patch paths (API)      │  MediaMTX   │
                         │                              ───────────────────────────▶  │ RTSP server │
                         │  relays cameras / HDMI (on-demand)                          └──────┬──────┘
                         └─────────────────────────────────────────────────────────────────  │  RTSP/TCP :8554
                                                                                              ▼
                                                          Each TV's RTSP decoder ── rtsp://<server>:8554/tv_xxxx
```

Everything above runs in **one container** — the control panel, the timetable renderer and the RTSP
server ([MediaMTX](https://github.com/bluenviron/mediamtx)) — so there's a single thing to install and update.

- Each screen is a **stable RTSP path** (`…/tv_xxxx`). Switching what a screen shows is a single live API
  call — the decoder keeps the same URL.
- Timetables are rendered to a lightweight low-frame-rate **H.264** stream (built as an SVG, rasterised, and
  encoded by ffmpeg) and published into [MediaMTX](https://github.com/bluenviron/mediamtx).
- Cameras and HDMI encoders are **relayed on demand** (only pulled while a screen is watching), or optionally
  re-encoded to a fixed H.264 geometry for maximum decoder compatibility.
- The panel updates over a **WebSocket**, so screen status changes appear without a refresh.
- Rendering runs in a **worker with a deadline**. A render that wedges is recycled rather than left to hang,
  which is what makes the staleness marking above possible instead of a screen quietly freezing.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Put your prayer times on your website

Any timetable can also be **embedded on your masjid's own website** — the same times, no second system to keep
in step. Turn on *"Allow embedding the prayer-times widget"* in the timetable editor and copy the **embed
code** it gives you.

The widget is a self-contained card: masjid name, today's date, a **live next-prayer countdown**, the day's
Adhan/Iqamah table, and an **interactive week table** a visitor can page through (Prev / week picker / Next —
click any day to load it) — side by side on a wide embed, stacked on a phone. It carries your masjid logo, has
no external dependencies, and is served unauthenticated **only for the timetables you explicitly turned it on
for** (off by default, and rate-limited).

If you've enabled remote access in OpenMasjidOS, the embed code points at your public address automatically;
otherwise it uses your LAN address.

**Printable month calendars** come from the same timetable, too: a true month grid (weeks as rows, Sun–Sat
columns) with every prayer's Adhan and Iqamah, Fridays highlighted and Jumu'ah called out. Print it, or use
your browser's *Save as PDF* — the app ships no PDF library, to keep the container light.

## Install (through OpenMasjidOS)

This app installs from the OpenMasjidOS **App Store**. Open your dashboard → App Store → **OpenMasjid
Display** → Install. **There's nothing to fill in** — it's a one-click install.

To add or update it in the catalog, open a PR to
[OpenMasjidAPPS](https://github.com/OpenMasjid-Solutions/OpenMasjidAPPS) editing this app's entry in
`registry.yaml` (never `catalog.json` — that file is generated):

```yaml
  - id: display
    repo: OpenMasjid-Solutions/OpenMasjidDisplay
    ref: v0.69.0                                   # the release tag, for humans
    commit: <40-char SHA of the tagged commit>      # immutable pin — a tag can be moved, a SHA can't
```

On `main`, the image itself is pinned by **digest** in [`docker-compose.yml`](docker-compose.yml)
(`…:<version>@sha256:<digest>`), so a moved tag can never repoint an install at different content. On the
`dev` branch that same line names the branch's own prerelease version (`…:X.Y.Z-dev.N`), which CI publishes
as an immutable tag — see below.

### No install-time settings

By design, the install dialog is empty — you set everything up **inside the app** on first run (masjid
details, screens, timetables, cameras, schedules), all saved to the data volume. This keeps install one-click
and lets you change anything later without reinstalling.

## After installing

1. Click **Open** (the control panel, default host port `7860`). Installed through OpenMasjidOS you're
   signed in automatically over HTTPS, and it matches your dashboard's light/dark theme and wallpaper; on a
   standalone install you create a control-panel password the first time.
2. On the **Screens** page, add a screen and **copy its link** — it already points at this server (the
   address you opened the panel with), so there's no IP to look up.
3. In your TV's RTSP decoder, paste the link and set the transport to **TCP**.
4. Pick what each screen shows (a timetable, a camera, an HDMI source). Done.

Full decoder guidance and troubleshooting: [docs/RTSP_SETUP.md](docs/RTSP_SETUP.md).

## Hardware notes (it's meant to be light)

- The timetable stream is mostly static and runs at a low frame rate, so a **Raspberry Pi 4/5** comfortably
  drives one or two screens at 720p. Use a mini-PC for 1080p or many screens.
- Relaying a camera "Direct" costs almost no CPU. The "Most compatible" (re-encode) option is heavier — use
  it on a mini-PC, or only where a screen won't play the camera directly.
- RTSP is forced to **TCP** for the widest, most firewall-friendly compatibility with commodity decoders.
- Images are published for **amd64 and arm64**, so the same install works on a Pi and on a mini-PC.

### Intel Quick Sync (optional, standalone installs only)

Encoding uses **libx264** by default, which needs no special hardware and is comfortably fast enough for
the timetable stream. On a box that re-encodes several cameras at once ("Most compatible" mode), the CPU
is what limits how many screens you can run — and there, an Intel GPU can take over:

```yaml
# docker-compose.yml
    environment:
      VIDEO_ENCODER: qsv        # or "auto" — use Quick Sync when it's available
    devices:
      - /dev/dri:/dev/dri       # the GPU has to be inside the container
```

The log then says `using Intel Quick Sync (h264_qsv) for video encoding`. If the encoder or the GPU isn't
there, it says why and **falls back to libx264** — your screens keep working either way.

> **This can't be enabled on an App Store install.** OpenMasjidOS refuses to install any app whose compose
> file passes host devices through, so the `devices:` line above would block the install for *every*
> masjid, with or without an Intel GPU. It's available for a standalone `docker compose up`, where you own
> the box. The shipped compose keeps it commented out for exactly this reason.

## Run / build from source

```bash
# server (control plane + renderer) — build, typecheck the tests, run them
cd server && npm ci && npm run build && npm run typecheck:tests && npm test

# control panel (web) — `npm run build` is `tsc --noEmit && vite build`
cd web && npm ci && npm run build

# everything together (Docker; also what the App Store runs)
docker compose up -d
```

`typecheck:tests` is separate on purpose: `tsconfig.json` excludes `*.test.ts` so tests never reach the
image, and the runner (tsx) strips types without checking them — so without it a test that no longer
compiles still passes.

For local development, run the server with `MEDIAMTX_MANAGED=no` (so it won't try to launch the bundled
MediaMTX) alongside your own `mediamtx`, and `cd web && npm run dev` (proxies `/api` and `/ws` to the
server). In the built container the server launches and supervises MediaMTX itself.

**Contributing? Work on the `dev` branch.** This repo runs two channels, and `main` is the stable release
every masjid installs — never commit to it.

| branch | version         | CI publishes                  | installed by                 |
| ------ | --------------- | ----------------------------- | ---------------------------- |
| `dev`  | `X.Y.Z-dev.N`   | `:X.Y.Z-dev.N` **and** `:dev` | the OpenMasjidOS dev channel |
| `main` | `X.Y.Z`         | `:X.Y.Z` **and** `:latest`    | every masjid (stable)        |

Every dev build carries its own `X.Y.Z-dev.N` version and its own immutable image tag, bumped together with
the compose reference. That isn't bookkeeping: the platform spots an update by comparing the catalog's
version against the installed one, so a moving tag republishing new content under an unchanged version is
invisible to it — which is precisely why the dev channel did nothing before `0.67.0-dev.1`. CI refuses to
publish a dev build without the suffix (it would overwrite a stable tag) or a stable build with it.

See [CLAUDE.md](CLAUDE.md) § *Branching policy* and [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

- Runs **least-privilege**: no privileged mode, host networking, devices, or Docker socket.
- The control panel is protected by a single admin password — hashed with **scrypt** and compared in constant
  time, with a signed, HTTP-only, **audience-bound** session cookie that is marked `Secure` whenever the panel
  is served over HTTPS.
- Installed through OpenMasjidOS it can sign you in with your dashboard login — verified **server-to-server**
  with the platform (never trusting the browser), and it falls back to its own password only when the platform
  is absent or unreachable.
- **Stream links are scheme-allowlisted** and ffmpeg is always invoked with an argument array, never a
  string-interpolated command, so a crafted camera URL can't inject arguments or reach where it shouldn't.
- **Rate limits** on sign-in and on the public widget, plus `nosniff`, `no-referrer` and a
  `frame-ancestors` policy on the panel.
- Camera credentials embedded in RTSP links are never shown in the panel, and the platform's per-app secret is
  never logged or returned.
- Every CI action and base image is **pinned by SHA/digest**, so the app you install is the app that was built.
- On a shared network, set a control-panel password and keep RTSP on your LAN.

The findings and fixes from the last full security review are in
[docs/audit/](docs/audit/) — including [`ACTION_REQUIRED.md`](docs/audit/ACTION_REQUIRED.md), which lists
what is deliberately still open and why.

## License

[AGPL-3.0](LICENSE). The prayer-time engine is original work reused from the OpenMasjidAPPS
`prayer-times-display` example by the same author.

Contributions are made under AGPL-3.0 and a **Contributor License Agreement** ([CLA.md](CLA.md))
that lets the project also offer commercial/dual licenses — the public tree always stays AGPL-3.0.
The CLA is signed automatically on your first pull request. See [CONTRIBUTING.md](CONTRIBUTING.md).
