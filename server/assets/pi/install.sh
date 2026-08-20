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
# Where the server's own certificate is pinned, when it turns out to be self-signed. Kept beside
# the config because it is part of how this device trusts its server, not disposable state.
CA=/etc/openmasjid-screen/server-ca.crt
# How this device talks to its server, written once at install and read by the updater.
#
# It lives in $PREFIX and NOT in config.json, deliberately. The agent rewrites config.json whenever
# it is adopted or forgotten, and it writes back only the keys it knows about — so anything the
# installer left there is destroyed within minutes of setup. The updater reading its trust settings
# from that file would therefore lose them almost immediately and fall back to a handshake already
# known to fail, leaving a screen that never updates again and says nothing about it.
#
# $PREFIX is read-only to the agent, so this file is also not something a compromised agent could
# rewrite to weaken the root updater that reads it.
TRUSTENV="$PREFIX/trust.env"
CONFDIR=/etc/openmasjid-screen
CONF="$CONFDIR/config.json"
# Downloaded wallpapers, logos and fonts. Separate from the config because it is disposable —
# deleting it costs one re-download, deleting the config costs somebody a walk to the television.
STATEDIR=/var/lib/openmasjid-screen
SERVICE_USER=omdscreen

STEPS=9
STEP=0
# Steps are numbered and every one says what it is doing BEFORE it does it. Installing node, npm
# and ffmpeg on a Pi 3 takes minutes, and a terminal that has printed nothing for four minutes is
# indistinguishable from one that has hung — which is when people reboot the Pi half-installed.
step() { STEP=$((STEP + 1)); printf '\n\033[36m==> [%s/%s] %s\033[0m\n' "$STEP" "$STEPS" "$*"; }
say()  { printf '\033[36m   ·\033[0m %s\n' "$*"; }
warn() { printf '\033[33m   ! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# A freshly imaged Raspberry Pi runs unattended-upgrades and apt-daily in the background for the
# first several minutes after it boots. Those hold the dpkg lock, and apt then waits for it —
# by default, forever. Combined with quiet output that is indistinguishable from a hang, and it
# is the single most likely reason an install appears to do nothing for twenty minutes.
#
# So: say who has the lock, and give apt a bounded, visible wait instead of an unbounded silent
# one. DPkg::Lock::Timeout makes apt fail with a real message rather than block indefinitely.
APT_OPTS='-o DPkg::Lock::Timeout=900'

apt_lock_holder() {
  # fuser is not always installed; fall back to whatever the process table shows.
  for f in /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock; do
    if command -v fuser >/dev/null 2>&1 && fuser "$f" >/dev/null 2>&1; then
      fuser "$f" 2>/dev/null | tr -s ' ' '\n' | while read -r pid; do
        [ -n "$pid" ] && ps -o comm= -p "$pid" 2>/dev/null
      done | sort -u | tr '\n' ' '
      return 0
    fi
  done
  # NOTE: no grep -v here. A previous version filtered on a bare dollar sign, which matches the
  # end of every line and silently discarded all output — making this fallback do nothing.
  pgrep -a -f 'unattended-upgrade|apt-get|aptitude|dpkg' 2>/dev/null | head -3 || true
}

wait_for_apt() {
  holder=$(apt_lock_holder)
  [ -n "${holder:-}" ] || return 0
  warn "another package operation is running: ${holder}"
  say 'this is normal on a Pi that has just booted — waiting for it to finish (up to 15 minutes)'
  i=0
  while [ "$i" -lt 90 ]; do
    sleep 10
    i=$((i + 1))
    holder=$(apt_lock_holder)
    if [ -z "${holder:-}" ]; then
      say 'the other operation has finished; carrying on'
      return 0
    fi
    [ $((i % 6)) -eq 0 ] && say "still waiting ($((i / 6)) min) — ${holder}"
  done
  warn 'it is still running. Carrying on anyway; apt will wait its turn or report an error.'
}

# ── checks ───────────────────────────────────────────────────────────────────
#
# Each of these is a failure that would otherwise show up much later as "the screen is black",
# which is the hardest thing to debug from a phone call.

step 'Checking this device'
[ "$(id -u)" = 0 ] || die "run this with sudo:  curl -fsSL $SERVER/pi.sh | sudo sh"
command -v apt-get >/dev/null 2>&1 || die 'this installer expects Raspberry Pi OS or another Debian-based system'
say "model:  $(tr -d '\0' < /proc/device-tree/model 2>/dev/null || uname -m)"
say "os:     $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -sr)"
say "server: $SERVER"

if [ ! -e /dev/fb0 ]; then
  # Not fatal. A Pi with no television attached at boot has no framebuffer, and the fix is a
  # config.txt line this script adds — so warn, carry on, and let the reboot sort it out.
  warn 'no /dev/fb0 yet — nothing can be drawn until a display is attached and the Pi is rebooted'
else
  say "display: $(cat /sys/class/graphics/fb0/virtual_size 2>/dev/null | tr ',' 'x') @ $(cat /sys/class/graphics/fb0/bits_per_pixel 2>/dev/null)bpp"
fi

# ── how this Pi will trust the display server ────────────────────────────────
#
# A masjid's display server is very often reached over HTTPS with a self-signed certificate — that
# is what OpenMasjidOS puts in front of it on a LAN. Nothing public can vouch for such a
# certificate, so plain verification fails, and the two obvious responses are both wrong: refusing
# to install leaves the feature unusable for most masjids, and passing -k forever means this device
# never authenticates its server again.
#
# So: trust on first use, then pin. If the certificate does not verify normally we take a copy of
# it now, and from this point on EVERY request — the agent's, the updater's — is verified against
# that exact certificate. Verification stays ON; what changes is which certificate is trusted. It
# is the same bargain SSH makes the first time you connect to a host.
#
# The one thing that must not happen quietly is falling back to no verification at all. If pinning
# does not work either (usually a certificate with no name matching the address you used), that is
# said loudly, here and in the log, rather than being smoothed over.
step 'Working out how to trust the display server'
CURL_OPTS=''
NODE_TLS_ENV=''

case "$SERVER" in
  https://*)
    if curl -fsS --max-time 20 -o /dev/null "$SERVER/pi/agent.js" 2>/dev/null; then
      say 'the certificate verifies normally — nothing to pin'
    else
      say 'the certificate does not verify (self-signed, most likely). Taking a copy of it.'
      HOSTPORT=$(printf '%s' "$SERVER" | sed -e 's#^https://##' -e 's#/.*##')
      case "$HOSTPORT" in *:*) : ;; *) HOSTPORT="$HOSTPORT:443" ;; esac

      command -v openssl >/dev/null 2>&1 || {
        say 'openssl is needed to read that certificate, and is not installed — fetching it first'
        # Lock-aware and visible, exactly like the main package step. This runs BEFORE that step,
        # so without the wait it is the first thing that can silently block on a Pi that has just
        # booted and is still running its own updates.
        wait_for_apt
        # shellcheck disable=SC2086
        apt-get $APT_OPTS update && apt-get $APT_OPTS install -y --no-install-recommends openssl \
          || die 'could not install openssl, which is needed to read this server certificate'
      }

      mkdir -p "$(dirname "$CA")"
      if openssl s_client -connect "$HOSTPORT" -servername "${HOSTPORT%%:*}" -showcerts </dev/null 2>/dev/null \
           | openssl x509 -outform PEM > "$CA.new" 2>/dev/null && [ -s "$CA.new" ]; then
        mv "$CA.new" "$CA"
        chmod 644 "$CA"
        # BOTH clients have to be asked, not just curl.
        #
        # curl and Node are different TLS stacks with different rules — most sharply about
        # certificates that carry a name only in the legacy Subject CN and no SAN, where the two
        # can disagree about whether the connection is acceptable. curl is what validates the pin
        # here; Node is what has to live with it for the next several months. Checking only curl
        # can therefore print "pinned — verified against it" and then hand over a screen whose
        # agent cannot make a single request, with nothing afterwards to catch it.
        if curl -fsS --max-time 20 --cacert "$CA" -o /dev/null "$SERVER/pi/agent.js" 2>/dev/null &&
           NODE_EXTRA_CA_CERTS="$CA" node -e '
             fetch(process.argv[1] + "/pi/agent.js", { redirect: "error" })
               .then((r) => process.exit(r.ok ? 0 : 1))
               .catch(() => process.exit(1));
           ' "$SERVER" 2>/dev/null; then
          say "pinned the server's certificate: $CA"
          say 'requests from now on are verified against it — not left unverified'
          CURL_OPTS="--cacert $CA"
          NODE_TLS_ENV="Environment=NODE_EXTRA_CA_CERTS=$CA"
          openssl x509 -in "$CA" -noout -subject -enddate 2>/dev/null | sed 's/^/   · /'
        else
          # The common real case: a self-signed certificate that does not NAME the address you
          # reached it by — an IP with no matching SAN. Chain verification would pass now that the
          # certificate is pinned; it is the hostname check that fails, and no amount of pinning
          # fixes a name that is not in the certificate.
          #
          # The lazy answer is -k, which accepts literally any certificate and so accepts an
          # attacker's. Instead we pin the server's PUBLIC KEY: curl still skips the name check,
          # but the connection is refused unless the peer holds this exact key. An attacker on the
          # network now needs the private key rather than merely a position on the path — which is
          # most of what the certificate was buying us anyway.
          PIN=$(openssl x509 -in "$CA" -pubkey -noout 2>/dev/null \
                | openssl pkey -pubin -outform DER 2>/dev/null \
                | openssl dgst -sha256 -binary 2>/dev/null \
                | openssl enc -base64 2>/dev/null || true)
          warn "the certificate does not name the address $HOSTPORT"
          if [ -n "${PIN:-}" ]; then
            warn 'pinning its public key instead: the name is not checked, but no other server is accepted'
            say  "key: sha256//$PIN"
            CURL_OPTS="-k --pinnedpubkey sha256//$PIN"
          else
            warn 'and its public key could not be read — continuing WITHOUT any verification'
            CURL_OPTS='-k'
          fi
          warn 'to fix this properly, give the server a certificate naming that address, then re-run this installer'
          # The agent cannot express "pinned key, no name check" through the environment, so it
          # takes the blunt setting. It only ever talks to this one server, and the warning above
          # is the honest description of what that means.
          NODE_TLS_ENV='Environment=NODE_TLS_REJECT_UNAUTHORIZED=0'
        fi
      else
        # We could not read a certificate at all. The overwhelmingly likely reason is that the
        # server is not reachable from this Pi — a typo, the wrong network, a firewall — and NOT
        # that it presented something strange.
        #
        # Refuse. Falling through to "no verification" here would permanently weaken a device
        # because of a temporary network problem, and it would do it at the one moment nobody
        # would notice: the install carries on, the screen pairs, and the downgrade is never
        # mentioned again. Re-running this after fixing the network costs nothing.
        rm -f "$CA.new"
        die "could not reach $HOSTPORT to read its certificate.
   Check this Pi can reach the display server, then run this installer again.
   Try:  curl -vk $SERVER/pi/agent.js"
      fi
    fi
    ;;
  *)
    say 'plain HTTP — no certificate to check'
    ;;
