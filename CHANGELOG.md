<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Changelog

Release notes for OpenMasjid Display, newest first. These ship inside the app — the
account menu (top right) → **What's new** shows them with no internet needed.

**`## Unreleased`** is the working log on the `dev` branch and lists *every* change; a release
condenses it into a `## X.Y.Z` section carrying only what a masjid needs to be told. See
CLAUDE.md § *The changelog has two audiences*.

## Unreleased

### Added
- **Reboot a Raspberry Pi screen from the dashboard.** Alongside Update and Restart, there is now
  a Reboot button for when restarting the software is not enough. The Pi limits itself to one
  reboot every ten minutes, so a stuck screen cannot end up cycling out of reach.

- **Update and restart a Raspberry Pi screen from the dashboard.** Each Pi screen now has Update
  and Restart buttons on its card. Nothing connects to the Pi — it picks the instruction up on its
  own, within about five seconds — so the dashboard says it has been asked, not that it is done.
  Update checks for a newer version and restarts only if it finds one.

### Fixed
- **A camera on a Raspberry Pi screen stops blinking every half minute.** Two causes. The screen
  kept retrying the Pi’s video hardware on a board that does not have it, costing two black
  seconds every time it reconnected; and when a camera ended a stream normally — which some
  cameras do every thirty seconds — that was treated as a fault and the wait before reconnecting
  grew each time.

### Fixed
- **A long date no longer runs past the edge of its panel.** On the layout that shows the whole
  date on one line, something like “Wednesday, September 30, 2026” was too wide for a narrow
  panel. It now shrinks slightly to fit, exactly as the clock above it already did, and short
  dates are left at full size. This affected every kind of screen, not just Raspberry Pi ones.

### Fixed
- **A Raspberry Pi screen no longer reports a speed warning as a broken camera.** It was showing a
  note about colour conversion in place of the actual reason, which hid whatever had really gone
  wrong.

### Fixed
- **A camera that drops now comes back straight away instead of taking longer each time.** A stream
  that played for half a minute and then dropped was being treated as if it had never worked, so
  each gap grew — one second, then two, then four, up to thirty. Anything that played for more
  than ten seconds now counts as working, so the picture returns almost immediately.

### Fixed
- **The cursor really does stay in the text box now.** Any dialog in the panel could steal focus
  back to itself whenever the page behind it refreshed, which took the cursor out of whatever you
  were typing. It affected every dialog, not just the Raspberry Pi one.

- **A Raspberry Pi screen updates far more smoothly.** It was holding most of the processor in
  reserve for playing a camera — but a screen shows the timetable or a camera, never both, so the
  reserve was never used and the clock updated every few seconds instead of every second.

### Fixed
- **The timetable no longer looks washed out on a Raspberry Pi screen.** Some Pis come up with a
  screen mode that has far fewer colours available, which turned every gradient into flat bands.
  The Pi now blends those shades instead, and setup asks the Pi for full colour so the problem
  does not arise in the first place.

### Fixed
- **Text no longer spills outside its box on a Raspberry Pi screen.** The Pi was drawing with a
  different font than the layout was measured against, so everything came out slightly too wide.
  It now uses exactly the fonts the display server does.

- **A camera on a Raspberry Pi screen recovers properly.** Three faults: a stalled camera could
  leave the last frame frozen on the television indefinitely with nothing reported; a camera that
  dropped repeatedly got stuck waiting the full thirty seconds before every retry; and a stream
  that failed quickly for an unrelated reason made the screen stop using the Pi’s video hardware
  for good, doubling its processor use. The reason a camera failed is also reported more usefully.

### Fixed
- **The cursor no longer jumps out of the box while you type a Raspberry Pi setup code.** The form
  was being rebuilt whenever the list of waiting screens refreshed, which threw away what you had
  typed. You can also now type a code straight off the television before the list has caught up.

- **A Raspberry Pi screen no longer shows a video link that does not work.** It never had one: the
  Pi draws the timetable itself and opens cameras itself, so the server publishes no stream for it.
  The card now shows what is actually useful — whether the Pi is checking in, its address on your
  network, and the version it is running.

### Fixed
- **A Raspberry Pi screen now follows the television if it changes resolution.** Some sets settle
  on a different mode a few seconds after switching on, and the picture would go from correct to a
  magnified corner and stay there. It now notices and redraws at the new size.

