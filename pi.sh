#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 OpenMasjid-Solutions
#
# OpenMasjidDisplay — install a Raspberry Pi screen that runs on its own.
#
#   curl -fsSL https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidDisplay/main/pi.sh | sudo sh
#   curl -fsSL https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidDisplay/main/pi.sh | sudo sh -s -- --channel dev
#
# This file is a BOOTSTRAP and deliberately almost nothing. It finds the right release, downloads
# the bundle, checks it against the published checksums, and hands over to the installer inside
# that bundle. Everything that actually touches the machine — packages, the service account, the
# systemd units, the boot config — lives in that installer, which is the SAME script a display
# server serves. One installer, two ways of reaching it, so a standalone screen and an adopted
# one cannot drift into being set up differently.
#
# Why the checksum matters here and not there: a display server is on the masjid's own network
# and was reached over a pinned certificate. This is a download from the public internet, so the
# bytes have to prove themselves. The checksums come from the same release as the bundle — which
# means this trusts GitHub's TLS and GitHub's account security, and says so rather than implying
# more.
#
# Deliberately POSIX sh with `set -eu`, for the same reason the installer is: Pi OS Lite has
# /bin/sh as dash, and a script piped into `sh` that half-runs is worse than one that refuses.
set -eu

REPO=OpenMasjid-Solutions/OpenMasjidDisplay
CHANNEL=stable

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
say()  { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="${2:-stable}"; shift 2 ;;
    --channel=*) CHANNEL="${1#--channel=}"; shift ;;
    -h|--help)
      printf 'Install an OpenMasjidDisplay screen on this Raspberry Pi.\n\n'
      printf '  --channel stable   the latest release (default)\n'
      printf '  --channel dev      the latest pre-release, for testing\n\n'
      exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

case "$CHANNEL" in
  stable|dev) ;;
  *) die "unknown channel \"$CHANNEL\" — use stable or dev" ;;
esac

[ "$(id -u)" = 0 ] || die 'run this with sudo:
  curl -fsSL https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidDisplay/main/pi.sh | sudo sh'

for t in curl tar sha256sum; do
  command -v "$t" >/dev/null 2>&1 || die "this needs $t, which is not installed"
done

bold "OpenMasjidDisplay — installing the $CHANNEL channel"

# ── which release ────────────────────────────────────────────────────────────
#
# Parsed with sed rather than a JSON tool, because a fresh Raspberry Pi OS Lite has neither jq
# nor node yet — node is installed by the installer this script is about to fetch. The fields
# wanted are two strings from GitHub's own API, and the pattern is anchored enough that a value
# containing a brace or a comma cannot widen it.
API="https://api.github.com/repos/$REPO/releases"
[ "$CHANNEL" = stable ] && API="$API/latest"

say 'asking GitHub for the release'
JSON=$(curl -fsSL --max-time 60 -H 'Accept: application/vnd.github+json' "$API" 2>/dev/null) ||
  die 'could not reach GitHub. Is this Pi online?'

if [ "$CHANNEL" = dev ]; then
  # The newest entry, pre-release or not: the dev channel is "whatever is latest", and a stable
  # release is newer than the pre-release before it.
  JSON=$(printf '%s' "$JSON" | sed -n '1,/^  },$/p')
fi

TAG=$(printf '%s' "$JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -n "$TAG" ] || die "no $CHANNEL release found for $REPO"
say "release: $TAG"

BASE="https://github.com/$REPO/releases/download/$TAG"
BUNDLE_NAME="openmasjid-screen-$TAG.tar.gz"

# ── download and prove it ────────────────────────────────────────────────────
WORK=$(mktemp -d /tmp/omd-install.XXXXXX) || die 'could not make a temporary directory'
# Removed on every exit, including a failure: a half-downloaded bundle left in /tmp is a thing
# somebody later finds and runs.
trap 'rm -rf "$WORK"' EXIT INT TERM
cd "$WORK"

say "downloading $BUNDLE_NAME"
curl -fsSL --max-time 600 -o "$BUNDLE_NAME" "$BASE/$BUNDLE_NAME" ||
  die "could not download the bundle for $TAG.
  This release may not carry one yet — try --channel dev, or install from a display server."
curl -fsSL --max-time 60 -o SHA256SUMS "$BASE/SHA256SUMS" ||
  die "could not download the checksums for $TAG. Refusing to install unverified bytes."

say 'checking the download against the published checksum'
# `--ignore-missing` so a SHA256SUMS listing several files still verifies when only one was
# fetched; `--status` so the result is the exit code and not a line to be misread.
sha256sum --ignore-missing --status -c SHA256SUMS ||
  die "the download does not match the published checksum for $TAG.
  This is either a corrupted download or something that should not be installed. Nothing was changed."
say "verified $(sha256sum "$BUNDLE_NAME" | cut -c1-16)…"

tar xzf "$BUNDLE_NAME" || die 'the bundle could not be unpacked'
[ -s install.sh ] || die 'the bundle has no installer in it'
[ -s agent.js ] || die 'the bundle has no agent in it'
sh -n install.sh || die 'the installer in the bundle is not valid shell — refusing to run it'

# ── hand over ────────────────────────────────────────────────────────────────
#
# The installer does the rest. OMD_BUNDLE tells it to take the agent and the control panel from
# here rather than from a display server, which is the whole difference between a standalone
# screen and an adopted one at install time.
bold 'Handing over to the installer'
OMD_BUNDLE="$WORK" sh install.sh