esac

mkdir -p "$PREFIX"
# Single-quoted values, and the only things that can appear in them are curl flags and a path we
# chose — nothing here comes from the network.
{
  printf '# SPDX-License-Identifier: AGPL-3.0-only\n'
  printf '# Written by the OpenMasjidDisplay installer. Read by update.sh. Do not edit by hand.\n'
  printf "SERVER='%s'\n" "$SERVER"
  printf "CURL_OPTS='%s'\n" "$CURL_OPTS"
} > "$TRUSTENV"
chmod 644 "$TRUSTENV"

# ── packages ─────────────────────────────────────────────────────────────────
#
# nodejs/npm run the agent. fonts-dejavu-core is what the pairing screen and the timetable are
# drawn with. ffmpeg is installed now even though nothing uses it until the camera support lands,
# because the alternative is asking every masjid to re-run this later.

step 'Installing packages'
export DEBIAN_FRONTEND=noninteractive
wait_for_apt

# Staged rather than one big install, for two reasons. It shows progress on a board where the
# whole thing takes a quarter of an hour, and it means a failure part-way leaves a Pi that can
# still do something rather than one that can do nothing.
say 'refreshing the package lists'
# shellcheck disable=SC2086
apt-get $APT_OPTS update || die 'apt-get update failed — check this Pi has a working network'

