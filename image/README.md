<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# `image/` — the OpenMasjid node card

Builds `openmasjid-node-vX.Y.Z.img.xz`: Raspberry Pi OS Lite (arm64) plus `omd-agent`, the
kiosk bundle, and the handful of system tweaks a screen in a prayer hall needs.

The image is **generic**. Nothing is baked per-install — no masjid name, no controller
address, no credentials. Every node is identical until an admin adopts it, which is what
makes "write one card, clone it for every TV" safe.

## Layout

```
pi-gen/
  stage-omd/            a pi-gen custom stage, appended after stage2 (Lite)
    00-packages         apt packages: cog, gstreamer, NetworkManager, chrony, …
    01-run.sh           installs the overlay, enables units, sets boot config
overlay/                files copied verbatim into the rootfs
  etc/systemd/system/   omd-agent.service, omd-firstboot.service
  etc/omd/              zram + watchdog + read-only-root config
  boot/                 config.txt / cmdline.txt additions
```

## Building

pi-gen needs a Debian host (or a Debian container) and root; it cannot run on Windows or
macOS. CI does it on `ubuntu-latest` — see `.github/workflows/image.yml`. Locally:

```bash
git clone --depth 1 https://github.com/RPi-Distro/pi-gen
cd pi-gen
cp -r ../image/pi-gen/stage-omd .
# Skip the desktop stages; Lite is stage2.
touch ./stage3/SKIP ./stage4/SKIP ./stage5/SKIP
echo 'IMG_NAME=openmasjid-node' > config
echo 'ARCH=arm64' >> config
sudo ./build.sh
```

## What the stage changes, and why

| Change | Why |
|---|---|
| `cog` (WPE WebKit) on DRM/KMS, not Chromium | Chromium does not fit in 512 MB beside anything else. WPE is a real engine at ~250 MB with no desktop or compositor. |
| GStreamer with `v4l2codecs`, `rtsp`, `kms` | Hardware H.264 decode straight to the display, no X. |
| `hdmi_force_hotplug=1` + a fixed KMS mode | The TV is often OFF when the Pi boots. Without this the Pi sees no display and outputs nothing even after the TV wakes. |
| `gpu_mem=16` | Under full KMS the GPU needs almost no carve-out; that RAM is worth more to the browser. |
| zram swap | 512 MB with a browser in it. Compressed swap in RAM beats swapping to an SD card, which wears it out and stalls. |
| Read-only root + overlayfs, writable `/data` | SD cards die from writes and sudden power loss. Only `/data` (agent state, asset cache) is writable, and it is the only thing a factory reset has to clear. |
| Logs to tmpfs with a small persisted ring | Same reason. A screen that runs for years must not journal itself to death. |
| systemd watchdogs + the BCM hardware watchdog | Screens hang in prayer halls and nobody reboots them. |
| `chrony` | The Pi has no RTC. Prayer times from an unset clock are worse than none, so the agent withholds the timetable until the clock is synced (`Platform.clockSynced()`). |
| NetworkManager + `wifi-connect` | The first-boot captive portal, skipped entirely when Ethernet has carrier. |
| Avahi advertising `_omd-node._tcp` | Lets the panel offer discovered nodes instead of only manual IP entry. |
| SSH left disabled | Standard Pi convention: an `ssh` file on the boot partition turns it on for a technician. |

## Factory reset

Either works, and both are documented for an admin in `docs/PI_NODE_SETUP.md`:

1. Create an empty file named `factory-reset` on the card's **boot** (FAT) partition — the
   easiest path when the node is unreachable, because any laptop can do it.
2. Hold **GPIO21 to ground** for 10 s while it boots.

Both wipe `/data` and return the node to unadopted.

## Status

**These configs are written but have never been built or booted** — see
`docs/PI_NODE_STATUS.md`. The agent and kiosk they install are covered by tests
(`node/agent`, and a browser screenshot of the kiosk), but the image itself, HDMI
behaviour, hardware decode and the first-boot portal are exactly what M1's on-device
acceptance is for.