### Fixed
- **A Raspberry Pi screen now asks the system what size the television actually is**, rather than
  working it out from settings that can describe a larger area than is really shown. On some sets
  the picture was drawn too big and only its corner appeared.

### Fixed
- **A Raspberry Pi screen on some televisions was drawn too large and cut off at the right.** It
  now uses the size the television is actually showing rather than the size of the memory the Pi
  set aside for it, which on some sets is larger.

### Fixed
- **Raspberry Pi setup now finishes.** The last step failed with a shell error, which left the
  screen software installed but its settings half-applied.

### Fixed
- **A Raspberry Pi screen now starts.** It was restarting every five seconds without ever drawing
  anything, because of a security setting on the screen software that stopped it looking up its
  own network address.

- **The television no longer freezes on boot messages.** The screen software took the display over
  before it had anything to put there, so whatever the Pi was printing at that moment stayed on
  the television — which looks exactly like a Pi stuck restarting. It now draws immediately, and
  the display is only taken over once there is something to show.

- Not being able to work out its own address no longer stops a screen working at all. It is shown
  on the setup screen to help with network problems, and nothing more.

### Fixed
- **The Raspberry Pi installer no longer fails part-way through.** It reported the screen
  software it had just downloaded as invalid and stopped, on every Pi, because of the temporary
  filename it used while checking it.

- **A Pi set up against a server with its own certificate now keeps updating itself.** It would
  have stopped silently a few minutes after setup and then run the same version forever, with
  nothing on the screen or in the dashboard to say so.

- **Setup now checks that the screen software itself can reach your server**, not only that the
  download worked. The two check certificates differently, so an install could report success and
  still leave a screen that never connected.

- **If the Pi cannot reach your display server at all, setup now stops and says so**, instead of
  quietly continuing with weaker security because of what is usually a typo or a network problem.

### Changed

- **Setting up a Raspberry Pi has moved into Add screen.** Adding a screen now asks how it
  receives the picture — a decoder box, a web page, or a Raspberry Pi — and choosing Raspberry Pi
  gives you the command and the box to type the code into, rather than a separate panel further
  down the page.

### Fixed
- **Setting up a Raspberry Pi screen now works when the display server uses its own certificate.**
  Most masjids reach the server at a local address like `https://192.168.1.18:8444`, where the
  certificate has to be self-signed — and the setup command was simply refused. The dashboard now
  shows a command that works, and explains the one part of it that is unverified.

- **A Pi set up that way stays connected.** Previously it could install successfully and then never
  reach the server again, because the screen software checks certificates separately from the rest
  of the system. It is now given the server’s own certificate at setup and checks against it.

- **The install no longer looks like it has frozen.** Every step is numbered and says what it is
  doing before it does it, the slow parts warn you they are slow, and if the Pi is busy with its
  own updates the installer says so and waits instead of sitting silent. Installing video support
  is now a separate step, and if it fails the screen still shows prayer times.

### Added
- **Raspberry Pi screens keep themselves up to date.** Each one checks with the display server a
  few times a day and switches to the current version on its own, so a masjid with a Pi behind
  every television does not need anybody walking round with a keyboard. If an update will not
  start, the screen puts the previous version back by itself.

- **The Screens page shows what each Pi is actually running.** The version, name and address are
  refreshed while the screen is running rather than fixed at the moment it was set up, so a Pi
  that has updated overnight — or moved to a new address — is listed correctly.
- **A Raspberry Pi screen now plays cameras, and opens them itself.** This is the point of the
  whole thing: the Pi connects straight to the camera on your own network, so the video never
  passes through the display server. A camera stays smooth even when the server is in another
  building or in the cloud — the arrangement that previously reduced a remote screen to about one
  frame every couple of minutes.

- **It uses the Raspberry Pi’s video hardware where it can**, falling back automatically if that
  is unavailable, so a Pi 3 can manage a 1080p camera without running out of processor.

- **A camera that goes away comes back on its own.** If the camera is rebooted, unplugged or
  switched off overnight, the screen keeps retrying — quickly at first, then less often — and
  picks the picture up again within seconds of it returning. While it is down the screen says
  which camera it is waiting for rather than going black.

- **A Raspberry Pi screen now shows the timetable.** It draws the same picture your other
  screens draw, from the same code, so the two cannot disagree — the layout, the countdown, the
  Adhan and Iqāmah overlays, hadith during salah, the prohibited-time notice, the announcement
  slideshow and the scrolling ticker.

