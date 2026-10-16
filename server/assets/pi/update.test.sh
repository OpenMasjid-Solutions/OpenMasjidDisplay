#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 OpenMasjid-Solutions
#
# Exercise the updater that install.sh writes — the standalone branch in particular.
#
# ── WHY THIS IS A SHELL TEST AND NOT A NODE ONE ──────────────────────────────
#
# The rest of install.sh is covered by piInstaller.test.ts, which reads the script as text and
# asserts things about it. That is the right tool for "does this line exist", and the wrong one
# for this: the standalone updater is a chain of curl, sed, tar, sha256sum and node that either
# works end to end or silently does nothing, and nothing readable about the source distinguishes
# those two. The only way to know is to run it.
#
# So it runs, against a fake release on disk, with everything that touches the machine replaced:
#
#   PREFIX     -> a temporary directory, never /opt
#   GitHub     -> file:// URLs, never the network
#   systemctl  -> a stub on PATH that restarts nothing (and can be told to report a dead unit)
#   the board  -> a file we write, not /proc/device-tree/model
#
# That last one is not tidiness. Run on a Pi this passed without it, because the board gate was
# satisfied for real; run anywhere else — a CI runner, a laptop — every test failed at the gate
# and the suite was useless exactly where it most needed to run. Faking the board also makes the
# gate itself testable from both sides, which it was not before.
#
# Needs only POSIX sh, curl, tar and sha256sum, which is what a Raspberry Pi has and what the CI
# runner has. Run it from anywhere: `sh server/assets/pi/update.test.sh`.
set -eu

# The updater node --checks what it downloaded, so a missing node makes every test fail at the
# same place for a reason that has nothing to do with the updater. Say so once instead.
for t in curl tar sha256sum node; do
  command -v "$t" >/dev/null 2>&1 || { echo "this test needs $t, which is not installed"; exit 1; }
done

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALLER="$HERE/install.sh"
[ -r "$INSTALLER" ] || { echo "cannot read $INSTALLER"; exit 1; }

R=$(mktemp -d "${TMPDIR:-/tmp}/omd-updtest.XXXXXX")
trap 'rm -rf "$R"' EXIT INT TERM
mkdir -p "$R/rel/download/v9.9.9" "$R/prefix/web" "$R/bundle/web" "$R/bin"

# ── the updater under test, lifted out of the installer ──────────────────────
#
# Taken from install.sh rather than kept as a second copy, so this cannot pass against a version
# of the updater that is no longer the one a screen gets.
awk '/^cat > "\$PREFIX\/update.sh" <<.UPD.$/{f=1;next} /^UPD$/{f=0} f' "$INSTALLER" > "$R/raw.sh"
[ -s "$R/raw.sh" ] || { echo "could not find the update.sh heredoc in install.sh"; exit 1; }

echo 'Raspberry Pi 4 Model B Rev 1.5' > "$R/model"
sed -e "s#^PREFIX=/opt/openmasjid-screen#PREFIX=$R/prefix#" \
    -e "s#< /proc/device-tree/model#< $R/model#" \
    -e "s#https://api.github.com/repos/\$REPO/releases#file://$R/rel/releases#" \
    -e "s#API=\"\$API/latest\"#API=\"file://$R/rel/latest\"#" \
    -e "s#https://github.com/\$REPO/releases/download/\$TAG#file://$R/rel/download/\$TAG#" \
    -e 's#^sleep 20#sleep 0#' \
    "$R/raw.sh" > "$R/update.sh"
sh -n "$R/update.sh" || { echo "the updater install.sh writes is not valid shell"; exit 1; }
# If a rewrite above stopped matching, the test would quietly talk to the real GitHub and pass
# for the wrong reason. Assert every substitution landed.
for must in "PREFIX=$R/prefix" "file://$R/rel/releases" "file://$R/rel/latest" "file://$R/rel/download" "< $R/model"; do
  grep -qF "$must" "$R/update.sh" || { echo "a rewrite did not match: $must"; exit 1; }
done
grep -q 'github.com' "$R/update.sh" && { echo "the updater still reaches the real network"; exit 1; }

# ── a fake release ───────────────────────────────────────────────────────────
echo 'console.log("new agent 9.9.9")' > "$R/bundle/agent.js"
echo '<html>new panel</html>' > "$R/bundle/web/index.html"
( cd "$R/bundle" && tar czf "$R/rel/download/v9.9.9/openmasjid-screen-v9.9.9.tar.gz" . )
( cd "$R/rel/download/v9.9.9" && sha256sum openmasjid-screen-v9.9.9.tar.gz > SHA256SUMS )
# Shaped like GitHub's own answer: newest first, and the dev channel takes the first entry
# whether or not it is a pre-release.
cat > "$R/rel/releases" <<'J'
[
  {
    "tag_name": "v9.9.9",
    "prerelease": true
  },
  {
    "tag_name": "v9.9.8",
    "prerelease": false
  }
]
J
cat > "$R/rel/latest" <<'J'
{
  "tag_name": "v9.9.8",
  "prerelease": false
}
J