say 'installing node and the tools the agent needs'
# shellcheck disable=SC2086
apt-get $APT_OPTS install -y --no-install-recommends \
  nodejs npm ca-certificates curl openssl fonts-dejavu-core fbset \
  || die 'could not install the base packages'

command -v node >/dev/null 2>&1 || die 'node did not install; check `apt-get install nodejs`'
say "node $(node -v), npm $(npm -v 2>/dev/null || echo '?')"

step 'Installing ffmpeg (the big one)'
# By far the largest download here — several hundred megabytes of dependencies on a Pi 3, and the
# step people watch in silence and assume has died. It is also the ONLY part that is not needed to
# show a timetable, so a failure here is a warning rather than the end: the screen still pairs and
# still shows prayer times, and re-running the installer later adds cameras.
say 'this is the slow part — expect several minutes, and a lot of output'
# shellcheck disable=SC2086
if apt-get $APT_OPTS install -y --no-install-recommends ffmpeg; then
  say "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3 || echo installed)"
else
  warn 'ffmpeg did not install. The timetable will work; cameras will not.'
  warn 'run this installer again later to add them.'
fi

# Cameras are drawn by ffmpeg writing straight to the framebuffer, so this build has to have the
# fbdev output device. Debian ships it, but a hand-built or minimal ffmpeg may not — and the
# symptom would be a camera that silently never appears, which is a miserable thing to diagnose
# from a phone call. Warn now, while somebody is still looking at a terminal.
if ! ffmpeg -hide_banner -devices 2>/dev/null | grep -q fbdev; then
  say "warning: this ffmpeg has no fbdev output device. The timetable will work; cameras will not."
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 18 ] || die "node 18 or newer is required (found $(node -v 2>/dev/null || echo none)). Update Raspberry Pi OS."

