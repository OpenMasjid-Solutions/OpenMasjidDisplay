<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Changelog

Release notes for OpenMasjid Display, newest first. These ship inside the app — the
account menu (top right) → **What's new** shows them with no internet needed.

**`## Unreleased`** is the working log on the `dev` branch and lists *every* change; a release
condenses it into a `## X.Y.Z` section carrying only what a masjid needs to be told. See
CLAUDE.md § *The changelog has two audiences*.

## 0.67.0

- **New: "What's new" in the account menu.** OpenMasjidOS updates your apps quietly in the
  background, so nothing in the panel ever said the app had changed under you. The account
  button (top right) now opens the release notes for the version you are running — every
  release back to the first one — and it works with no internet, because the notes ship inside
  the app.
- **The "Iqamah times are changing" reminder is much harder to miss.** It used to be a quiet
  line in the masjid's own colours. It is now **red**, and it takes the left-hand part of the
  bottom band — the same strip your scrolling announcements use — with the announcements
  carrying on beside it behind a clear divider. Turn announcements off and the reminder simply
  takes the whole strip. Nothing above it shrinks any more (it used to claim a row of its own,
  so the prayer table and the Jumu'ah bar got smaller for the days a change was coming up), it
  stays up while announcement pictures are cycling, and the prohibited-time (zawāl) message
  still keeps the strip to itself when it appears.
- **Fixed: Arabic and Urdu text could come back with one character replaced by a black
  diamond.** A long save — a timetable carrying Arabic hadith text, Urdu labels or an Arabic
  masjid name — reaches the server in pieces, and a letter that happened to fall across the
  join between two of them was stored broken, permanently. Text is now reassembled before it
  is read, so the join can fall anywhere.
- **Fixed: a camera link starting `rtmp://` could be saved and then never play.** The app
  accepted the address but the video engine was not allowed to use that protocol, so *Test
  link* and *Most compatible (re-encode)* both failed while a plain relay of the same camera
  worked.
- **Development-channel updates now actually arrive.** If you had switched OpenMasjidOS to the
  Development channel you were never offered anything, because every dev build published under
  the same version number and image reference and the platform had no way to see that anything
  had changed. **Stable was unaffected throughout**, and remains the channel to stay on for the
  screens people read in the masjid.
- Some hardening you won't see: the volunteer page and the printable calendar, previews and CSV
  exports now send the same browser-security headers as the rest of the panel, and the
  wrong-clock check knows what "too old to be believable" means as of this release.
- Nothing you have set up needs redoing.

## 0.66.1
- **Nothing on your screens changes in this release.** No new features and nothing to set up
  again: timetables, cameras, HDMI sources, schedules, the volunteer page and the website
  widget are all exactly as they were, so there is no hurry to take this one.
- **New: a development channel.** OpenMasjidOS → Update channel can now follow changes as they
  are made, if you ever want to try something before it reaches everyone. **Stable is the
  default and the one to stay on** for the screens people actually read in the masjid.
- The project's own description was brought up to date. It had fallen a long way behind and
  never mentioned two things this app has been able to do for a while: putting your prayer
  times on your masjid's own website as a live card, and printing a whole month's timetable as
  a calendar you can save as a PDF.
- Underneath, releases are built and labelled more carefully, so a development build can never
  reach the stable channel your masjid installs from.

## 0.66.0
- **Security: a single request from anyone who could reach the control panel could stop the
  app.** No password needed, and it worked over and over — every screen in the building would
  go dark for as long as someone kept doing it. Closed.
- **A screen could keep showing a frozen clock and out-of-date Iqamah times indefinitely,
  while the panel still reported it healthy.** Screens now notice, dim themselves and mark a
  red bar on the screen so nobody trusts the times by mistake, the panel badges them "Times
  out of date" with how long ago it froze, and you get an alert.
- **If the clock on the machine is wrong** — a flat battery, or it booted with no internet —
  the screens now say so instead of showing confident, wrong prayer times.
- A damaged session file could have let someone sign in as you. It now refuses instead.
- Your sign-in is no longer sent unprotected when you open the panel over HTTPS.
- The release pipeline is pinned end to end (each build step to an exact verified version, base
  images by digest), and the automatic tests now actually run before a release can ship.
- Nothing you have set up needs redoing.

## 0.62.0 – 0.65.0 (withdrawn)
- **These releases added Raspberry Pi display nodes, and that feature has been withdrawn.**
  If you set a screen up as a Pi node, point an RTSP decoder at that screen's link again.
  0.66.0 and later deliberately do not include it.

## 0.61.0
- **One hadith for the whole salah, instead of a rotation.** The during-prayer screen used to
  cycle through every eligible hadith and alternate languages; it now shows a single hadith for
  the whole prayer, picked for that occurrence — from the ahadith targeted to that prayer if
  there are any, otherwise from the general ones. It stays put for the whole window but varies
  day to day.
- **Arabic and English together**, Arabic on top and a little larger, with the citation
  underneath both — rather than showing one language then the other.

## 0.60.0
- **Iqamah changes are now a schedule, not one day at a time.** Instead of editing single
  dates, you set "from this date, the times are these" and they hold until the next change —
  each prayer carrying forward on its own. That is how masjids actually change iqamah: a few
  times a year, then it stays. CSV import is still there for masjids that set every day.
- **Friday never shows "Dhuhr" on the countdown ring.** It counts to the Dhuhr adhan (labelled
  Jumu'ah), then the 1st jamā'ah, then the 2nd, then Asr — mirroring the weekday flow. Inside
  the prohibited window it keeps the red styling but reads "until Jumu'ah adhan".
- The bottom-of-screen heads-up announces scheduled changes too, and you can confirm one early
  with the preview date picker.

## 0.59.0
- **Check a future day now.** The editor's preview always rendered today, so an Iqamah change
  set for a future date never appeared there and looked as though it had not saved. You can now
  set a **Preview date** and see the screen exactly as it will look that day. (The change always
  did apply correctly on the day itself.)
- Fixed: an invalid stored time zone could blank the whole display instead of falling back.
- Fixed: masjids on the far side of the world (UTC+13/+14) could see the widget's day — and its
  Iqamah override — off by one.

## 0.58.0
- The admin panel now matches OpenMasjid Donations and Kiosk exactly: the backdrop stays the
  dark gradient in both themes, a light custom wallpaper flips the text dark so it stays
  readable, and the account button is the shared glass circle with an accent ring.

## 0.57.1
- Fixed: the account button was a rounded square. The sibling apps use a circle with an accent
  ring, and it is one again.

## 0.57.0
- A tint is laid over a custom wallpaper photo so the dashboard reads clearly on top of it — a
  bright wallpaper used to wash the content out.
- The account button is an accent-tinted chip, matching the OpenMasjidOS profile button.

## 0.56.0
- **Per-day Iqamah changes are a calendar now.** Pick a month, tap a day, set that day's times
  — no more scrolling a 365-row list after a CSV import. Days with a change are dotted. This
  replaces both the flat list and the monthly table.
- **Maghrib is always calculated from sunset** and can no longer be set per day, because a
  fixed clock time cannot track a sunset that moves all year. Its "minutes after Adhan" offset
  stays editable even when a yearly CSV is loaded, and CSV import now discards any Maghrib
  column. This reverses the approach taken in 0.55.0.

## 0.55.0
- A per-day Iqamah time could be written as a signed offset from that prayer's adhan ("+5",
  "-3") instead of a fixed clock time, so Maghrib could track sunset. Replaced in 0.56.0 by
  handling Maghrib properly.

## 0.54.0
- **New setting: whether the volunteer page is reachable over remote access** (on by default).
  Turn it off and the volunteer page stays on your local network only. Its own address is
  unaffected either way.

## 0.53.0
- **The volunteer page works over remote access.** It used to live only on its own port, which
  the OpenMasjidOS tunnel never reached, so a volunteer had to be on the masjid wifi. It is now
  also served under `/volunteer` on the control-panel address, so it works from anywhere remote
  access reaches. Its own local address stays for a clean link on the network.
- Settings shows the public address alongside the local one when remote access is on.

## 0.52.0
- **The Friday ring counts down to Jumu'ah, not Dhuhr**, and never shows Dhuhr on a Friday. A
  Jumu'ah only takes over the ring if it falls no later than the next non-Dhuhr prayer, so a
  mistyped evening time cannot shadow Asr or Maghrib.
- **New: tell the congregation before Iqamah changes.** A line appears in the bottom band a
  chosen number of days beforehand — "From Friday, Dhuhr will be at 1:30 PM and Asr will be at
  5:30 PM". It sits above the scrolling ticker and shows even when the ticker is off. It only
  fires for a deliberate change, so an unedited full-year template never announces anything.

## 0.51.0
- **The during-prayer screen is now a three-way choice**: keep showing the times, show a
  hadith, or go completely black.
- **Iqamah changes on specific dates** got a streamlined editor — pick a date, set only the
  times that differ, Add. It shares one year of data with the CSV import and the monthly table,
  so none of them overwrite each other.
- Arabic on the hadith screen now fills the card instead of sitting in a narrow column; long
  ahadith were wrapping far too early because Arabic vowel marks were being counted as letters.
- Uploaded pictures are converted to a clean PNG in your browser, and the server checks the
  real file contents — a mislabelled or WebP image used to render blank.
- The "?" help tooltips can no longer be clipped by a scrolling panel.

## 0.50.0
- **On Fridays the ring counts down to Jumu'ah** — the 1st, then the 2nd, then Asr. The daily
  table still shows Dhuhr through midday; only the ring changes. The upcoming Jumu'ah is
  highlighted in the website widget too.
- **Prohibited time is now unmistakable**: the ring itself turns red and pulses about once a
  second, next to the red "Prohibited time" label. It always takes precedence over a Jumu'ah
  countdown.

## 0.49.0
- Fixed: between Sunrise and Dhuhr the countdown ring showed a full circle, as though Dhuhr
  were imminent, all morning. It now fills gradually from Sunrise.

## 0.48.0
- **Choose your own gold accent** — the colour used for Arabic prayer names, Jumu'ah and the
  next-prayer highlight. With the primary accent and the text colour, every accent colour on
  screen is now yours to set, which helps a lot on a custom background.

## 0.47.0
- The editor's live preview moved to a collapsible column on the right, so the settings get the
  full height and width. There is a "Hide preview" toggle, and narrow screens stack it below.

## 0.46.0
- **The timetable editor is a full-screen editor** in its own browser tab, instead of one
  cramped column. Live preview pinned across the top, six category tabs down the left (General,
  Salah times, Appearance, During prayer, Announcements, Sharing & print), settings grouped into
  clear cards, and a "?" help badge on every field explaining it in plain language.

## 0.45.0
- **Arabic for all 19 built-in ahadith**, fully vocalized and transcribed verbatim from the
  source. The during-salah card shows Arabic then English.
- **Each hadith can be limited to specific prayers** — the 'Asr ones show only after 'Asr, and
  so on. Leave it empty and it shows after any prayer. Works for the built-ins and your own.

## 0.44.0
- Ships the security fix that closed an unauthenticated admin takeover through first-run setup
  when single sign-on is in use. It had landed after 0.43.0 was built, so no released image
  carried it until now.

## 0.43.0
- **A built-in library of about 19 ahadith on the virtue of Salāh**, shown during prayer out of
  the box on new displays, each with its source citation. Turn any of them off individually, and
  add your own alongside them.

## 0.42.0
- **Per-prayer Adhan delay**, for masjids that call the Adhan a few minutes after the
  astronomical time. The displayed Adhan, any "minutes after Adhan" Iqamah, the countdown and
  the prohibited-time notice all shift with it; Sunrise and the sun and moon stay on the true
  times.
- **New: a brief "it's time for salah" pop-up** when each Adhan arrives, over the normal layout.
  Off by default, and you set how many seconds it stays.
- **The ticker scrolls smoothly on hardware decoders.** It used to move, stop, move — the app
  sent a one-second burst of frames that the decoder played then stalled on. Software players
  hid it; real decoders did not.
- Fixed: on the light theme the ticker text was hardcoded white and unreadable.

## 0.41.0
- The landscape slideshow now shows the full portrait layout as the left column with the
  cycling image filling the right.
- **Prohibited (zawāl) time is no longer a full-screen takeover.** The next-prayer ring reframes
  as a red "Prohibited time" notice counting down until the Dhuhr Adhan, and the rest of the
  screen stays visible.
- A prayer stops being highlighted once its window ends — Fajr un-highlights at Sunrise.
- The website widget uses your uploaded masjid logo.

## 0.40.0
- **The website widget is now interactive.** Two cards that sit side by side on a wide embed and
  stack on a phone: a "today" card with the masjid name, date, a live next-prayer countdown and
  the day's Adhan/Iqamah table including Jumu'ah, plus a week table with Prev / week picker /
  Next where clicking any day loads it into the card.
- The Jumu'ah times are evenly spaced along the bottom bar in both orientations.
- On the announcement slide the image fills the top with the clock and next-prayer ring beneath.

## 0.39.0
- Custom background photos are treated properly: no geometric pattern laid over your photo, and
  a stronger scrim so the text stays readable.
- **Portrait reworked** — the clock and the ring sit side by side so the prayer table gets more
  height, and the Jumu'ah bar no longer collides with the Arabic text.
- **New: set the video bitrate per resolution** (720p / 1080p) if you want to raise or lower
  what the stream uses. Blank keeps the defaults.
- When a yearly CSV is loaded, the manual per-prayer Iqamah rules are greyed out, because the
  CSV overrides them. Clearing the CSV re-enables them.

## 0.38.0
- **Sharper picture**: the timetable bitrate more than doubled, which is nearly free because the
  screen is almost still.
- **Arabic ahadith render cleanly.** Punctuation like quotes and brackets used to come out as
  empty boxes; the app now ships a Naskh face that covers Arabic, Latin punctuation and the ﷺ
  ligature in one font.
- **New: show the prohibited-time notice as a red scrolling message** along the bottom instead
  of a full-screen notice.
- The prayer table moved to the left and the countdown ring to the right, and the ring now reads
  "1 hour 15 minutes" style text instead of only minutes.

## 0.37.0
- **One faithful on-screen design** replaces the multi-layout system: brand and location top
  left, live clock top right, a circular next-prayer countdown ring with the Arabic and English
  name, the bilingual prayer table with the active prayer highlighted, and a Jumu'ah bar across
  the bottom.
- **New "Parchment" light theme**, with the glass and clock made theme-aware so cards read
  correctly over a bright background.
- **New: a location line** under the masjid name, and a toggle to hide the name for a logo-only
  header.
- Fixed: the editor preview ignored CSV-imported per-day times and showed the rule times instead.

## 0.36.0
- The display was rebuilt out of composable panels — header, clock, prayer table and a Jumu'ah
  box — so the three layouts (Columns, Sidebar, Spotlight) are arrangements of the same pieces.
  Portrait stacks them, and the carousel still rotates them to avoid burn-in.
- **New: turn the sun and moon off** if you would rather a plain sky.
- The per-day Iqamah editor warns before manual edits overwrite times you imported by CSV.

## 0.35.0
- Fixed: the ﷺ symbol showed as an empty box in ahadith. The app now ships a verified static
  Arabic font rather than relying on the system's variable one.
- **Fixed: Excel broke every Iqamah CSV upload.** Excel reformats dates to "1-Jan", which the
  importer rejected. Month names in several forms are now accepted.
- February in the year editor is leap-aware.
- The Jumu'ah times sit under Isha as a thin gold line, each labelled "1st Jumu'ah", "2nd
  Jumu'ah".

## 0.34.0
- **Jumu'ah shows every day as its own gold strip**, numbered when there is more than one, and
  the daily table always shows the five daily prayers. Previously Jumu'ah appeared only on
  Fridays, where it replaced the Dhuhr row.

## 0.33.0
- Fixed the countdown skipping a second or two every 15–20 seconds. Each frame is now rendered
  well within its budget, and the encoder is never restarted, so the decoder never reconnects.

## 0.32.1
- Fixed: a hadith could show a single empty box mid-line. Pasted source text carried invisible
  direction marks and curly quotes the Arabic font has no glyph for; text is now cleaned before
  it goes on screen.

## 0.32.0
- A new Display app logo throughout — dashboard, sign-in, empty states, the volunteer page, the
  favicon and the App Store icon.

## 0.31.2
- Fixed: the copied widget link could open an empty page when the panel was reached over HTTPS,
  because the link was built with the wrong scheme and port. It is now built from the address you
  are actually on.

## 0.31.1
- **Fixed: the public widget link could open a different app.** The platform's tunnel does not
  route per-app paths yet, so the link fell through to whichever app owned the hostname. The app
  now checks that the public link really reaches this app before advertising it, and falls back
  to your local link with a note if it does not.

## 0.31.0
- **The control panel is served over HTTPS** through the platform's TLS proxy. That gives it a
  secure context, which is what "Copy" on the widget embed code needs, and lets the sign-in
  cookie be marked secure. The plain address stays available as a fallback.
- Copy also works on the plain address now, via a fallback for browsers outside a secure context.

## 0.30.0
- **New: an embeddable website widget.** Turn it on for a timetable and you get an `<iframe>`
  snippet for your masjid's own website — a self-contained prayer-times box, right-to-left aware,
  refreshing itself. It uses your public address when remote access is on, otherwise your local
  one.
- **Two or more Jumu'ah times** now read as "Jumu'ah 1", "Jumu'ah 2" instead of being mistaken
  for one Jumu'ah's Adhan and Iqamah.
- Fixed: Arabic in ahadith showed as empty boxes, because modern Arabic fonts ship in a form the
  app was not matching. Arabic shows for 10 seconds, then English, and long ahadith shrink to fit
  instead of overflowing.

## 0.29.0
- **Fixed: you could be locked out of the panel entirely** after an OpenMasjidOS backup or
  restore, especially onto a new machine — single sign-on was still configured but unreachable,
  and setting a local password was refused. A local password is now always available as a
  recovery, and the first-run screen leads with it (plus a "Retry sign-in" button) when the
  platform cannot be reached, instead of looping silently.

## 0.28.0
- 4K support is removed. It strained the render and encode pipeline and the benefit on a wall
  display is marginal. Anything set to 4K is moved back to 1080p automatically, and the countdown
  and clock fixes from 0.27.x are kept.

## 0.27.1
- Fixed: the countdown jumped down by two seconds at a time whenever a frame took longer than a
  second to draw.

## 0.27.0
- **Fixed: the clock could read up to a minute fast.** It was rounding the minute rather than
  flooring it, so 10:53:40 showed as 10:54.
- 4K streams were made reliable by rendering at 1080p and letting the encoder scale up — a native
  4K frame was far too heavy to redraw every second, so the stream often never started.

## 0.26.0
- 4K (2160p) added as a picture-quality option for timetables and sources. 1080p stayed the
  default. Removed again in 0.28.0.

## 0.25.0
- The OpenMasjid crescent-and-dome logo replaces the old brand mark across the dashboard,
  sign-in, empty states, the volunteer page and the favicon, and themes itself light or dark.
- **The printable calendar fits on one page** for any month, 4 to 6 weeks, without rows splitting
  across pages.
- **Ahadith now hold Arabic and English per item**, with the Arabic above the English.
- **New: a full-screen countdown for the last minutes before each Iqamah** ("please line up").
- The scrolling ticker is hidden while a full-screen notice is showing.

## 0.24.0
- **The printable monthly sheet is a real calendar grid** — weeks as rows, Sunday to Saturday
  columns, every prayer's Adhan and Iqamah in each day cell, the Friday column highlighted in
  gold with a Jumu'ah callout, and your masjid logo and name in a branded header. It prints
  landscape and keeps its shading through "Save as PDF".

## 0.23.0
- A maintenance release with no notes of its own.

## 0.22.0
- **Fixed a highlight bug**: once a prayer's Adhan had passed but its Iqamah had not, the screen
  moved on to the next prayer. It now stays on that prayer and the countdown reads "Iqamah in".
- **New: ticker scroll speed** from 1 to 10.
- AM/PM is uppercase everywhere, and the dashboard gained a live clock in the top-left corner.

## 0.21.0
- Licensing put in order: an SPDX header on every source file, the licence recorded in the app
  manifest, and — as the AGPL requires — a **"Source code (AGPL-3.0)" link in the account menu**
  pointing at the exact version you are running.
- The sign-in cookie can be marked secure when the panel is served over HTTPS.

## 0.20.8
- The project moved to the OpenMasjid-Solutions organisation. No change to how the app works.

## 0.20.7
- A release cut purely to publish an image that could be pinned by digest, so an install can be
  tied to exact content rather than a movable label.

## 0.20.6
- Security hardening: a warning when a secret would be stored in the clear, and the uploaded-image
  serving path sandboxed.

## 0.20.5
- **Fixed the real reason single sign-on and notifications never worked.** The platform passes its
  credentials by writing them to a file that only fills in `${...}` placeholders — and this app's
  compose file never referenced them, so the container never saw any of them. Both features were
  silently disabled. Updating the app pulls the corrected file and the credentials finally arrive.

## 0.20.4
- The notification test now prints exactly which of the three platform credentials is missing,
  rather than collapsing them into one message.

## 0.20.3
- The notification guidance now tells you to update OpenMasjidOS itself first, then the app —
  which matched the real cause of undelivered alerts (a stale platform, not a reinstall).

## 0.20.2
- **No decoder IP to enter any more.** Offline detection now uses what the app already knows —
  whether a screen is pulling its stream — so there is nothing to fill in. A screen that stops
  pulling for 90 seconds raises an alert, and a screen set to Off is never called offline. A
  platform outage cannot mark every screen offline at once.

## 0.20.1
- **New: "Send a test notification"** in Settings → Notifications. It sends a real alert and turns
  the result into one clear sentence — missing credentials, notifications not enabled, the platform
  address unreachable from the container, permission not granted, and so on.

## 0.20.0
- **New: alerts when a screen goes offline**, relayed through OpenMasjidOS to whatever webhook
  your masjid has configured. The app never sees the webhook address.

## 0.19.1
- Fixed: "Test connection" always failed with an option error, because the bundled encoder is an
  older build that does not accept one of the flags used.

## 0.19.0
- **New: "Test connection" for a camera.** It really connects and reads a frame, trying TCP then
  UDP, and reports what actually happened — wrong password, certificate problem, wrong port — with
  any username and password removed from the message.

## 0.18.1
- Fixed RTSPS cameras: a flag added in 0.15.0 is not accepted by every encoder build and broke the
  camera transcode.
- The low-bandwidth mode from 0.17.0 is removed; the case that prompted it turned out to be a
  network configuration issue rather than the app.

## 0.18.0
- **New: Duplicate a timetable.** A full copy, including its uploaded background, logo and
  announcement images, so a near-identical screen is one tweak instead of a rebuild. Deleting the
  original never affects the copy.

## 0.17.0
- A low-bandwidth mode for screens reached over a slow off-site link. Removed again in 0.18.1.

## 0.16.0
- The colons on the main clock blink once a second, like a digital clock.
- **The accent colour can come from your wallpaper** automatically, so the screen harmonises with
  a background photo unless you pick a colour yourself.
- Fixed: replacing a wallpaper or logo appeared to do nothing, because the new file reused the old
  name. A replacement now shows up everywhere immediately.

## 0.15.0
- **New "Spotlight" layout** — a slim top bar, a large hero card focused on the next prayer with a
  progress bar, and the day's prayers as a ribbon along the bottom.
- **Secure (RTSPS) and UniFi cameras supported**, including UniFi's secure stream links. The source
  dialog explains how to enable RTSP in UniFi Protect.

## 0.14.1
- Fixed: the Adhan column and the column headers washed out to unreadable grey over a busy light
  photo. Those shades are now solid rather than semi-transparent.

## 0.14.0
- Brought into line with the platform's identity-bound single sign-on, so the app proves its own
  identity when it checks who you are. On an older platform that cannot issue it a credential,
  single sign-on simply stays off and the app's own password is used.

## 0.13.0
- **Text colour control**: Auto, Light, Dark or any colour you choose. On Auto, if your background
  photo is light enough that pale text would wash out, the app measures the photo and switches to
  dark text.
- A bigger masjid name in the sidebar layout that shrinks rather than overflowing.

## 0.12.1
- The editor preview now cycles through the layouts while "Rotate layouts" is on, so you can see
  what the screens do. The screens themselves always rotated correctly.

## 0.12.0
- Security hardening from an audit: sign-in sessions are bound to what they are for, so a
  volunteer's session can never be replayed as an admin one (everyone signs in once more after
  this update); repeated failed sign-ins are throttled and locked out on both the admin and
  volunteer pages; camera links are restricted to streaming addresses only.
