#!/bin/bash -e
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 OpenMasjid-Solutions
#
# pi-gen substage: turn Raspberry Pi OS Lite into an OpenMasjid node card.
#
# Runs on the BUILD host with ${ROOTFS_DIR} pointing at the image's root; `install` and
# `on_chroot` are pi-gen helpers. Nothing here is masjid-specific — the image is generic and
# every node is identical until it is adopted.
#
# EVERYTHING IT INSTALLS COMES FROM `files/`, never from a path in this repository. The
# workflow assembles that directory (.github/workflows/image.yml) for two reasons: pi-gen can
# be run inside a container where the repo is not mounted, and a substage that reaches
# outside its own directory only works on the one machine it was written on.

FILES="$(cd "$(dirname "$0")/files" && pwd)"

# ── The agent and the kiosk bundle ──────────────────────────────────────────────
# Both are built on the CI host (x86, fast) and copied in as plain JS — the agent is
# TypeScript compiled to CommonJS with no native modules, so it is architecture-independent
# and needs no arm64 npm install inside the chroot.
install -d "${ROOTFS_DIR}/opt/omd/agent" "${ROOTFS_DIR}/opt/omd/kiosk" "${ROOTFS_DIR}/data"
cp -r "${FILES}/agent/dist" "${ROOTFS_DIR}/opt/omd/agent/"
cp -r "${FILES}/agent/node_modules" "${ROOTFS_DIR}/opt/omd/agent/"
cp "${FILES}/agent/package.json" "${ROOTFS_DIR}/opt/omd/agent/"
cp -r "${FILES}/kiosk/." "${ROOTFS_DIR}/opt/omd/kiosk/"

# ── Overlay files (systemd units, the firstboot script) ─────────────────────────
cp -r "${FILES}/overlay/etc/." "${ROOTFS_DIR}/etc/"
install -m 0755 "${FILES}/overlay/usr/local/sbin/omd-firstboot" "${ROOTFS_DIR}/usr/local/sbin/omd-firstboot"

on_chroot <<'CHROOT'
set -e

# An unprivileged account for the agent. It gets CAP_NET_BIND_SERVICE from the unit file
# rather than running as root, and `video`/`render` for the display and decoder.
if ! id omd >/dev/null 2>&1; then
  useradd --system --home-dir /opt/omd --shell /usr/sbin/nologin --groups video,render omd
fi
chown -R omd:omd /opt/omd /data

# LOCK the account pi-gen insisted on creating. It is built with a random per-build password
# that is never published, and nothing needs it: the agent runs as `omd`, SSH ships disabled,
# and a node is administered entirely from the control panel. Locking it means even that
# random password cannot be used — a technician who needs a shell enables SSH the standard Pi
# way (an `ssh` file on the boot partition) with their own credentials.
passwd -l omd-setup || true
usermod --expiredate 1 omd-setup || true

systemctl enable omd-agent.service
systemctl enable omd-firstboot.service
systemctl enable avahi-daemon
systemctl enable chrony
systemctl disable ssh || true

# The panel's discovery picker looks for this.
install -d /etc/avahi/services
cat > /etc/avahi/services/omd-node.service <<'AVAHI'
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">OpenMasjid node %h</name>
  <service>
    <type>_omd-node._tcp</type>
    <port>80</port>
  </service>
</service-group>
AVAHI

# zram swap sized to half of RAM: enough headroom for the browser without thrashing.
cat > /etc/default/zramswap <<'ZRAM'
ALGO=zstd
PERCENT=50
ZRAM

# The BCM hardware watchdog, so a wedged kernel reboots itself. Screens hang in prayer halls
# and nobody power-cycles them. Guarded because the package may not have installed.
if [ -f /etc/watchdog.conf ]; then
  sed -i 's/^#watchdog-device/watchdog-device/' /etc/watchdog.conf || true
  grep -q '^watchdog-device' /etc/watchdog.conf || echo 'watchdog-device = /dev/watchdog' >> /etc/watchdog.conf
  grep -q '^max-load-1' /etc/watchdog.conf || echo 'max-load-1 = 24' >> /etc/watchdog.conf
  systemctl enable watchdog || true
fi

# Journal to RAM with a small persisted ring: SD cards die from writes.
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/omd.conf <<'JRNL'
[Journal]
Storage=volatile
RuntimeMaxUse=16M
JRNL
CHROOT

# ── Boot config ─────────────────────────────────────────────────────────────────
# The boot partition is /boot/firmware on bookworm and /boot before it.
BOOTDIR="${ROOTFS_DIR}/boot/firmware"
[ -d "$BOOTDIR" ] || BOOTDIR="${ROOTFS_DIR}/boot"

cat >> "${BOOTDIR}/config.txt" <<'CFG'

# ── OpenMasjid Display node ───────────────────────────────────────────────────
# The TV is very often switched OFF when the Pi powers up. Without forcing hotplug and
# pinning a mode, the Pi sees no connected display at boot and outputs nothing at all even
# after someone turns the TV on — which looks exactly like a dead node.
hdmi_force_hotplug=1
# Full KMS: what cog's DRM backend and kmssink both need.
dtoverlay=vc4-kms-v3d
# Under full KMS the GPU needs almost no carve-out, and that RAM is worth far more to the
# browser on a 512 MB board.
gpu_mem=16
# Hardware watchdog.
dtparam=watchdog=on
CFG

# Pin the HDMI mode ('D' = force it even with no EDID) for the TV-is-off case, and keep the
# boot quiet so a masjid does not watch kernel logs scroll past on the screen.
sed -i '1 s|$| video=HDMI-A-1:1920x1080@60D logo.nologo consoleblank=0 quiet|' "${BOOTDIR}/cmdline.txt"