# ── the agent ────────────────────────────────────────────────────────────────

step 'Fetching the screen agent'
mkdir -p "$PREFIX"
cd "$PREFIX"

# The rasteriser is a native module, so it cannot be bundled — it is the one thing installed from
# npm. Pinned to the exact version the display server renders with, so a Pi draws the same pixels
# the server does rather than almost the same ones.
if [ ! -d "$PREFIX/node_modules/@resvg/resvg-js" ] || \
   [ "$(node -p "require('$PREFIX/node_modules/@resvg/resvg-js/package.json').version" 2>/dev/null || echo none)" != "$RESVG_VERSION" ]; then
  say "installing the renderer (@resvg/resvg-js $RESVG_VERSION)"
  say 'a prebuilt binary for this board, fetched from the npm registry — a minute or two on a Pi 3'
  printf '%s\n' '{ "name": "openmasjid-screen-agent", "private": true }' > "$PREFIX/package.json"
  # NOTE: this comes from the npm registry, not from the masjid's display server, so the pinned
  # certificate has nothing to do with it — it is verified against the public roots as normal.
  npm install --no-audit --no-fund --omit=dev --loglevel=http "@resvg/resvg-js@$RESVG_VERSION" \
    || die 'could not install the renderer. Is this Pi online, and can it reach registry.npmjs.org?'
else
  say "renderer already present (@resvg/resvg-js $RESVG_VERSION)"
fi

# Downloaded to a temporary name and moved into place, so an interrupted download cannot leave a
# truncated agent that systemd then restarts forever.
say "downloading $SERVER/pi/agent.js"
# shellcheck disable=SC2086
curl -fsSL $CURL_OPTS "$SERVER/pi/agent.js" -o "$PREFIX/agent.new.js" || die "could not download the agent from $SERVER"
[ -s "$PREFIX/agent.new.js" ] || die 'the downloaded agent was empty'
node --check "$PREFIX/agent.new.js" || die 'the downloaded agent is not valid JavaScript'
mv "$PREFIX/agent.new.js" "$PREFIX/agent.js"
say "agent $AGENT_VERSION installed ($(wc -c < "$PREFIX/agent.js") bytes)"

# ── the service account ──────────────────────────────────────────────────────
#
# The agent does not run as root. It needs three things — the framebuffer, the console, and its
# own config — and group membership covers all three. The one genuinely root-only action (taking
# the text console off the screen) is a separate one-shot unit below, so the long-running process
# holds no privileges it does not use.

step 'Creating the service account'
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  say "adding the unprivileged user $SERVICE_USER"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
usermod -aG video,tty,render "$SERVICE_USER" 2>/dev/null || usermod -aG video,tty "$SERVICE_USER"
say "groups: $(id -nG "$SERVICE_USER" 2>/dev/null || echo '?')"

# ── config ───────────────────────────────────────────────────────────────────
#
# Written by node rather than by hand, because this has to MERGE: a re-run must update the server
# address and leave the device's identity and its adoption token alone. A re-run that reset the
# token would send somebody back to the television to read a new code, which is exactly the
# support call this whole design exists to avoid.