- **It uses the masjid’s own clock, not the Pi’s.** A Raspberry Pi has no battery-backed clock,
  so after a power cut its own idea of the time is whenever the memory card was last written.
  The screen follows the display server’s time instead, which is the only way prayer times can
  be right on the first morning after an outage.

- **Your wallpaper, logo and announcements are kept on the Pi.** They are fetched once rather
  than continuously, so a screen uses almost no network after it starts — and it can come back
  after a power cut and show the right picture even while the internet is still down.

- **Arabic renders properly on a Pi.** The screen is sent the same font files the display server
  draws with, rather than relying on whatever the Raspberry Pi happens to have installed, which
  would show Arabic as empty boxes.

- **A slower Pi slows down instead of struggling.** The screen measures how long it takes to
  draw and picks a rate it can keep up with, leaving room for the camera and the network. If it
  cannot manage a live-looking clock it says so in its log and suggests setting that timetable
  to 720p, which roughly halves the work.
- **One command sets up a Raspberry Pi screen.** Screens → Raspberry Pi screens now shows a
  command to paste into a Pi running Raspberry Pi OS Lite. It installs everything the Pi needs,
  starts it automatically at every boot, and the television then shows a setup code to type into
  the dashboard. The command already contains this server’s address — there is nothing to fill in.

- **The Pi draws the screen itself, with no desktop installed.** It writes straight to the
  television rather than running a web browser, which is what lets it work on a Raspberry Pi 3
  with 1 GB of memory instead of needing a newer model. It fits whatever television is plugged in,
  including older 4:3 monitors, without stretching the picture.

- **A Pi screen never goes black without saying why.** While it is waiting to be set up it shows
  the setup code, its own address on your network, and whether it can reach the display server. If
  it later loses contact it says so on the television instead of going dark, and recovers by
  itself when the server comes back. If somebody removes the screen from the dashboard, the Pi
  goes back to showing a fresh setup code rather than needing to be reinstalled.

- Re-running the setup command updates an existing Pi in place. It will not ask you to set the
  screen up again, and it does not need the Pi to be removed from the dashboard first.
- **Set up a Raspberry Pi screen from the dashboard.** Plug the Pi in, it shows a code on the
  television, and the Screens page asks you for that code and a name. Screens waiting to be set
  up appear on their own, so you can see the Pi has connected before you type anything.

- **Groundwork for screens driven by a Raspberry Pi.** A Pi will be able to run one install
  command, show a pairing code on the screen, and be adopted from the dashboard by typing that
  code. When such a screen shows a camera, the Pi opens the camera directly on your own network
  instead of the server sending it video — which is what will let the display server run in the
  cloud without video crossing the internet twice. This release contains the pairing and the
  screen type only; the Pi software itself follows.

- **A camera on a web screen no longer dies after about ten seconds** with "Too many requests".
  The limit that protects the page was also being applied to the video itself, and video asks for
  a lot more than a page does. Verified with 90 seconds of continuous playback: no failures.
- **A camera on a web screen is much lighter now.** Video is sent in ordinary chunks rather than
  the low-latency mode, which was doing a great deal of work for a second of delay nobody is
  watching for. If a camera is set to *Most compatible*, the screen now tells you that *Direct*
  is far cheaper — measured at roughly a third of the processor use.

- **Cameras really do work on a web screen now.** The previous build still showed "Camera
  unavailable": the camera was never being pulled in for browser screens, and two further
  problems sat behind that. Verified end to end this time — a real H.264 stream, played through
  the page.
- **Switching what a web screen shows now happens within a few seconds** instead of needing the
  page to be reloaded.

- **Cameras and HDMI sources now work on a web screen.** They used to go black: a browser cannot
  play the video format a decoder box uses. The stream is now converted on the fly and played in the
  page, so a browser screen can show everything a normal screen can.
- A web screen now shows **two links** — a local one for screens in the masjid (it stays on your
  network) and, when remote access is on, a public one for a screen somewhere else.
- A web screen never just goes black. If it is switched off, still connecting to a camera, or the
  camera is unavailable, it says so on the screen.


- Fixed the container build for browser screens: the web bundle needs the server's renderer at build time, and the image build stage did not have it.

- **Screens that are a web page, instead of a decoder box (beta).** Turn on *Screens that are a web
  page* in Settings → Beta features, and when you add a screen you can choose **Web page** instead of
  a video stream. You get a link to open in any browser — a Raspberry Pi in kiosk mode, a smart TV, a
  spare laptop — and it shows exactly the same timetable your other screens show.