- **Fixed: on Fridays the countdown targeted astronomical Dhuhr rather than the Jumu'ah time.**
- Fixed: an invalid time zone no longer blanks the display, and announcement images are contained
  in a 16:9 frame instead of being cropped.

## 0.11.0
- The ticker scroll was moved into the encoder, which made it smooth and removed the picture
  corruption some decoders showed. Messages are now clearly separated by a gold bullet.

## 0.10.0
- **New: enter your own Fajr and Isha angles** for a custom calculation method.
- Hanafi became the default Asr opinion for new timetables.
- The announcement slideshow pushes the timetable into a sidebar and shows the image sharp beside
  it, instead of taking over the background.
- **New: a monthly grid for the yearly Iqamah times**, so no CSV round-trip is needed.

## 0.9.0
- **New: an image announcement slideshow.** Upload images that cycle as the backdrop while the
  prayer times stay readable on top, on a timer, within an optional daily window.
- **New: a scrolling text ticker** for short messages, each with its own daily window.
- Time zone is a dropdown labelled by abbreviation (EST, PDT, PKT…).

## 0.8.1
- Every prayer card's big time sits at a fixed height, so Sunrise lines up with the rest.
- The clock and headings use a clean sans face matching the rest of OpenMasjidOS.
- A custom wallpaper fully replaces the built-in one instead of being layered over it.
- **New: nudge the Hijri and Gregorian dates by ±days** for local moon sighting.