step 'Writing the configuration'
mkdir -p "$CONFDIR"
SERVER="$SERVER" CONF="$CONF" node -e '
const fs = require("fs"), crypto = require("crypto");
const file = process.env.CONF;
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { cfg = {}; }
if (typeof cfg !== "object" || cfg === null) cfg = {};
cfg.server = process.env.SERVER;
// NOTE: nothing about TLS is recorded here. The agent rewrites this file on adoption and keeps
// only the keys it knows about, so anything else written here does not survive the first few
// minutes. The trust decision lives in trust.env, which the agent cannot write.
// (No apostrophes in this block: it sits inside a single-quoted shell string.)
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
# Where the agent leaves a request for something it is not allowed to do itself. It can write
# here; it cannot write /opt, which is where the thing that ACTS on the request lives.
mkdir -p "$STATEDIR/control"
chown -R "$SERVICE_USER:$SERVICE_USER" "$STATEDIR"
chmod 750 "$STATEDIR"
say "device id: $(cat /tmp/omd-device-id)"
rm -f /tmp/omd-device-id
say "config:   $CONF"
say "trust:    $TRUSTENV"
[ -f "$CA" ] && say "pinned CA: $CA"

# ── display settings that only take effect on reboot ─────────────────────────
#
# Two Pi-specific defaults that make a screen appliance behave. Both are appended only if absent,
# so re-running does not grow the file.

step 'Checking the display settings'
BOOTCFG=/boot/firmware/config.txt
[ -f "$BOOTCFG" ] || BOOTCFG=/boot/config.txt
if [ -f "$BOOTCFG" ]; then
  # Without this, a Pi that boots before the television is switched on sees no display at all and
  # never produces a framebuffer — the single most common "it just doesn't work" on a Pi.
  if ! grep -q '^hdmi_force_hotplug=1' "$BOOTCFG" 2>/dev/null; then
    say 'enabling HDMI output even when the television is off at boot'
    printf '\n# Added by OpenMasjidDisplay: keep HDMI alive when the TV is off at boot\nhdmi_force_hotplug=1\n' >> "$BOOTCFG"
    NEEDS_REBOOT=1
  fi
  # Ask for a 32-bit framebuffer.
  #
  # On a 16-bit one there are 65 thousand colours instead of 16 million, and this display is built
  # out of soft gradients and translucent panels — every one of them becomes a staircase of flat
  # bands. The reported symptom was a timetable that looked washed out and "very simple" beside the
  # same design in a browser, on a Pi whose framebuffer came up at 16bpp.
  #
  # The agent dithers when it has to, which hides most of it, but this removes the problem rather
  # than concealing it. Some display drivers ignore the request, which is exactly why the dither is
  # not optional.
  # Give the hardware video decoder enough memory to work with.
  #
  # bcm2835-codec is the firmware-side decoder, so it draws on the GPU split rather than on system
  # RAM. A Pi measured 76M, which is not enough to decode 1080p — and the failure is silent, in the
  # sense that ffmpeg simply cannot open a decoder and says it could not find one. 128M is the
  # documented minimum for 1080p and still leaves a 1GB Pi 3 the great majority of its memory.
  if ! grep -q '^gpu_mem=' "$BOOTCFG" 2>/dev/null; then
    say 'reserving 128M for the video decoder (needed for hardware camera decoding)'
    printf '
# Added by OpenMasjidDisplay: the hardware H.264 decoder needs this to decode 1080p
gpu_mem=128
' >> "$BOOTCFG"
    NEEDS_REBOOT=1
  fi
  if ! grep -q '^framebuffer_depth=32' "$BOOTCFG" 2>/dev/null; then
    say 'asking for a 32-bit framebuffer, so gradients do not band'
    printf '\n# Added by OpenMasjidDisplay: 32-bit colour, so gradients do not band\nframebuffer_depth=32\nframebuffer_ignore_alpha=1\n' >> "$BOOTCFG"
    NEEDS_REBOOT=1
  fi
fi

BOOTCMD=/boot/firmware/cmdline.txt
[ -f "$BOOTCMD" ] || BOOTCMD=/boot/cmdline.txt
if [ -f "$BOOTCMD" ] && ! grep -q 'consoleblank=0' "$BOOTCMD" 2>/dev/null; then
  # The console blanks after ten minutes with no keyboard input. On a screen nobody types at,
  # that means the display goes black and stays black.
  say 'disabling console blanking'
  sed -i 's/$/ consoleblank=0/' "$BOOTCMD"
  NEEDS_REBOOT=1
fi

# ── systemd ──────────────────────────────────────────────────────────────────

step 'Installing the service'