# ── a systemctl that restarts nothing ────────────────────────────────────────
cat > "$R/bin/systemctl" <<SC
#!/bin/sh
case "\$1 \$2" in
  "is-active --quiet") [ -f "$R/STAYDOWN" ] && exit 3; exit 0 ;;
esac
exit 0
SC
chmod +x "$R/bin/systemctl"
PATH="$R/bin:$PATH"; export PATH

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok   $1"; }
bad() { fail=$((fail+1)); echo "  FAIL $1"; }
trust() { printf "SERVER='%s'\nCURL_OPTS=''\nCHANNEL='%s'\nVERSION='%s'\n" "$1" "$2" "$3" > "$R/prefix/trust.env"; }
reset() {
  rm -f "$R/STAYDOWN" "$R/prefix/agent.prev.js"
  rm -rf "$R/prefix/web.prev"
  echo 'console.log("old agent")' > "$R/prefix/agent.js"
  mkdir -p "$R/prefix/web"; echo '<html>old panel</html>' > "$R/prefix/web/index.html"
}

echo
echo "-- a newer dev release installs the agent and the panel together"
reset; trust '' dev v9.9.8
sh "$R/update.sh" > "$R/out" 2>&1 || bad "exited non-zero: $(cat "$R/out")"
grep -q 'new agent 9.9.9' "$R/prefix/agent.js" && ok "agent replaced" || bad "agent not replaced"
grep -q 'new panel' "$R/prefix/web/index.html" && ok "panel replaced" || bad "panel not replaced"
grep -q "VERSION='v9.9.9'" "$R/prefix/trust.env" && ok "version recorded" || bad "version NOT recorded: $(cat "$R/prefix/trust.env")"
[ -d "$R/prefix/web.prev" ] && bad "web.prev left behind" || ok "the rollback copy is cleaned up"

echo
echo "-- the same release again changes nothing and says nothing"
cp "$R/prefix/agent.js" "$R/agent.before"
sh "$R/update.sh" > "$R/out" 2>&1 || bad "exited non-zero"
cmp -s "$R/agent.before" "$R/prefix/agent.js" && ok "agent untouched" || bad "agent rewritten"
[ -s "$R/out" ] && bad "noisy: $(cat "$R/out")" || ok "silent"

echo
echo "-- a tampered bundle is refused and nothing is changed"
reset; trust '' dev v9.9.8
cp "$R/rel/download/v9.9.9/openmasjid-screen-v9.9.9.tar.gz" "$R/good.tgz"
printf 'tampered' >> "$R/rel/download/v9.9.9/openmasjid-screen-v9.9.9.tar.gz"
sh "$R/update.sh" > "$R/out" 2>&1 || bad "exited non-zero"
grep -qi 'checksum' "$R/out" && ok "refused on the checksum" || bad "no checksum refusal: $(cat "$R/out")"
grep -q 'old agent' "$R/prefix/agent.js" && ok "agent untouched" || bad "agent replaced anyway"
grep -q 'old panel' "$R/prefix/web/index.html" && ok "panel untouched" || bad "panel replaced anyway"
cp "$R/good.tgz" "$R/rel/download/v9.9.9/openmasjid-screen-v9.9.9.tar.gz"

echo
echo "-- a release that will not stay running rolls BOTH back"
reset; trust '' dev v9.9.8
touch "$R/STAYDOWN"
sh "$R/update.sh" > "$R/out" 2>&1 || bad "exited non-zero"
grep -q 'old agent' "$R/prefix/agent.js" && ok "agent rolled back" || bad "agent NOT rolled back"
grep -q 'old panel' "$R/prefix/web/index.html" && ok "panel rolled back" || bad "panel NOT rolled back"
grep -q "VERSION='v9.9.8'" "$R/prefix/trust.env" && ok "version not advanced" || bad "version advanced over a failed update: $(cat "$R/prefix/trust.env")"
rm -f "$R/STAYDOWN"

echo
echo "-- GitHub unreachable leaves the screen exactly as it was"
reset; trust '' dev v9.9.8
mv "$R/rel/releases" "$R/rel/releases.hidden"
sh "$R/update.sh" > "$R/out" 2>&1 || bad "exited non-zero"
grep -q 'old agent' "$R/prefix/agent.js" && ok "agent untouched" || bad "agent changed"
grep -qi 'keeping the version installed\|could not reach' "$R/out" && ok "said why" || bad "silent: $(cat "$R/out")"
mv "$R/rel/releases.hidden" "$R/rel/releases"

echo
echo "-- stable follows the latest release, not the newest pre-release"
reset; trust '' stable v9.9.8
sh "$R/update.sh" > "$R/out" 2>&1 || bad "exited non-zero"
grep -q 'old agent' "$R/prefix/agent.js" && ok "did not jump to the pre-release" || bad "installed a pre-release on the stable channel"