## 0.8.0
- Prayer cards show the **Iqamah (jamā'ah) time prominently** with the Adhan small underneath —
  that is the time the congregation cares about.
- **New: a PIN-gated mobile volunteer page** on its own address. A volunteer sees every screen and
  taps to switch what each shows, with no admin login. Off by default; enable it and set a 4–8
  digit PIN in Settings. Only volunteer functions are served there, never the admin ones.

## 0.7.2
- The countdown ticks live in every layout, seconds no longer overlap the dates in the split
  layout, and there is a toggle for the calculation-method footnote.
- **The timetable editor opens as a full page in its own tab**, with room to work, a sticky Save
  bar and the same live preview and click-to-rename.

## 0.7.1
- The sun was toned down to a soft warm orb, and sign-out and the light/dark toggle moved into a
  **top-right account menu** that also links to Settings and shows the version.

## 0.7.0
- A reworked sun with a warm corona and light falling onto the glass panels; the moon gets a glow.
- **New: show seconds on the clock.**
- **New: upload your own masjid logo** per timetable.
- **New: click a prayer name, the masjid title or the footer in the preview to rename it.**
- **New: import a whole year of Iqamah times as a CSV**, with an example template to edit,
  export and clear.

## 0.6.3
- Timetable frames are drawn on a background thread. Drawing them on the main one pegged a core on
  a small machine, made streams take minutes to start or never appear, and left the panel sluggish.

## 0.6.2
- Fixed: the timetable could stop publishing entirely because the font selection had excluded the
  base Latin font, leaving the renderer stuck.

## 0.6.1
- **Fixed: the container could die at random.** When the encoder exited, an unhandled error on its
  pipe crashed the whole app.
- Fixed streams failing to start because the heavy blur effects added in 0.6.0 starved the
  encoder, and prayer card times overlapping.

## 0.6.0
- **A sun or moon arcs across the sky** by your local time and casts its glow onto the glass panels.
- The split layout was rebuilt with a dense prayer list on the left and a big countdown on the right.
- **New: rotate the layouts every 15 minutes** to avoid burn-in on a TV.
- Shia calculation methods were removed; stored values move to MWL.

## 0.5.1
- Timetables saved before 0.5.0 are filled in with sensible defaults on load, so upgrading never
  silently hides the dates, countdown or logo.

## 0.5.0
- The on-screen timetable was redesigned in the OpenMasjidOS glass style, with three layout presets
  and per-element toggles.
- **New: a custom background image** per timetable, frosted behind the glass.
- **New: a live editor** with a real preview that updates as you type, a colour picker and an
  address lookup link.

## 0.4.1
- Fixed: screens could not stream at all, because the bundled RTSP server shipped with a
  configuration that had no catch-all path, so nothing could publish.

## 0.4.0
- **Everything runs in one container now** — the panel, the renderer and the RTSP server — so there
  is one thing to install and update.
- **No server address to enter.** Each screen's link is built from the address you opened the panel
  with.
- **OpenMasjidOS integration**: the panel can follow your dashboard's theme and wallpaper, and sign
  you in with your dashboard login, verified server to server. It still works standalone.

## 0.3.0
- The panel follows your device's light or dark preference by default, with wallpaper presets
  mirroring OpenMasjidOS and an optional custom image.
- **New: 720p/1080p per camera or HDMI source.**

## 0.2.0
- **Install is one click.** Every setting moved into the app: you create the admin password on
  first run and set up your masjid details, screens, cameras and schedules inside, saved to the
  data volume.

## 0.1.0
- **The first release.** One small computer becomes the control room for every TV in the masjid.
  Each screen gets a stable RTSP link you point a decoder at once, and you choose what it shows —
  a themed prayer timetable calculated on the device, a camera, or an HDMI source — from a phone
  or computer, with weekly scheduling.
