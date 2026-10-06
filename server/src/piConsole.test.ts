// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The console on a Pi screen: one line, run by the agent, as the agent.
 *
 * Everything else the panel can ask a screen to do is a verb from a closed set, and the root side of
 * the device matches that verb with a filter (`head -c 32 | tr -dc 'a-z-'`) narrow enough that the
 * set cannot be widened by anything arriving over the network. That narrowness is the whole reason
 * root's half of this device is simple enough to be confident about.
 *
 * A console is the opposite shape — it exists precisely for the command nobody anticipated — so the
 * bound on it has to come from somewhere else, and it does: WHO runs it. The agent's own account,
 * inside the agent's own unit, with NoNewPrivileges, no write access to /opt, and no capability to
 * reboot the board. A console command can look at nearly anything on the screen and change nearly
 * nothing.
 *
 * ## And the terminal, which IS root
 *
 * The full terminal is a different feature and it is deliberately privileged: it opens a root shell,
 * because a screen three hundred miles away that cannot be rebooted or have a package installed on
 * it does not have a terminal, it has a viewer. So the spool does now start something as root at the
 * panel's request.
 *
 * The line that keeps the closed verb set worth anything is therefore not "nothing privileged comes
 * from the panel" — it is narrower and it is exact: **no verb carries a command string.** The
 * terminal's verb carries a session id, a one-time secret and a size. The console's payload IS a
 * command string, which is precisely why it must never become a verb; its bound is the account it
 * runs as.
 *
 * Both halves of that are asserted below, because the tempting simplification — "the spool already
 * starts a root shell, put the console there too" — would collapse the distinction and take every
 * other verb's narrowness with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  normShellCommand,
  SHELL_MAX_CMD,
  SHELL_MAX_OUT,
  PI_COMMANDS,
  updateDeviceFacts,
  setDeviceJournal,
  stripAnsi,
} from './piAgent';
import type { DB, PiDevice } from './types';

const agentSrc = () => fs.readFileSync(path.resolve(__dirname, 'pi', 'index.ts'), 'utf8');
const installerSrc = () => fs.readFileSync(path.resolve(__dirname, '..', 'assets', 'pi', 'install.sh'), 'utf8');

// ── where this feature is not ────────────────────────────────────────────────

