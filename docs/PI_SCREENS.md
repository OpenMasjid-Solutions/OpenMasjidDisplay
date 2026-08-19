<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Raspberry Pi screens

A Raspberry Pi plugged into a television, showing the timetable and playing cameras by itself.
One command sets one up.

> **Beta.** Turn on *Screens that are a web page* in **Settings → Beta features** first — the same
> switch covers browser screens and Pi screens. Without it the installer is not served.

---

## Why this exists

Every other kind of screen is fed video **by** the display server. The server pulls the camera,
re-publishes it, and each screen relays from there. That is fine when the server is in the same
building as the camera. It falls apart when it is not: a browser screen on a cloud-hosted server
sends the picture up to the cloud and back down again, and the measured result was **about one
frame every couple of minutes**.

A Pi is on the same network as the camera, so it is handed the camera's **own** address and opens
it directly. The server carries none of the video.

That is what makes a cloud-hosted display server possible: the server holds the timetables, the
schedule and the settings — kilobytes — and the pictures never leave the masjid.

| | decoder box | browser screen | **Pi screen** |
|---|---|---|---|
| timetable | video from the server | drawn locally | **drawn locally** |
| camera | video from the server | video from the server | **opened directly** |
| server can be off-site | no | timetable only | **yes, entirely** |
| needs | an RTSP decoder | any browser | **a Pi + this installer** |

---

## What you need

- A **Raspberry Pi 3 B+ or newer**. A Pi 4 or 5 is more comfortable; see *Performance* below.
- **Raspberry Pi OS Lite** — the version with no desktop. That is not a limitation to work
  around, it is the point: the agent draws straight to the screen, so there is no browser and no
  desktop to pay for.
- The Pi on the same network as your cameras, and able to reach the display server.

---

## Setting one up

1. In the dashboard, go to **Screens → Raspberry Pi screens** and copy the command shown. It
   already contains this server's address — there is nothing to fill in.
2. Run it on the Pi:

   ```sh
   curl -fsSL http://<your-display-server>:7860/pi.sh | sudo sh
   ```

3. The television shows a **setup code**, along with the Pi's own address and whether it can reach
   the server.
4. Type that code into **Screens → Raspberry Pi screens**, give the screen a name, and it starts
   showing within a few seconds.

### If your server is on HTTPS with its own certificate

Most masjids reach the display server at something like `https://192.168.1.18:8444`. No public
certificate authority will ever issue a certificate for a private address, so the one your server
presents is **self-signed** — and `curl` refuses it:

```
curl: (60) SSL certificate problem: self-signed certificate
```

The dashboard already accounts for this: on a local address it shows the command with `-k`, and
explains why. **Only that first download is unverified.** The installer then takes a copy of your
server's certificate and checks everything afterwards against it — the agent's own requests and its
updates included. Verification is not switched off; what changes is which certificate is trusted,
the same bargain SSH makes the first time you connect to a machine.

There is a second case, and it is common. If the certificate does not *name* the address you used —

```
curl: (60) SSL: no alternative certificate subject name matches target ipv4 address '192.168.1.18'
```

— then no amount of pinning fixes it, because the name simply is not in the certificate. Rather
than fall back to accepting anything, the installer pins your server's **public key**: the name is
not checked, but no other machine is accepted, so somebody on your network would need the server's
private key rather than merely a position between the Pi and it. The installer says clearly when
it has done this, and both the certificate and the key pin are re-derived by the updater so
automatic updates keep working.

The proper fix, if you want full verification, is a certificate that names the address the Pi uses
— then re-run the installer and it will pin normally.

The code is what gets typed rather than the Pi's IP address, deliberately. The address is on a
network the display server may not share, DHCP can move it between reboots, and typing something
read off the screen also proves whoever is setting it up can actually see that screen.

### Re-running it

Safe, and the normal way to repair one. It updates the agent in place, keeps the device's identity
and its adoption, and will **not** send you back to the television for a new code.

---

## What it does on the Pi

| | |
|---|---|
| `/opt/openmasjid-screen` | the agent (one file) and its renderer |
| `/etc/openmasjid-screen/config.json` | server address, device identity, adoption token — `0600` |
| `/var/lib/openmasjid-screen/cache` | downloaded wallpaper, logo, announcements, fonts |
| `openmasjid-screen.service` | the agent — **not** run as root |
| `openmasjid-screen-console.service` | takes the text console off the HDMI output, once, at boot |
| `openmasjid-screen-update.timer` | checks for a newer agent a few times a day |

Packages installed: `nodejs`, `npm`, `ffmpeg`, `fonts-dejavu-core`, `curl`, `ca-certificates`.

Two boot settings are added if absent — `hdmi_force_hotplug=1`, so a Pi that boots before the
television is switched on still produces a picture, and `consoleblank=0`, so the screen does not
blank after ten minutes of nobody typing at it. Both need a reboot.

---

## How it behaves

**It never just goes black.** A black television is indistinguishable from a dead Pi, a dead
television and an unplugged HDMI cable. Waiting to be set up, it shows the code. Switched off, it
says so. Unable to reach the server, it says which server. Waiting on a camera, it names the
camera and the last error.

**It uses the masjid's clock, not its own.** A Pi has no battery-backed clock, so after a power cut
its idea of the time is whenever the memory card was last written. Prayer times are computed
against the display server's time.