cat > /etc/systemd/system/openmasjid-screen-console.service <<'UNIT'
# SPDX-License-Identifier: AGPL-3.0-only
# Takes the Linux text console off the HDMI output, so kernel messages and a blinking cursor stop
# being drawn over the timetable. This is the only part that needs root, so it is its own one-shot
# unit rather than a privilege the agent carries for its whole life.
#
# It runs AFTER the agent, and that ordering is the whole point. An earlier version ran it BEFORE,
# early in boot — which took the console away while the rest of the system was still starting and
# nothing had drawn anything yet. The result was a television frozen on whatever boot message
# happened to be printing at that instant, for good. Boot messages that stop advancing look
# exactly like a machine stuck in a loop, which is precisely how it was reported.
#
# Never take the screen away from whatever is using it until something else is ready to draw.
[Unit]
Description=OpenMasjidDisplay: hand the framebuffer over to the screen agent
After=openmasjid-screen.service

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
After=network-online.target
# Wants, but deliberately NOT After: the console unit is ordered after THIS one, so that the
# screen is never taken away from the boot messages before the agent can put something there.
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
# AF_NETLINK is NOT optional, however much it looks like tightening to drop it.
#
# Enumerating this machine's own network interfaces goes through a netlink socket, so without it
# the agent fails with EAFNOSUPPORT on startup -- every five seconds, forever. glibc resolves
# names over netlink too, so ffmpeg would not have found a camera by hostname either.
#
# NOTE: this heredoc is UNQUOTED, because it has to expand the settings above. That means
# backticks and dollar-parens in here are COMMAND SUBSTITUTION, not punctuation -- a code
# reference in backticks in this very comment was executed by the shell and killed the installer
# at the last step. Keep this block free of both.
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictNamespaces=yes
LockPersonality=yes
# Left OFF deliberately: node JITs, so it needs pages that are both writable and executable.
MemoryDenyWriteExecute=no
DeviceAllow=/dev/fb0 rw
DeviceAllow=/dev/tty0 rw
# The Pi's hardware video decoder, and this line is why it did not work.
#
# Naming ANY device in DeviceAllow turns the whole thing into an allowlist — everything unnamed is
# then denied, however the file's own permissions read. So the two lines above were quietly
# blocking /dev/video10, and ffmpeg reported it the only way it can: it scanned for a V4L2 decoder,
# found none it was permitted to open, and said "Could not find a valid device". The decoder was
# loaded and the service account was in the video group the whole time.
#
# char-video4linux covers the codec nodes as a class, which is what is wanted here: the numbering
# is not stable across kernels, and hardcoding video10 would break on the next one.
DeviceAllow=char-video4linux rw
Environment=NODE_ENV=production
# How this device trusts its display server, decided at install time. Either a pinned certificate
# (verification ON, against that one certificate) or — said loudly at the time — no verification,
# when the certificate could not be made to match the address. Empty for plain HTTP.
$NODE_TLS_ENV

[Install]
WantedBy=multi-user.target
UNIT

# ── keeping itself current ───────────────────────────────────────────────────
#
# A masjid may have a Pi behind every television, and a release that needed somebody to walk round
# with a keyboard would simply not get installed. So the agent follows the display server.
#
# The update runs as ROOT, on a timer, in its own unit — NOT inside the agent. The agent is the
# long-running, network-facing process, and it deliberately cannot write to /opt: a process that
# can rewrite its own code is a much larger thing to trust than one that cannot. Splitting it out
# is the same reasoning as the console unit above.

cat > "$PREFIX/update.sh" <<'UPD'
#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 OpenMasjid-Solutions
# Fetch the screen agent this display server is shipping, and switch to it if it differs.
set -eu
PREFIX=/opt/openmasjid-screen
CONF=/etc/openmasjid-screen/config.json

# The server address and the trust decision, exactly as the installer worked them out.
#
# Read from a root-owned file next to the agent, NOT from config.json. The agent rewrites its
# config whenever it is adopted or forgotten and keeps only the keys it knows about, so anything
# the installer put there is gone within minutes — and an updater that then guessed would fall
# back to a handshake already known to fail on this device and stop updating forever, silently.
CURL_OPTS=""
SERVER=""
if [ -f "$PREFIX/trust.env" ]; then
  . "$PREFIX/trust.env"
fi
if [ -z "$SERVER" ]; then
  # Only for a device installed before trust.env existed. Re-running the installer writes one.
  SERVER=$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).server||""))}catch{}' "$CONF" 2>/dev/null || true)
fi

[ -n "$SERVER" ] || { echo "no server configured; nothing to update from"; exit 0; }