test('a console command is never a root verb', () => {
  assert.ok((PI_COMMANDS as readonly string[]).includes('shell'), 'the panel has to be able to ask for it');

  // The agent's own list of things it hands to root.
  const src = agentSrc();
  const union = /type PrivilegedVerb =([\s\S]*?);/.exec(src);
  assert.ok(union, 'could not find the PrivilegedVerb union in the agent');

  // The EXACT verb, not a substring of one. The invariant here is narrower than it first looks and
  // the distinction is the whole of it: what must never be a root verb is a verb that carries a
  // COMMAND STRING — because the spool's filter (`head -c 32 | tr -dc 'a-z-'`) is what makes root's
  // side of this device a closed set, and one verb meaning "run this" would end that property for
  // every other verb at once.
  //
  // `shell-session` IS a root verb, and deliberately: it opens a root terminal. It carries a session
  // id, a one-time secret and a size, and no command text at any point — so the spool still names
  // verbs rather than executing strings. A substring check could not tell those two apart, and read
  // as this invariant being broken when it is not.
  const verbs = [...union[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(verbs.length > 0, 'could not read the verbs out of the union');
  assert.ok(!verbs.includes('shell'), 'a console command must not be something the agent asks root for');

  // And the dispatcher on the device. piInstaller.test.ts asserts the exact verb list; this says
  // WHY 'shell' must never join it, in the file somebody adding it would be reading.
  assert.ok(!/^\s{4}shell\)/m.test(installerSrc()), 'the root dispatcher must have no branch for a console command');
});

test('the root terminal carries a session, never a command', () => {
  // The line that keeps the closed verb set meaningful now that one verb opens a root shell. If a
  // command string ever reaches this arm, the spool has become "run this as root" and every other
  // verb's narrowness stops buying anything.
  const arm = installerSrc();
  const start = arm.indexOf('    shell-session)');
  assert.ok(start >= 0, 'the dispatcher must have a shell-session arm');
  const branch = arm.slice(start, arm.indexOf(';;', start));
  // It reads exactly four fields, and every one of them is checked to be a token or a number.
  for (const field of ['_sid', '_ssec', '_srow', '_scol']) {
    assert.ok(branch.includes(field), `the arm must read ${field}`);
  }
  assert.match(branch, /tr -dc 'A-Za-z0-9_-'/, 'the id and secret have to be plain tokens');
  assert.match(branch, /tr -dc '0-9'/, 'and the size has to be digits');
  // Nothing from the request may reach a command line. The only thing passed to node is the PATH of
  // the request file, which root owns by then.
  assert.ok(
    !/\$_sid|\$_ssec/.test(branch.slice(branch.indexOf('systemd-run'))),
    'no field from the request may be interpolated into the command that starts the terminal',
  );
  // The agent's INODE never crosses the boundary — only four validated strings do.
  //
  // This assertion used to say the opposite: it required `mv -f "$_req" "$_run"` and called that
  // moving the payload "out of the agent's reach". That was the bug, and pinning it made the bug
  // look deliberate. rename(2) does not dereference the SOURCE any more than the destination, so a
  // symlink planted at $STATEDIR/shell-request became $PREFIX/shell-request — and the `chown`/
  // `chmod 600` that followed DID dereference it. `chmod 600` through a link to /usr/bin/sudo
  // strips a setuid bit permanently; through /etc/resolv.conf it leaves a screen that can never
  // find its display server again. Reached from the unprivileged agent, which is precisely what
  // the spool exists to contain.
  assert.ok(!branch.includes('mv -f "$_req"'), 'the agent-supplied file must never be renamed into $PREFIX');
  assert.ok(!/chown.*"\$_run"/.test(branch), 'and never chowned');
  assert.ok(!/chmod.*"\$_run"/.test(branch), 'and never chmoded');
  assert.match(branch, /if \[ -L "\$_req" \]/, 'a symlink request is refused outright, not followed');
  const rmAt = branch.indexOf('rm -f "$_req"', branch.indexOf('_sid=$('));
  assert.ok(rmAt > 0, "the agent's file is deleted once its fields have been read");
  assert.ok(rmAt < branch.indexOf('_ok=1'), 'and deleted before the fields are validated, not after');

  // The ROOT pty's destination comes from trust.env, which the agent cannot write — never from
  // config.json, which it can. Without a trusted address nothing starts.
  assert.match(branch, /elif \[ -z "\$SERVER" \]/, 'no trusted server address means no session');
  // Asserted in pieces rather than as one long format string, which would break on any harmless
  // reformatting: what matters is that root creates the file itself, behind a umask, with SERVER
  // as a field, and that all five fields go in.
  assert.match(branch, /\(umask 077; printf /, 'root creates the file behind a umask, not a chmod');
  assert.match(branch, /> "\$_run"\)/, 'and writes it under the root-owned prefix');
  for (const field of ['"$_sid"', '"$_ssec"', '"$_srow"', '"$_scol"', '"$SERVER"']) {
    assert.ok(branch.includes(field), `the written file must carry ${field}`);
  }
  assert.ok(branch.indexOf('umask 077') < branch.indexOf('systemd-run'), 'written before the unit starts');
});

test('the root terminal will not dial an address the agent chose', () => {
  // The critical half of the same escalation. config.json is the AGENT's file — the installer
  // chowns $CONFDIR to the service account and the unit grants ReadWritePaths, because the agent
  // rewrites it on adoption. So taking `server` from there handed a compromised unprivileged agent
  // a root pty on a socket of its choosing, through the one verb that grants root.
  const src = fs.readFileSync(path.join(__dirname, 'pi', 'index.ts'), 'utf8');
  const fn = src.slice(src.indexOf('async function runShellSessionOnly'));
  const body = fn.slice(0, fn.indexOf(String.fromCharCode(10) + '}'));
  assert.ok(body.includes('serverRaw'), 'the origin is a field of the spool file');
  assert.match(body, /SERVER_ORIGIN_RE\.test\(server\)/, 'and it is validated as an origin');
  assert.ok(
    !/cfg\??\.server/.test(body),
    'runShellSessionOnly must never read cfg.server — that is the agent-writable value',
  );
  assert.match(body, /runShellSession\(\{ \.\.\.cfg, server \}/, 'the trusted origin overrides the config');
  // The installer must actually supply it, or the agent's check would reject every session.
  const arm = installerSrc();
  const branch = arm.slice(arm.indexOf('    shell-session)'));
  assert.ok(branch.slice(0, branch.indexOf(';;')).includes('"$SERVER"'), 'the installer passes SERVER across');
});

test('the agent runs a console command itself, in its own sandbox', () => {
  const src = agentSrc();
  const branch = /if \(cmd\.action === 'shell'\) \{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(branch, "could not find the 'shell' branch of runCommand");
  assert.ok(branch[1].includes('runShell('), 'it has to actually run the command');
  assert.ok(!branch[1].includes('requestPrivileged'), 'the console must not travel through the root spool');

  // spawn with an argument list, and the shell named explicitly — not `shell: true`, which would
  // make the command line depend on which shell the platform picked.
  assert.match(src, /spawn\('\/bin\/sh', \['-c', cmd\]/, 'the shell has to be named, and the command passed as an argument');
  assert.ok(!/shell:\s*true/.test(src), 'nothing here may use spawn({ shell: true })');
  // A command that waits for input would otherwise wait until the timeout with nobody able to answer.
  assert.match(src, /stdio: \['ignore', 'pipe', 'pipe'\]/, 'stdin must be closed');
  assert.match(src, /SHELL_TIMEOUT_MS = 20_000/, 'a console command has to be killed eventually');
});

test('the command is not written to the log the screen uploads', () => {
  // The first thing anybody types into a console on a screen that cannot reach its Wi-Fi is an
  // nmcli line with the masjid's passphrase in it. The journal is uploaded, stored, and rendered in
  // a page; the answer goes back to the person who typed it and no further.
  const branch = /if \(cmd\.action === 'shell'\) \{([\s\S]*?)\n  \}/.exec(agentSrc());
  assert.ok(branch);
  const logged = [...branch[1].matchAll(/\blog\(([^\n]*)\)/g)].map((m) => m[1]);
  assert.ok(logged.length > 0, 'it should say that it ran something');
  for (const line of logged) {
    assert.ok(
      !/cmd\.shell(?!\.length)/.test(line),
      `the command text itself must not be logged: log(${line})`,
    );
  }
});

// ── what may be asked ────────────────────────────────────────────────────────

test('a command has to be one bounded line', () => {
  assert.deepEqual(normShellCommand('free -m'), { cmd: 'free -m' });
  assert.deepEqual(normShellCommand('  ip a  '), { cmd: 'ip a' }, 'trimmed, so a stray space is not an error');

  // A pipe, a redirect and a quote are all the point of having a shell, not things to refuse.
  assert.deepEqual(normShellCommand("ps aux | grep ffmpeg | head -3"), { cmd: 'ps aux | grep ffmpeg | head -3' });

  for (const bad of ['', '   ', undefined, null, 42, {}]) {
    assert.ok('error' in normShellCommand(bad), `${JSON.stringify(bad)} should be refused`);
  }
  // A line break would be two commands by the time anything ran it, and the second one would not be
  // the one the panel showed.
  assert.ok('error' in normShellCommand('date\nrm -rf /'), 'a newline must be refused');
  assert.ok('error' in normShellCommand('date\rls'), 'a carriage return must be refused');
  assert.ok('error' in normShellCommand(`echo ${'x'.repeat(SHELL_MAX_CMD)}`), 'an over-long line must be refused');
});

// ── what comes back ──────────────────────────────────────────────────────────

function dbWithDevice(): { db: DB; device: PiDevice } {
  const device = {
    id: 'pi_test',
    code: 'ABC123',
    token: 'tok',
    hostname: 'raspberry',
    ip: '10.0.0.9',
    model: 'Raspberry Pi 4 Model B',
    agentVersion: '0.70.0',
    lastSeenAt: new Date(0).toISOString(),
  } as PiDevice;
  return { db: { piDevices: [device] } as unknown as DB, device };
}

test('the answer is bounded and stripped, but keeps its lines', () => {
  const { db, device } = dbWithDevice();
  updateDeviceFacts(db, 'pi_test', {
    shellResult: { id: 'c_1', cmd: 'free -m', out: 'total used\n  1900  420\ttabbed', code: 0, ms: 41 },
  }, 1_000);
  // Newlines and tabs survive: output without them is a wall of text, not output.
  assert.equal(device.shellResult?.out, 'total used\n  1900  420\ttabbed');
  assert.equal(device.shellResult?.code, 0);
  assert.equal(device.shellResult?.ms, 41);
  assert.equal(device.shellResult?.at, new Date(1_000).toISOString());
});

test('a device cannot fill the store with one command', () => {
  const { db, device } = dbWithDevice();
  updateDeviceFacts(db, 'pi_test', {
    shellResult: { id: 'x'.repeat(200), cmd: 'y'.repeat(2000), out: 'z'.repeat(SHELL_MAX_OUT * 4), code: 0, ms: 1 },
  }, 1_000);
  assert.equal(device.shellResult?.out.length, SHELL_MAX_OUT);
  assert.equal(device.shellResult?.cmd.length, SHELL_MAX_CMD);
  assert.ok((device.shellResult?.id.length ?? 0) <= 40);
});

test('a nonsense exit code is null, not a number the panel would render', () => {
  const { db, device } = dbWithDevice();
  for (const code of [undefined, null, 'boom', NaN, 1.5]) {
    updateDeviceFacts(db, 'pi_test', { shellResult: { id: 'c_2', cmd: 'x', out: 'o', code, ms: -5 } }, 1_000);
    assert.equal(device.shellResult?.code, null, `code ${String(code)} should become null`);
    assert.equal(device.shellResult?.ms, 0, 'a negative duration is not a duration');
  }
  updateDeviceFacts(db, 'pi_test', { shellResult: { id: 'c_3', cmd: 'x', out: 'o', code: 127, ms: 3 } }, 1_000);
  assert.equal(device.shellResult?.code, 127, 'a real exit code is kept — 127 is "no such command"');
});

test('an answer that is not an object leaves the last one alone', () => {
  const { db, device } = dbWithDevice();
  updateDeviceFacts(db, 'pi_test', { shellResult: { id: 'c_4', cmd: 'a', out: 'kept', code: 0, ms: 1 } }, 1_000);
  for (const junk of ['a string', 42, [], null]) {
    updateDeviceFacts(db, 'pi_test', { shellResult: junk }, 2_000);
    assert.equal(device.shellResult?.out, 'kept');
  }
});

// ── colour, which the journal and the console answer get wrong together or not at all ────────

const ESC = String.fromCharCode(27);

/**
 * The installer deliberately colours its nine steps, so a real journal is full of `ESC[36m`.
 *
 * Two functions handle that between them, and for a while their ORDER made both useless: dropping
 * control characters first removed the ESC byte and left "[36m" behind as ordinary text, after which
 * `stripAnsi` on the way out could not match it — the escape it looks for had already been eaten.
 * The panel showed "[36mStep 1[0m", which is worse than showing it in colour, and neither function
 * looked wrong on its own. `setDeviceJournal` had no test at all, which is why.
 */
test('a coloured log arrives readable, not as literal escape text', () => {
  const { db, device } = dbWithDevice();
  setDeviceJournal(db, 'pi_test', `${ESC}[36mStep 1${ESC}[0m done\n${ESC}[1;31mfailed${ESC}[0m\n`, 1_000);
  assert.equal(device.journal, 'Step 1 done\nfailed\n');
  assert.ok(!device.journal?.includes('['), 'no half-eaten sequence may survive');
});

test('the console answer is cleaned by the same code, so the two cannot disagree', () => {
  const { db, device } = dbWithDevice();
  updateDeviceFacts(db, 'pi_test', {
    shellResult: { id: 'c_9', cmd: 'ls --color=always', out: `${ESC}[01;34mcache${ESC}[0m\njournal.txt\n`, code: 0, ms: 2 },
  }, 1_000);
  assert.equal(device.shellResult?.out, 'cache\njournal.txt\n');
});

test('a cursor-hiding sequence goes too', () => {
  // Anything that draws progress emits these, and one that slipped through would leave "[?25l" in
  // the page — the same litter, from a sequence the first version of the pattern could not match.
  assert.equal(stripAnsi(`${ESC}[?25lworking${ESC}[?25h`), 'working');
});

test('a journal is kept from the END, because that is where the fault is', () => {
  const { db, device } = dbWithDevice();
  setDeviceJournal(db, 'pi_test', 'old '.repeat(80_000) + 'THE INTERESTING PART', 1_000);
  assert.ok((device.journal?.length ?? 0) <= 200_000);
  assert.ok(device.journal?.endsWith('THE INTERESTING PART'), 'truncating from the front discards the answer');
});

test('the root terminal inherits the screen\'s TLS trust, and the RIGHT variable', () => {
  // A masjid whose display server has a self-signed certificate has exactly one setting for this and
  // it lives in the agent's unit. The terminal runs in a transient unit, which inherits nothing, so
  // it has to be passed across — and the pattern that does it has to name the variable.
  //
  // Measured on a real Pi 4: the unit carries TWO `Environment=NODE_` lines, and a pattern matching
  // `NODE_[A-Z_]*` returned `NODE_ENV=production` while `head -1` discarded
  // `NODE_TLS_REJECT_UNAUTHORIZED=0`. The terminal would have failed to connect on exactly the
  // installs that need the setting, saying nothing about why.
  const src = installerSrc();
  const start = src.indexOf('    shell-session)');
  const branch = src.slice(start, src.indexOf(';;', start));
  assert.ok(/NODE_EXTRA_CA_CERTS/.test(branch), 'the pinned-CA case has to be carried across');
  assert.ok(/NODE_TLS_REJECT_UNAUTHORIZED/.test(branch), 'and the unverified case');
  assert.ok(
    !/NODE_\[A-Z_\]\*/.test(branch),
    'a loose NODE_* pattern matches NODE_ENV before it matches the setting that matters',
  );
  assert.ok(/--setenv=/.test(branch), 'and it must actually reach the transient unit');
});