echo
echo "-- a release whose agent is byte-identical still installs its panel"
# A panel-only release. Without the new-tag override on the `cmp` short-circuit the updater
# stops here having changed nothing and recorded nothing — so it downloads this same bundle
# again every six hours, for ever, and the panel never arrives.
reset; trust '' dev v9.9.9
mkdir -p "$R/rel/download/v9.10.0"
rm -rf "$R/bundle2"; cp -r "$R/bundle" "$R/bundle2"
cp "$R/prefix/agent.js" "$R/bundle2/agent.js"
echo '<html>panel-only release</html>' > "$R/bundle2/web/index.html"
( cd "$R/bundle2" && tar czf "$R/rel/download/v9.10.0/openmasjid-screen-v9.10.0.tar.gz" . )
( cd "$R/rel/download/v9.10.0" && sha256sum openmasjid-screen-v9.10.0.tar.gz > SHA256SUMS )
sed -i.bak 's/v9\.9\.9/v9.10.0/' "$R/rel/releases"
sh "$R/update.sh" > "$R/out" 2>&1 || bad "exited non-zero"
grep -q 'panel-only release' "$R/prefix/web/index.html" && ok "panel installed" || bad "panel NOT installed"
grep -q "VERSION='v9.10.0'" "$R/prefix/trust.env" && ok "version recorded" || bad "version NOT recorded, so this would re-download for ever: $(cat "$R/prefix/trust.env")"
mv "$R/rel/releases.bak" "$R/rel/releases"

echo
echo "-- a device with neither a server nor a channel updates from nothing"
reset
printf "SERVER=''\nCURL_OPTS=''\n" > "$R/prefix/trust.env"
sh "$R/update.sh" > "$R/out" 2>&1 || bad "exited non-zero"
grep -q 'nothing to update from' "$R/out" && ok "refused cleanly" || bad "unexpected: $(cat "$R/out")"

echo
echo "-- a trust.env with no VERSION line still gets one"
# `sed -i s/^VERSION=//` matching nothing SUCCEEDS and says nothing, which would strand the
# screen re-downloading the same release for ever. The updater appends instead.
reset
printf "SERVER=''\nCURL_OPTS=''\nCHANNEL='dev'\n" > "$R/prefix/trust.env"
sh "$R/update.sh" > "$R/out" 2>&1 || bad "exited non-zero"
grep -q "VERSION='v9.9.9'" "$R/prefix/trust.env" && ok "version appended" || bad "no VERSION line written: $(cat "$R/prefix/trust.env")"

echo
echo "-- an adopted screen still updates from its server, and only from it"
reset
printf "SERVER='https://display.example'\nCURL_OPTS=''\n" > "$R/prefix/trust.env"
sh "$R/update.sh" > "$R/out" 2>&1 || true
grep -qi 'could not download the agent' "$R/out" && ok "went to the server, not to GitHub" || bad "unexpected: $(cat "$R/out")"
grep -q 'old agent' "$R/prefix/agent.js" && ok "agent untouched" || bad "agent changed"

echo
echo "-- an unsupported board is left alone rather than updated into a restart loop"
# A Pi 3 behind a television is a working screen showing correct prayer times. Ending support by
# sending it an agent built for a board it is not would crash it every five seconds and leave a
# masjid with a black screen nobody touched. It receives nothing instead.
reset; trust '' dev v9.9.8
for board in 'Raspberry Pi 3 Model B Plus Rev 1.3' 'Raspberry Pi 5 Model B Rev 1.0' ''; do
  echo "$board" > "$R/model"
  sh "$R/update.sh" > "$R/out" 2>&1 || bad "exited non-zero for '$board'"
  grep -q 'not supported' "$R/out" && grep -q 'old agent' "$R/prefix/agent.js" \
    && ok "refused: ${board:-no model at all}" || bad "updated an unsupported board: '$board'"
done
# The three boards that ARE supported, by the names they actually report. A `-eq 4` test refused
# two of these, and did until it was measured on real hardware.
for board in 'Raspberry Pi 4 Model B Rev 1.5' 'Raspberry Pi 400 Rev 1.0' 'Raspberry Pi Compute Module 4 Rev 1.1'; do
  reset; trust '' dev v9.9.8
  echo "$board" > "$R/model"
  sh "$R/update.sh" > "$R/out" 2>&1 || bad "exited non-zero for '$board'"
  grep -q 'new agent 9.9.9' "$R/prefix/agent.js" && ok "updated: $board" || bad "refused a supported board: '$board'"
done
echo 'Raspberry Pi 4 Model B Rev 1.5' > "$R/model"

echo
echo "-- no work directory is left behind"
ls -d "${TMPDIR:-/tmp}"/omd-update.* >/dev/null 2>&1 && bad "a work directory was left in the temp directory" || ok "cleaned up"

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
