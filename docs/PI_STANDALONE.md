<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# A Raspberry Pi screen on its own

A Raspberry Pi plugged into a television, showing your prayer timetable and your cameras, with
**no server anywhere**. One command sets it up, and you run it from a browser on your phone.

```sh
curl -fsSL https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidDisplay/main/pi.sh | sudo sh
```

That is the whole install. About £60 of hardware and ten minutes.

---

## Is this the one you want?

There are two ways to run an OpenMasjidDisplay screen, and a screen set up either way can be
moved to the other later without losing anything.

|  | **On its own** (this page) | **With a Display server** ([PI_SCREENS.md](PI_SCREENS.md)) |
|---|---|---|
| What you need | a Pi and a television | a Pi, a television, **and** OpenMasjidOS running somewhere |
| Where you manage it | a browser, pointed at the Pi | the OpenMasjidOS dashboard |
| Number of screens | **one** — each Pi is its own | as many as you like, managed together |
| Timetable lives | on the Pi | on the server, shared by every screen |
| WhatsApp announcements, email alerts | no | yes |
| Website widget, Companion app | no | yes |
| Updates come from | GitHub, automatically | your server |

**Choose "on its own" if** this is your only screen, or if you want prayer times on a wall this
week without standing up a server first.

**Choose a Display server if** you have more than one screen and want them to share one
timetable, or you want the WhatsApp and alerting features.

You are not locked in. A standalone screen can be adopted by a Display server later, and an
adopted one can be released back — see *Growing into a server* at the bottom.

---

## What you need

- A **Raspberry Pi 4 Model B** (2 GB or more), a **Pi 400**, or a **Compute Module 4**. This is
  checked and **enforced**: the installer reads `/proc/device-tree/model` and refuses anything
  else, including a Pi 3, a Pi Zero and — for now — a Pi 5, which simply has not been tested.
  Refusing is the kind thing to do: a Pi 3 cannot decode a modern camera fast enough, so what you
  would get is a stuttering picture and a camera that keeps dropping the connection.
- **Raspberry Pi OS Lite (64-bit)** — the version with no desktop. That is the point, not a
  compromise: the screen is drawn straight to the display, so there is no browser and no desktop
  to pay for.
- A **micro-SD card** of 8 GB or more, and the Pi's official power supply. An underpowered supply
  is the most common cause of a screen that works for an hour and then does not.
- The Pi connected to your network — Wi-Fi is fine, and you can set it up from the panel later.
- If you want cameras: the cameras on that same network.

A television is just a television. Any HDMI input will do.

---

## Setting one up

**1. Flash Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. In Imager's settings, set a
username and password and your Wi-Fi, so the Pi comes up on the network by itself.

**2. Plug it in** — HDMI to the television, power last.

**3. Run the command.** Either over SSH from your laptop, or with a keyboard plugged into the Pi:

```sh
curl -fsSL https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidDisplay/main/pi.sh | sudo sh
```

It takes about ten minutes on a fresh card, most of it installing ffmpeg. It will tell you what
it is doing. Safe to run again if it is interrupted.

**4. Look at the television.** It now shows a **setup code** and the Pi's address on your
network, something like `http://192.168.1.42`.

**5. Open that address** in a browser on your phone or laptop, on the same network. You will be
asked for the setup code from the television and for a password to create. That password is how
you get back in.

**6. Add your prayer times.** **Timetables → Add timetable**. You can calculate them, type them
in, or upload a CSV. The television updates within a few seconds.

That is it. There is nothing else to install and nothing to sign up for.

> **Why the code?** Anybody on your network can reach the Pi before it has a password. The code
> is shown only on the television, so setting the screen up requires standing in the room with
> it — or being trusted with a photograph of it.

---

## Running it

Everything is in the panel at the Pi's address. It is the **same control panel** a Display server
serves, so anything you learn here carries over if you add a server later.

| | |
|---|---|
| **Timetables** | prayer times — calculated, typed, or uploaded. Iqamah schedules, Jumu'ah, Ramadan. |
| **Screens** | this screen: its design, orientation, language, what it is showing right now |
| **Sources** | cameras (RTSP) and the HDMI input, if you have a capture device |
| **Schedules** | what to show and when — the timetable in the day, a camera at Fajr, anything you like |
| **Settings** | name, logo, wallpaper, theme, Wi-Fi, the volunteer PIN, time zone |

### The volunteer page

Set a **PIN** in **Settings → Volunteer page** and anybody with the PIN can open
`http://<pi-address>/volunteer` on their phone to adjust today's Iqamah times — without the
password and without being able to change anything else. This is the page for whoever opens the
masjid.

### Wi-Fi

**Settings → Wi-Fi** lists the networks the screen can see and joins one, so a Pi set up on a
cable can be moved onto Wi-Fi, and one whose network password has changed can be put back on
without anybody fetching a keyboard.

Read the result before you unplug anything. **When the join succeeds, the screen reports its new
address** — that is where you manage it from now on, because this panel is served by the screen
itself. Changing its network changes where you type to reach it. The television shows that
address too, so you can always read it off the wall.

Change network **while the cable is still in** if you can. Turning the radio off is refused by the
screen unless a cable is carrying it, and a network that turns out not to work leaves you needing
the cable to put it right.