**It draws with the server's own fonts.** They are fetched from the server rather than taken from
whatever the Pi happens to have, because the renderer picks one font per frame and does not fall
back glyph by glyph — the wrong font set shows Arabic as empty boxes.

**It comes back on its own** from a crash, a pulled cable, a rebooted camera or a power cut, with
no start limit that could leave it stopped.

**It keeps itself up to date**, checking the display server a few times a day. If an update will
not start, the previous version is put back automatically.

---

## Performance

Rasterising a **1080p** timetable was measured at about **110 ms** on a modern desktop with the
bundled fonts, and **62 ms** at 720p. A Pi 3 B+ is substantially slower than that desktop.

So the agent does not assume a frame rate. It **measures how long its own drawing takes** and picks
a rate it can sustain, holding the share of the machine constant rather than the frame rate —
which leaves headroom for ffmpeg to decode a camera at the same time.

The display is designed around one frame a second, because the clock's colons blink and the Iqāmah
countdown runs in mm:ss. If a Pi cannot manage that it says so in its log and names the fix:

```
Drawing takes long enough that this screen updates every 2.5s rather than every second.
Setting this timetable to 720p would roughly halve the work.
```

**If a Pi 3 feels sluggish, set that timetable to 720p.** On a television across a hall the
difference is close to invisible, and it roughly halves the work.

Cameras use the Pi's hardware H.264 decoder where it is available, falling back to software
automatically.

---

## Security

- **The agent does not run as root.** It holds the `video` and `tty` groups and can write exactly
  two directories. Taking the console off the screen — the only genuinely root-only step — is a
  separate one-shot unit.
- **It cannot rewrite its own code.** `/opt` is read-only to it; updates are done by a separate
  root timer. A long-running, network-facing process that can modify its own binary is a much
  larger thing to trust than one that cannot.
- **Nothing ever connects *to* the Pi.** It polls outward, always. It is behind the masjid's NAT
  on a DHCP address and the display server may be in the cloud, so there is no inbound path to
  secure — and none to leave open.
- **The device proves who it is.** The agent mints a secret at install; the server stores only its
  hash and compares in constant time. Without that pair, an unauthenticated enrolment could hand
  a device's token to anyone who guessed its id.
- **Cameras keep the server's posture**: array-form `spawn`, and an explicit
  `-protocol_whitelist` of stream protocols only — never `file:`, `http:` or `concat:`. A test
  asserts the Pi's list is character-for-character the server's.
- **Credentials never reach the journal.** Camera addresses very often carry a password, and it is
  stripped from every log line.
- **The server is authenticated after the first hop.** A self-signed certificate is pinned at
  install time and verified on every request afterwards. Where the certificate does not name the
  address, the public key is pinned instead — tested against an impostor on the same address, which
  is refused. The one unavoidable gap is the very first `curl`, which has nothing to check against;
  that is the same trust-on-first-use SSH makes, and the dashboard says so rather than hiding it.
- **Node does not read `/etc/ssl/certs`.** Adding a certificate with `update-ca-certificates` fixes
  `curl` and not the agent, which is why the pinned certificate is handed to it explicitly. Worth
  knowing before debugging this by hand.
- `/pi.sh` and `/pi/agent.js` are public by necessity — a Pi being set up holds no credentials
  yet — and neither contains a secret. Over a LAN this is plain HTTP; through the platform's
  remote access it is HTTPS.

---

## Troubleshooting

```sh
sudo journalctl -u openmasjid-screen -n 50 --no-pager     # what the agent is doing
sudo systemctl status openmasjid-screen                   # is it running
cat /sys/class/graphics/fb0/virtual_size                  # what the television negotiated
```

**Nothing on the television at all.** Check `/dev/fb0` exists. If it does not, the Pi booted with
no display attached — reboot with the television on, now that `hdmi_force_hotplug=1` is set.

**The code never appears, and the log says it cannot reach the server.** The address baked into
`/etc/openmasjid-screen/config.json` is whichever one you ran the installer from. If you copied
the command from a dashboard open on a different network, re-run it from an address the Pi can
actually reach.

**The screen says "Camera unavailable".** The message carries ffmpeg's own last complaint. The Pi
must be able to reach the camera directly — that is the whole design — so check from the Pi
itself. If cameras never work while the timetable does, check this ffmpeg has the framebuffer
output device (the installer warns about this at install time):

```sh
ffmpeg -hide_banner -devices | grep fbdev
```

**The install seems to hang with nothing printed.** It should not any more — every step is
numbered and announces itself first. If it does stall, the usual cause is that the Pi has just
booted and is still running its own `unattended-upgrades`, which holds the package lock; the
installer now names the process holding it and waits, rather than blocking silently. Installing
ffmpeg is genuinely the slow part on a Pi 3 — several hundred megabytes — and is now its own step
so you can see it happening. If it fails, the timetable still works and you can re-run the
installer later to add cameras.

**`could not download the agent`, with an SSL error.** See *If your server is on HTTPS with its own
certificate* above. Re-running the installer is the fix — older versions gave up here.

**Arabic shows as empty boxes.** The fonts are fetched from the display server on first run; the
log says `fonts ready: N face(s)` when that has happened. If it has not, the Pi could not reach
the server for them.

**The clock updates slowly.** Expected on a Pi 3 at 1080p — see *Performance*.

**Start again.** Press **Forget** in the dashboard: the Pi goes back to showing a fresh setup code
without being reinstalled, and the screen it was driving is kept.