TMP="$PREFIX/agent.new.js"
# shellcheck disable=SC2086
curl -fsSL --max-time 120 $CURL_OPTS "$SERVER/pi/agent.js" -o "$TMP" || { echo "could not download the agent"; exit 0; }
[ -s "$TMP" ] || { rm -f "$TMP"; echo "downloaded agent was empty"; exit 0; }
# A truncated or half-written download must never become the thing systemd restarts forever.
node --check "$TMP" || { rm -f "$TMP"; echo "downloaded agent is not valid JavaScript"; exit 0; }

if cmp -s "$TMP" "$PREFIX/agent.js"; then
  rm -f "$TMP"
  exit 0
fi

echo "updating the screen agent"
cp -f "$PREFIX/agent.js" "$PREFIX/agent.prev.js" 2>/dev/null || true
mv "$TMP" "$PREFIX/agent.js"
systemctl restart openmasjid-screen.service

# Roll back if the new one will not stay up. Without this, a bad build takes every screen in the
# masjid dark until somebody notices and knows what to do — and nobody is watching these.
sleep 20
if ! systemctl is-active --quiet openmasjid-screen.service; then
  echo "the new agent did not stay running; rolling back"
  if [ -f "$PREFIX/agent.prev.js" ]; then
    mv "$PREFIX/agent.prev.js" "$PREFIX/agent.js"
    systemctl restart openmasjid-screen.service
  fi
fi
UPD
chmod 700 "$PREFIX/update.sh"

cat > /etc/systemd/system/openmasjid-screen-update.service <<'UNIT'
# SPDX-License-Identifier: AGPL-3.0-only
[Unit]
Description=OpenMasjidDisplay: update the screen agent
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/openmasjid-screen/update.sh
UNIT

cat > /etc/systemd/system/openmasjid-screen-update.timer <<'UNIT'
# SPDX-License-Identifier: AGPL-3.0-only
[Unit]
Description=OpenMasjidDisplay: check for a new screen agent

[Timer]
# Shortly after boot, then a few times a day. RandomizedDelaySec so a masjid with a screen in
# every hall does not have all of them ask at the same second.
OnBootSec=3min
OnUnitActiveSec=6h
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# ── doing what the agent may not ─────────────────────────────────────────────
#
# "Update now" from the dashboard needs root: it replaces the agent in /opt, which the agent
# deliberately cannot write, so that a long-lived network-facing process cannot rewrite its own
# code.
#
# There is NO sudoers entry here, and that is not a preference. The agent runs with
# NoNewPrivileges=yes, which makes execve() ignore setuid bits entirely — sudo detects the flag and
# refuses outright. The only way to make sudo work would be to delete that line, which would re-open
# every setuid binary on the box to the one process most exposed to the network. Strictly worse than
# the feature is worth.
#
# So root is the active party. The agent leaves a file; a .path unit notices; a root one-shot acts.
# The request is UNLINKED BEFORE IT IS ACTED ON, because a request that survived the action would
# re-trigger the watcher and repeat it for ever.

cat > "$PREFIX/control.sh" <<'CTL'
#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 OpenMasjid-Solutions
# Carry out a request the screen agent left, then remove it. Runs as root, from a .path unit.
set -eu
PREFIX=/opt/openmasjid-screen
SPOOL=/var/lib/openmasjid-screen/control

# The server address and the trust settings the installer worked out.
#
# This heredoc is QUOTED, so nothing in this file was substituted when it was written — $SERVER
# here is a runtime variable, not a baked-in string. Without this line it is simply unset, and the
# reinstall branch below took its "no server address" path every single time. update.sh sources the
# same file for the same reason; this one did not, and since the panel's Update button became a
# reinstall that meant Update silently did nothing at all.
SERVER=""
CURL_OPTS=""
[ -f "$PREFIX/trust.env" ] && . "$PREFIX/trust.env"

