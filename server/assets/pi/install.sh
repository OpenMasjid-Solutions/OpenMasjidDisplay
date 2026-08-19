# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 OpenMasjid-Solutions
#
# OpenMasjidDisplay — Raspberry Pi screen installer.
#
# Run on a fresh Raspberry Pi OS Lite install:
#
#     curl -fsSL http://<display-server>:7860/pi.sh | sudo sh
#
# The address is not a placeholder you have to fill in: this script is served BY the display
# server, which substitutes its own address below before sending it. So the one line you paste is
# whatever the dashboard shows you, and the Pi is pointed at the right place by construction.
#
# What it does, and nothing more: install Node, ffmpeg and a renderer; drop the agent in
# /opt/openmasjid-screen; write a config; and start a systemd service. It is safe to re-run — it
# will update the agent in place and will NOT make an already-adopted screen ask to be set up
# again.
#
# Deliberately POSIX sh with `set -eu`, not bash: Pi OS Lite has /bin/sh as dash, and a script
# piped into `sh` that half-runs is worse than one that refuses to start.
set -eu

SERVER='@@SERVER@@'
RESVG_VERSION='@@RESVG@@'
AGENT_VERSION='@@AGENT_VERSION@@'

PREFIX=/opt/openmasjid-screen
CONFDIR=/etc/openmasjid-screen
CONF="$CONFDIR/config.json"
# Downloaded wallpapers, logos and fonts. Separate from the config because it is disposable —
# deleting it costs one re-download, deleting the config costs somebody a walk to the television.
STATEDIR=/var/lib/openmasjid-screen
SERVICE_USER=omdscreen

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# ── checks ───────────────────────────────────────────────────────────────────
#
# Each of these is a failure that would otherwise show up much later as "the screen is black",
# which is the hardest thing to debug from a phone call.

[ "$(id -u)" = 0 ] || die "run this with sudo:  curl -fsSL $SERVER/pi.sh | sudo sh"
command -v apt-get >/dev/null 2>&1 || die 'this installer expects Raspberry Pi OS or another Debian-based system'

if [ ! -e /dev/fb0 ]; then
  # Not fatal. A Pi with no television attached at boot has no framebuffer, and the fix is a
  # config.txt line this script adds — so warn, carry on, and let the reboot sort it out.
  say 'warning: no /dev/fb0 yet. Nothing can be drawn until a display is attached and the Pi is rebooted.'
fi

say "Installing the OpenMasjidDisplay screen agent (server: $SERVER)"

# ── packages ─────────────────────────────────────────────────────────────────
#
# nodejs/npm run the agent. fonts-dejavu-core is what the pairing screen and the timetable are
# drawn with. ffmpeg is installed now even though nothing uses it until the camera support lands,
# because the alternative is asking every masjid to re-run this later.

say 'Installing packages (this takes a few minutes on a Pi 3)'
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  nodejs npm ca-certificates curl fonts-dejavu-core ffmpeg >/dev/null

command -v node >/dev/null 2>&1 || die 'node did not install; check `apt-get install nodejs`'

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 18 ] || die "node 18 or newer is required (found $(node -v 2>/dev/null || echo none)). Update Raspberry Pi OS."

# ── the agent ────────────────────────────────────────────────────────────────

say 'Fetching the agent'
mkdir -p "$PREFIX"
cd "$PREFIX"

# The rasteriser is a native module, so it cannot be bundled — it is the one thing installed from
# npm. Pinned to the exact version the display server renders with, so a Pi draws the same pixels
# the server does rather than almost the same ones.
if [ ! -d "$PREFIX/node_modules/@resvg/resvg-js" ] || \
   [ "$(node -p "require('$PREFIX/node_modules/@resvg/resvg-js/package.json').version" 2>/dev/null || echo none)" != "$RESVG_VERSION" ]; then
  say "Installing the renderer (@resvg/resvg-js $RESVG_VERSION)"
  printf '%s\n' '{ "name": "openmasjid-screen-agent", "private": true }' > "$PREFIX/package.json"
  npm install --no-audit --no-fund --omit=dev "@resvg/resvg-js@$RESVG_VERSION" >/dev/null 2>&1 \
    || die 'could not install the renderer. Is this Pi online?'
fi

# Downloaded to a temporary name and moved into place, so an interrupted download cannot leave a
# truncated agent that systemd then restarts forever.
curl -fsSL "$SERVER/pi/agent.js" -o "$PREFIX/agent.js.new" || die "could not download the agent from $SERVER"
[ -s "$PREFIX/agent.js.new" ] || die 'the downloaded agent was empty'
node --check "$PREFIX/agent.js.new" || die 'the downloaded agent is not valid JavaScript'
mv "$PREFIX/agent.js.new" "$PREFIX/agent.js"

# ── the service account ──────────────────────────────────────────────────────
#
# The agent does not run as root. It needs three things — the framebuffer, the console, and its
# own config — and group membership covers all three. The one genuinely root-only action (taking
# the text console off the screen) is a separate one-shot unit below, so the long-running process
# holds no privileges it does not use.

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  say "Creating the $SERVICE_USER service account"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
usermod -aG video,tty,render "$SERVICE_USER" 2>/dev/null || usermod -aG video,tty "$SERVICE_USER"

# ── config ───────────────────────────────────────────────────────────────────
#
# Written by node rather than by hand, because this has to MERGE: a re-run must update the server
# address and leave the device's identity and its adoption token alone. A re-run that reset the
# token would send somebody back to the television to read a new code, which is exactly the
# support call this whole design exists to avoid.

