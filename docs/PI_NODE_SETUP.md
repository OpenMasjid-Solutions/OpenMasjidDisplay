<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Setting up a Raspberry Pi screen

A **Pi node** is a small Raspberry Pi that plugs straight into a TV's HDMI port and draws
your prayer timetable itself. Compared with an RTSP decoder box it needs no video streaming
from the server at all, so the server does far less work — and cameras play straight from
your network.

You do not need to understand any of that to set one up. It takes about ten minutes.

---

## What you need

- A **Raspberry Pi Zero 2 W** (other Pi models will probably work but only this one is
  tested and supported)
- A **microSD card**, 8 GB or larger
- The Pi's **power supply**, and a **mini-HDMI to HDMI** cable for the TV
- Either an Ethernet adapter, or your masjid's Wi-Fi name and password

---

## 1. Write the card

1. Download the node image — the `.img.xz` file — from the
   [latest release](https://github.com/OpenMasjid-Solutions/OpenMasjidDisplay/releases/latest).
2. Install [Balena Etcher](https://etcher.balena.io/) (free, works on Windows, macOS and Linux).
3. Open Etcher, choose the `.img.xz` you downloaded, choose your microSD card, and click
   **Flash**. It will take a few minutes.

The image is the same for every screen. Nothing is set up per-masjid at this stage, so you
can write one card and clone it for every TV.

## 2. Plug it in

Card into the Pi, HDMI into the TV, then power. **Turn the TV on and pick the right HDMI
input.** The first boot takes a minute or two.

## 3. Get it on your network

**With a network cable:** nothing to do. The Pi finds the network by itself and skips
straight to step 4.

**With Wi-Fi:** the TV will show instructions. On your phone:

1. Join the Wi-Fi network named **`OpenMasjid-Node-XXXX`** (the last four characters differ
   per Pi). The password is **`12345678`**.
2. A setup page opens automatically — if not, open a browser and go to any address.
3. Pick your masjid's Wi-Fi and enter its password.

The Pi joins your network and remembers it. If it ever loses the network for more than a few
minutes it will offer this setup Wi-Fi again on its own.

## 4. Adopt it in the control panel

The TV now shows **a large IP address** — something like `192.168.1.40`.

1. In the control panel, go to **Settings** and turn on **"Offer Pi node screens"**.
2. Go to **Screens** → **Add screen** → **OpenMasjid Pi node**.
3. Type the address from the TV and press **Check**. You should see the Pi's model and
   serial number — confirm it's the right box before continuing.
4. Give the screen a name (e.g. "Main hall TV") and press **Add this screen**.

Within a few seconds the TV switches to your timetable. That's it.

> **Which box is which?** In a hall with several screens, open a node from the Screens page
> and press **Identify** — that Pi shows its name and address big on its TV for 30 seconds.

---

## Living with it

**Changing what a screen shows** works exactly like any other screen: pick a timetable, a
camera or "off" on the Screens page, or let a schedule do it. Volunteers can switch it from
the volunteer page too.

**If the server goes down**, a node keeps showing the timetable. Prayer times are calculated
on the Pi itself, so a screen carries on correctly through a server restart, a network
outage, or a server that is off for a week. Only an explicit change from the panel alters
what is on screen.

**Updating** is per-screen, from the panel, when a new firmware is released.

**Removing a node** ("Remove node" in its drawer) tells the Pi to wipe itself and go back to
waiting to be set up. The screen entry stays and reverts to needing an RTSP decoder, so your
schedules keep working.

---

## Factory reset

Use this if a node was set up on the wrong controller, or you're moving it to another masjid.
Either method wipes its settings and returns it to "ready to adopt":

**A. From any computer** (works even if the Pi is unreachable)
1. Power the Pi off and put its microSD card in a computer.
2. On the small drive that appears (the boot partition), create an empty file named exactly
   `factory-reset` — no file extension.
3. Put the card back and power on. The Pi clears itself and removes the file.

**B. With a jumper wire**
Hold **GPIO21 to ground** for 10 seconds while the Pi boots.

---

## If something isn't right

**The TV shows nothing at all.** Check it's on the right HDMI input. The Pi forces video
output even when the TV is off at boot, but some TVs need the input reselected. If the screen
is still black after two minutes, re-seat the microSD card.

**The TV shows "no network".** The Pi is running but can't reach your network. Wait a minute;
if it doesn't recover it will offer the `OpenMasjid-Node-XXXX` setup Wi-Fi again (step 3).

**"Could not reach a display node at …"** when adopting. Check the address on the TV matches
what you typed, that the Pi and the computer running the panel are on the same network, and
that the Pi has finished booting.

**"That node is already adopted."** It belongs to another controller. Factory-reset it
(above) and try again.

**The screen says "Synchronizing the clock…".** A Pi has no battery-backed clock, so it asks
the internet for the time on every boot. It withholds prayer times until it's sure — showing
wrong times would be worse. It clears itself within a minute of getting online.

**A camera won't play on a node.** A Pi Zero 2 W can only decode **H.264** video, not H.265 /
HEVC. Either set the camera to H.264 (best — the video then goes straight from camera to
screen), or set that source's mode to **"normalize"** so the server converts it. The panel
tells you which applies.

---

## Things worth knowing

- **One screen per node.** One Pi drives one TV.
- **Adoption happens over your local network and only once.** A factory-fresh node accepts
  the first controller that claims it, because it has no shared secret yet — so set nodes up
  on a network you trust. After that it only ever talks to your controller, authenticated,
  and cannot be re-pointed without a factory reset. A confirmation code shown on the TV is
  planned to tighten this further.
- **The setup Wi-Fi password (`12345678`) is deliberately well known.** That network can do
  exactly one thing: hand the Pi your Wi-Fi details. It cannot read the Pi's credentials,
  adopt it, or change what's on screen.
- **SSH is off.** To enable it for a technician, put an empty file named `ssh` on the boot
  partition, the standard Raspberry Pi way.
- **H.264 up to 1080p30** is the video limit of this board.
- **Camera re-encoding needs the server on the same network as the camera.** If your
  controller runs in the cloud it cannot convert a camera on your masjid's LAN; use an H.264
  camera, or run the controller locally.

---

## For developers: running a node without the image

Useful before an image exists for your branch, or to test on a Pi you've already set up.

**On a Pi** running Raspberry Pi OS Lite (arm64):

```bash
sudo apt install -y nodejs npm cog gstreamer1.0-tools gstreamer1.0-plugins-{base,good,bad} chrony
git clone https://github.com/OpenMasjid-Solutions/OpenMasjidDisplay
cd OpenMasjidDisplay/node/kiosk && npm ci && npm run build
cd ../agent && npm ci && npm run build
sudo mkdir -p /data && sudo chown "$USER" /data
sudo OMD_DATA_DIR=/data OMD_KIOSK_DIR="$PWD/../kiosk/dist" OMD_PORT=80 \
  node dist/node/agent/src/index.js
```

Then adopt it from the panel using the Pi's IP, exactly as in step 4. `sudo` is only needed
to bind port 80; the shipped image instead grants the service `CAP_NET_BIND_SERVICE`.

**On a laptop**, with no Pi at all:

```bash
cd node/agent && npm run devnode
```

This runs the real agent with a stand-in for the hardware — it prints what it would put on
screen instead of driving HDMI. Adopt it at **`127.0.0.1:8099`**. It uses a high port on
purpose: OpenMasjidOS binds `:80` on its host, and a real node (a dedicated board) is the
only thing that should take that port.