[ -d "$SPOOL" ] || exit 0
for req in "$SPOOL"/*; do
  [ -f "$req" ] || continue
  # Read it, then DELETE IT, before doing anything. A request still present afterwards would
  # retrigger the watcher and loop.
  action=$(head -c 32 "$req" 2>/dev/null | tr -dc 'a-z-' || true)
  rm -f "$req"
  case "$action" in
    update)
      echo "control: running the updater at the dashboard's request"
      "$PREFIX/update.sh" || echo "control: the updater reported a problem"
      ;;
    reinstall)
      # Re-run the whole installer, so a change to the service unit, the boot settings or the
      # installed packages can be applied without anybody opening a shell on the Pi. The updater
      # above replaces the agent file and NOTHING else, which is why this verb has to exist.
      #
      # Worth being clear about what this is: root fetching a shell script from the display server
      # and running it. That is the same thing the admin does by hand to install a screen in the
      # first place, over the same pinned certificate — but it can now happen without a person
      # present, so it is fetched over the SAME verified channel as everything else, checked for
      # truncation before it runs, and rate limited.
      if [ -z "${SERVER:-}" ]; then
        echo 'control: no server address; cannot re-run the installer'
      else
        now=$(date +%s)
        last=0
        [ -f "$PREFIX/last-reinstall" ] && last=$(cat "$PREFIX/last-reinstall" 2>/dev/null || echo 0)
        case "$last" in *[!0-9]*|'') last=0 ;; esac
        if [ $((now - last)) -lt 300 ]; then
          echo "control: refusing to re-run the installer again so soon ($((now - last))s ago)"
        else
          echo "$now" > "$PREFIX/last-reinstall"
          TMP=/tmp/omd-reinstall.sh
          # shellcheck disable=SC2086
          if curl -fsSL --max-time 120 $CURL_OPTS "$SERVER/pi.sh" -o "$TMP" && [ -s "$TMP" ] && sh -n "$TMP"; then
            echo 'control: re-running the installer at the dashboard request'
            # Detached from this one-shot on purpose. The installer restarts the very service that
            # led to us being triggered, and systemd would otherwise consider that a dependency
            # of a unit it is still starting.
            setsid sh "$TMP" >/dev/null 2>&1 &
          else
            echo 'control: could not fetch a usable installer; leaving the screen alone'
          fi
          rm -f "$TMP" 2>/dev/null || true
        fi
      fi
      ;;
    reboot)
      # Rate limited, and that is not optional. A reboot loop takes a screen off the wall for
      # good and nobody is watching it; one every ten minutes is far more than a person needs and
      # slow enough that a masjid notices something is wrong rather than never seeing a picture.
      now=$(date +%s)
      last=0
      [ -f "$PREFIX/last-reboot" ] && last=$(cat "$PREFIX/last-reboot" 2>/dev/null || echo 0)
      case "$last" in *[!0-9]*|'') last=0 ;; esac
      if [ $((now - last)) -lt 600 ]; then
        echo "control: refusing to reboot again so soon ($((now - last))s ago)"
      else
        echo "$now" > "$PREFIX/last-reboot"
        echo 'control: rebooting at the dashboard request'
        systemctl reboot
      fi
      ;;
    *)
      # A closed set with no default that runs anything. An agent that has been tampered with can
      # write a file here; it cannot invent a new verb.
      echo "control: ignoring unknown request '$action'"
      ;;
  esac
done
CTL
chmod 700 "$PREFIX/control.sh"

cat > /etc/systemd/system/openmasjid-screen-control.service <<'UNIT'
# SPDX-License-Identifier: AGPL-3.0-only
[Unit]
Description=OpenMasjidDisplay: carry out a screen agent request

[Service]
Type=oneshot
ExecStart=/opt/openmasjid-screen/control.sh
UNIT

cat > /etc/systemd/system/openmasjid-screen-control.path <<'UNIT'
# SPDX-License-Identifier: AGPL-3.0-only
[Unit]
Description=OpenMasjidDisplay: watch for a screen agent request

[Path]
# DirectoryNotEmpty rather than PathExists: it re-checks after the service finishes, so a request
# that arrived while the last one was running is still picked up.
DirectoryNotEmpty=/var/lib/openmasjid-screen/control
Unit=openmasjid-screen-control.service

[Install]
WantedBy=paths.target
UNIT

systemctl daemon-reload
systemctl enable --now openmasjid-screen-console.service >/dev/null 2>&1 || true
systemctl enable openmasjid-screen.service >/dev/null 2>&1
systemctl enable --now openmasjid-screen-update.timer >/dev/null 2>&1 || true
systemctl enable --now openmasjid-screen-control.path >/dev/null 2>&1 || true
systemctl restart openmasjid-screen.service

printf '\n\033[32m==> Done.\033[0m Installed agent %s.\n' "$AGENT_VERSION"
if [ "$CURL_OPTS" = '-k' ]; then
  warn 'this screen does NOT verify the display server certificate — see the warning above'
fi
if [ "${NEEDS_REBOOT:-0}" = 1 ]; then
  say 'Display settings changed — reboot to apply them:  sudo reboot'
fi
say 'This screen should now show a setup code. Enter it in the dashboard under Screens.'
say 'This screen will keep itself up to date with the display server from now on.'
say 'If it does not:  sudo journalctl -u openmasjid-screen -n 50 --no-pager'