mkdir -p "$CONFDIR"
SERVER="$SERVER" CONF="$CONF" node -e '
const fs = require("fs"), crypto = require("crypto");
const file = process.env.CONF;
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { cfg = {}; }
if (typeof cfg !== "object" || cfg === null) cfg = {};
cfg.server = process.env.SERVER;
if (typeof cfg.deviceId !== "string" || !cfg.deviceId) cfg.deviceId = "pi_" + crypto.randomBytes(6).toString("hex");
if (typeof cfg.deviceSecret !== "string" || !cfg.deviceSecret) cfg.deviceSecret = crypto.randomBytes(16).toString("base64url");
const tmp = file + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
fs.renameSync(tmp, file);
process.stdout.write(cfg.deviceId + "\n");
' > /tmp/omd-device-id || die 'could not write the config'
chmod 700 "$CONFDIR"
chmod 600 "$CONF"
chown -R "$SERVICE_USER:$SERVICE_USER" "$CONFDIR"

# The cache. A masjid's wallpaper is often a photograph of a few megabytes, and re-fetching it
# every frame would use more bandwidth than the video stream this whole design exists to avoid.
# Keeping it on disk is also what lets a screen come back after a power cut while the internet
# is still down.
mkdir -p "$STATEDIR/cache"
chown -R "$SERVICE_USER:$SERVICE_USER" "$STATEDIR"
chmod 750 "$STATEDIR"
say "Device id: $(cat /tmp/omd-device-id)"
rm -f /tmp/omd-device-id

# ── display settings that only take effect on reboot ─────────────────────────
#
# Two Pi-specific defaults that make a screen appliance behave. Both are appended only if absent,
# so re-running does not grow the file.

BOOTCFG=/boot/firmware/config.txt
[ -f "$BOOTCFG" ] || BOOTCFG=/boot/config.txt
if [ -f "$BOOTCFG" ]; then
  # Without this, a Pi that boots before the television is switched on sees no display at all and
  # never produces a framebuffer — the single most common "it just doesn't work" on a Pi.
  if ! grep -q '^hdmi_force_hotplug=1' "$BOOTCFG" 2>/dev/null; then
    say 'Enabling HDMI output even when the television is off at boot'
    printf '\n# Added by OpenMasjidDisplay: keep HDMI alive when the TV is off at boot\nhdmi_force_hotplug=1\n' >> "$BOOTCFG"
    NEEDS_REBOOT=1
  fi
fi

BOOTCMD=/boot/firmware/cmdline.txt
[ -f "$BOOTCMD" ] || BOOTCMD=/boot/cmdline.txt
if [ -f "$BOOTCMD" ] && ! grep -q 'consoleblank=0' "$BOOTCMD" 2>/dev/null; then
  # The console blanks after ten minutes with no keyboard input. On a screen nobody types at,
  # that means the display goes black and stays black.
  say 'Disabling console blanking'
  sed -i 's/$/ consoleblank=0/' "$BOOTCMD"
  NEEDS_REBOOT=1
fi

# ── systemd ──────────────────────────────────────────────────────────────────

say 'Installing the service'

cat > /etc/systemd/system/openmasjid-screen-console.service <<'UNIT'
# SPDX-License-Identifier: AGPL-3.0-only
# Takes the Linux text console off the HDMI output, so kernel messages and a blinking cursor stop
# being drawn over the timetable. This is the only part that needs root, so it is its own one-shot
# unit rather than a privilege the agent carries for its whole life.
[Unit]
Description=OpenMasjidDisplay: hand the framebuffer over to the screen agent
Before=openmasjid-screen.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'for v in /sys/class/vtconsole/vtcon*/bind; do [ -w "$v" ] && echo 0 > "$v" || true; done; exit 0'
ExecStart=/bin/sh -c 'printf "\033[?25l\033[9;0]" > /dev/tty0 || true; exit 0'

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/openmasjid-screen.service <<UNIT
# SPDX-License-Identifier: AGPL-3.0-only
[Unit]
Description=OpenMasjidDisplay screen agent
Documentation=https://github.com/OpenMasjid-Solutions/OpenMasjidDisplay
After=network-online.target openmasjid-screen-console.service
Wants=network-online.target openmasjid-screen-console.service
# No start-limit at all: a screen that systemd has given up on is a screen nobody notices is
# off until Jumuah.
StartLimitIntervalSec=0

[Service]
Type=simple
User=$SERVICE_USER
SupplementaryGroups=video tty
ExecStart=/usr/bin/node $PREFIX/agent.js
# A masjid screen must come back on its own from anything: a crash, a pulled network cable, a
# power cut. Always, with a short delay, and no start-limit that could ever leave it stopped.
Restart=always
RestartSec=5
# The agent writes exactly one file — its own config — and reads the framebuffer and the console.
# Everything else is closed off.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$CONFDIR $STATEDIR
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
# Left OFF deliberately: node JITs, so it needs pages that are both writable and executable.
MemoryDenyWriteExecute=no
DeviceAllow=/dev/fb0 rw
DeviceAllow=/dev/tty0 rw
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now openmasjid-screen-console.service >/dev/null 2>&1 || true
systemctl enable openmasjid-screen.service >/dev/null 2>&1
systemctl restart openmasjid-screen.service

say "Installed agent $AGENT_VERSION."
if [ "${NEEDS_REBOOT:-0}" = 1 ]; then
  say 'Display settings changed — reboot to apply them:  sudo reboot'
fi
say 'This screen should now show a setup code. Enter it in the dashboard under Screens.'
say 'If it does not:  sudo journalctl -u openmasjid-screen -n 50 --no-pager'