### Not here yet

**A terminal in the panel.** A server-managed screen can be given one from the dashboard; a
standalone one cannot. SSH in instead.

---

## What is different from a screen run by a server

The panel is deliberately the same panel, so the list of differences is short and exact:

1. **The Screens page shows one card** — this screen. There is nothing else for it to show.
2. **There is no WhatsApp, no email or webhook alerting, no website widget, no Companion app and
   no remote access.** Those are features of OpenMasjidOS, the platform a Display server runs on,
   and a Pi on its own is not running it. If you want them, that is the reason to add a server.
3. **Appearance is set here**, in **Settings → Appearance**. A server-managed screen inherits the
   theme and wallpaper from the OpenMasjidOS dashboard instead.
4. **The first-run screen asks for the setup code** as well as a password. A server has no code
   to ask for.
5. **Wi-Fi lives in Settings**, not on a screen's card — a server manages many screens, so there
   the question is always "which one"; here it is this one. Same controls, and after a join it
   tells you the screen's new address rather than telling you to leave the cable in, because
   there is no dashboard elsewhere that needs to stay reachable.
6. **There is no terminal in the panel**, as above.

Anything else that differs is a bug worth reporting.

---

## It keeps itself up to date

A few times a day the Pi asks GitHub whether there is a newer release, and installs it if so —
the screen software and the control panel together. You do not have to do anything.

What protects you:

- **The download is checked against the checksum published with the release.** Bytes that do not
  match are refused and nothing is changed.
- **If the new version will not start, the previous one is put back** and the screen carries on.
- **Anything that goes wrong is a refusal, not a risk.** GitHub unreachable, a release with no
  bundle, an archive that will not unpack — the screen keeps the version it has and keeps
  showing prayer times. It will try again in a few hours.
- **The update runs as a separate system task**, so the screen software itself cannot rewrite
  its own code.

Install with `--channel dev` and the screen follows pre-releases instead, which is useful for
testing and not what you want on a wall:

```sh
curl -fsSL .../pi.sh | sudo sh -s -- --channel dev
```

The channel is remembered, so a screen installed from `dev` stays on `dev`.

To see what it has been doing:

```sh
sudo journalctl -u openmasjid-screen-update.service -n 50
```

---

## When something is wrong

**The screen never just goes black.** A black television is indistinguishable from a dead Pi, a
dead television and a loose cable, so it always says something instead. Waiting to be set up, it
shows the code. Nothing scheduled, it says so. Waiting on a camera, it names the camera and the
last error.

| What you see | What it means |
|---|---|
| **"Clock is wrong"** | A Pi has no battery, so after a power cut it does not know the date until it reaches the internet. Prayer times computed against a wrong clock are wrong in the one way nobody checks, so it refuses to show any. It fixes itself within a minute of being online. |
| **A setup code, after you already set it up** | The configuration was reset. Set it up again; nothing else is lost. |
| **A camera that will not load** | The card names the camera and the last error. Check the address in **Sources**, and that the Pi and the camera are on the same network. |
| **Nothing at all on the television** | Power first, then the HDMI cable, then the input on the television. If the Pi's green light is blinking, it is alive — SSH in and run `sudo systemctl status openmasjid-screen`. |
| **You cannot reach the panel** | The television shows the Pi's address. If it has changed, your router gave it a new one — give it a fixed address in the router. |

Logs, if you need them:

```sh
sudo journalctl -u openmasjid-screen -n 100 --no-pager
```

---

## Growing into a server

If you later add OpenMasjidOS and a Display server, an existing standalone screen can be
**adopted**: the server takes over the timetable and the settings, the Pi keeps drawing and
keeps opening its cameras directly, and the panel at the Pi's address becomes a read-only status
page with a way back in if the server is ever unreachable.

Nothing is thrown away, and a screen can be released back to standalone afterwards.

> **Not built yet.** The adoption flow is designed but not shipped. Until it is, a Pi set up on
> its own and a Pi set up from a server are separate choices made at install time — re-running
> the installer from a server address is the way to move one across, and you will set its
> timetable up again on the server.

---

## Where things live, and what runs

The same as a server-managed screen — see [PI_SCREENS.md](PI_SCREENS.md) for the full table —
with these additions:

| | |
|---|---|
| `/opt/openmasjid-screen/web` | the control panel's files |
| `/opt/openmasjid-screen/trust.env` | the release channel and the installed version, root-owned |
| the panel | served by the screen software itself on port 80 |

The screen software does not run as root. The updater is a separate task that does, which is why
the screen software cannot write to `/opt` and cannot change its own code.

The panel is on **port 80 on your own network only**. Nothing is opened to the internet, no
account is created anywhere, and no data leaves the Pi except the update check, which asks
GitHub for a version number.

---

## See also

- [PI_SCREENS.md](PI_SCREENS.md) — Pi screens managed by a Display server, and the detail shared
  by both: what is installed, how it performs, the security model.
- [RTSP_SETUP.md](RTSP_SETUP.md) — getting a camera address out of your camera.
- [PI_STANDALONE_DESIGN.md](PI_STANDALONE_DESIGN.md) — why it is built this way. For developers.