- It uses **almost no network**. A normal screen is sent video continuously, about 1.5 Mbit/s each,
  forever. A web screen is sent the *timetable* — a bit over a kilobyte — and draws the picture
  itself, so after it loads there is essentially nothing on the wire. On a masjid with several
  screens that is the difference between saturating a Wi-Fi link and not noticing it.
- It **works over the internet**. The link goes through your OpenMasjidOS remote access, so a screen
  in another building, or a display you host in the cloud, works with nothing extra to set up. The
  panel shows you the public address when remote access is on, and says so plainly when it isn't.
- Everything a normal screen does, it does: all three layouts, the countdown, the Adhan pop-up, the
  Iqamah countdown, hadith during salah, the prohibited-time notice, the Iqamah-change reminder, the
  scrolling ticker and the announcement slideshow. It is drawn by the *same* code that draws your
  video screens, so the two cannot disagree.
- A web screen tells you when something is wrong, like a normal one does: it dims itself and shows a
  red bar if it loses contact with the server, or if the screen's own clock is badly wrong.

> **What it cannot do:** show a camera or an HDMI source. Those are video, and a web page has no video
> player here — keep a decoder box for those screens. Web screens are also **beta**: they work, but
> they have not been through a season in a real masjid yet.


- Documentation for setting a Raspberry Pi screen up, what it needs, how it behaves when something
  is wrong, and what to check when it does not work.

## 0.69.0

### Added

- **Announce an Iqamah change to your congregation.** Any scheduled change can now be turned into a
  portrait **announcement image** — your masjid name and logo, the date it takes effect, and the whole
  timetable for that day with the changing prayers highlighted and the time each one replaces struck
  through. It follows the timetable's own theme, language and clock format, so it looks like your screens.
  Download it for the noticeboard, or have it **posted to a WhatsApp group automatically**, as far ahead as
  you like — down to the day itself. Add a change at the last minute and it goes out within a minute. Each
  change is announced once, with a preview of the exact message and a log of what was queued.
- **Add a scheduled Iqamah change from WhatsApp.** Message the masjid's number with `!display` and answer
  the questions — the date, a numbered list of prayers, the time for each — then send **save**. Nothing is
  written until you do, and the whole change is read back first. For when a screen needs fixing and you're
  nowhere near a computer. Times must say am or pm, and dates read month first (*9/1/2026*), always
  repeated back in words before anything is saved.
- **Intel Quick Sync** hardware encoding for self-hosted installs (`VIDEO_ENCODER=qsv`), which moves video
  encoding off the CPU on a box re-encoding several cameras at once. It falls back to the normal encoder
  and says why if the GPU isn't there, so it can't leave you with dark screens.

> WhatsApp needs to be set up in OpenMasjidOS, and only people an admin has authorised there can use it.
> Messages are **queued, not sent**: OpenMasjidOS spaces them out to protect the masjid's number from being
> blocked by WhatsApp, so delivery takes a few minutes and longer inside quiet hours. Nothing important
> depends on it — alerts still go by email and webhook.

### Changed

- **Light mode is properly light.** The theme lightened the cards but left the page background dark, so
  panels sat as grey rectangles on a near-black backdrop and the text on them was hard to read. The
  background, its glow and its pattern are all light now, and each of the nine wallpapers has a light
  version that keeps its colour. Headings, the masjid name and the clock follow whatever is behind them.
- Scheduled Iqamah changes that have already happened drop off the list a few days later, so it shows what
  is still to come. The change itself stays in effect.

### Fixed

- **A scheduled Iqamah change could not be added** — the entry vanished while you typed the date.
- **Security:** OpenMasjidOS replying with something that wasn't valid data was read as "the platform is
  down", which is the state that allows claiming the admin account without signing in — the recovery route
  for a genuinely dead platform. A reply is now treated as a reply.
- The app no longer waits forever on a platform or video server that accepts a connection and then goes
  quiet, so a stalled reply can't stop announcements or screen updates.
- A damaged `db.json` is kept aside instead of being replaced by an empty one, so a bad write can no longer
  take your whole configuration with it.

## 0.68.0

- **The prayer times on the timetable are a little larger.** The Adhan and Iqamah times are set
  about a tenth bigger than before, so they read more easily from the back of a hall. The prayer
  names, the columns and everything else on the screen are exactly as they were — only the times
  grew — and it applies to all three layouts.
- Nothing you have set up needs redoing, and there is nothing to configure for this.

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
