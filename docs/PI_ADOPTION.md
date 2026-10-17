<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Adopting a Raspberry Pi screen

How a Pi comes to belong to a display server — all three ways, what each one proves, and the one
thing two of them cannot give you.

Written for whoever maintains this. For the admin-facing version, see
[PI_STANDALONE.md](PI_STANDALONE.md) and the panel itself.

---

## The three ways in

| | who speaks first | what it proves | ends up adopted? |
| --- | --- | --- | --- |
| **Installer** | the Pi | somebody ran a command on the Pi, then read a code off the television | after a code is typed |
| **By address** | the server | the admin holds the Pi's own panel password | immediately |
| **From the Pi** | the Pi | the admin holds the Pi's password **and** the server's dashboard | after a code is typed |

All three end in the same place: a `PiDevice` row with a token, a `Tv` row it drives, and an
agent holding `{server, deviceId, deviceSecret, token}` in `/etc/openmasjid-screen/config.json`.

### 1. The installer — `curl … /pi.sh | sudo sh`

The original, and still the only one that configures the whole machine. The server bakes its own
address into the script it serves, so the Pi knows where to enrol; it mints its own identity,
enrols, and shows a pairing code on the television. An admin types that code into **Screens → Add
screen → Raspberry Pi**.

The code is the proof, and it is a good one: whoever types it can see that television, which is
the closest thing to physical presence this product can ask for.

### 2. By address — the server adopts a Pi that is already running

`POST /api/pi/link` on the **server**, `{address, password, name}`. For a screen that is already
set up standalone on the masjid's network: no keyboard, nothing to read off the television.

The order of the steps is the security of it, and `api.ts` says so at the route:

1. **The address must resolve onto a private network.** Not a courtesy — this route makes the
   server open a connection to wherever it is told and post a credential there. See
   `piLink.ts`: the check is on *resolved addresses*, never on the spelling of the name, because
   `pi/lanHost.ts` is explicitly a heuristic about names and says so itself.
2. **Sign in to the Pi's own panel with the password given.** This proves two things at once and
   both are needed: that whoever is asking administers that screen, and that the thing at that
   address is one of our panels at all. Nothing of ours is sent until it has succeeded.
3. **Create the device and the screen, then hand the credentials over.** If the handover fails,
   `removeAdoptedDevice` deletes both again — otherwise a mistyped address that happened to answer
   leaves a live token in the masjid's data for a screen that will never appear.

The identity is minted by the **server** here, not by the Pi. The obvious alternative —
pre-approve a device id and adopt it when it enrols — hands the adoption to whichever device
enrols with that id first, and a device id is a lookup key anything on the network may claim.

**Private-only is not a restriction.** A server adopting a Pi must open a connection *to* the Pi,
which only works when they are on the same LAN; a display server in the cloud cannot reach a Pi
behind NAT at all. So there is no deployment this refuses that would otherwise have worked — and
it removes the whole class of "make the server fetch this URL for me". When the server is not in
the building, the direction has to reverse, which is (3).

### 3. From the Pi — pointing a standalone screen at a server

`POST /api/pi/link` on the **Pi's own panel**, `{server}`. A field in **Settings → Display
server** on the screen itself. This is the half that works when the server cannot reach the Pi —
a Cloudflare tunnel has a public address the Pi can dial out to, and the Pi has none the server
could dial in to.

It does **not** finish the job, and that is deliberate. Giving an address makes the screen enrol
and show a pairing code; somebody approves it in that server's dashboard. Whoever holds the Pi's
password has proved they administer *that screen* and nothing more — it says nothing about whether
they may add a screen to that masjid's dashboard. The server's admin decides that.

The code appears **in the Pi's own panel as well as on the television**, so nobody has to cross
the hall, and the panel stays signed-in and writable throughout — a mistyped address is corrected
in the same box rather than with a keyboard plugged into the Pi.

#### One route, two callers

(2) and (3) are the same handler on the Pi: `POST /api/pi/link` in `pi/panel.ts`, behind the same
session. Both are the same act — "this screen now belongs to that server" — and both present the
same credential, the screen's admin password. What differs is only how much arrives: an address
alone, or an address plus credentials from a server that has already made the decision.

---

## What the panel cannot give you, and why

**A screen adopted by (2) or (3) has no root-trusted server address, so Update and Terminal do not
work on it.** The panel says so, and names the one command that fixes it.

This is not an oversight to be tidied up later. Two things on a Pi are done by root rather than by
the agent:

- **`reinstall`** (the dashboard's Update button) — root fetches `$SERVER/pi.sh` and runs it;
- **the root terminal** — root dials out to `$SERVER` with a pty on the other end.

Both take `SERVER` from `/opt/openmasjid-screen/trust.env`: root-owned, written only by the
installer, and the one file the agent cannot write. *That is the only reason either is safe to
offer from a dashboard.* A verb that let the agent set that address would turn "root runs a script
from the address root recorded" into "root runs a script from an address this process chose",
which hands a compromised agent the whole machine — and the root terminal with it.

So panel adoption writes `config.json` and nothing else. The agent's config is agent-writable by
design, which is exactly why nothing privileged reads it — `update.sh` carried a fallback to it
for devices older than trust.env, and 0.71.0 deleted that fallback to make the rule checkable
(`update.test.sh`, *root never follows an address the AGENT wrote*).

What a masjid gets instead:

- The screen still **updates itself** from GitHub releases on its own timer, because a standalone
  install writes `CHANNEL` into trust.env and the updater follows that.
- The one-shot console still works; it runs unprivileged and always has.
- Running the server's installer once on the screen turns both buttons on, with nothing lost:
  `curl -fsSL <server>/pi.sh | sudo sh`.

`rootHasTrustedServer()` in `pi/control.ts` is what reports this. It is read fresh on every
check-in — re-running the installer should take the warning away without a restart — and it must
test the *contents* of the `SERVER` line, not its presence: the installer writes `SERVER=''` for a
standalone screen, so a presence test would report every standalone Pi in the world as linked.

---

## Leaving

- **Forget, from the server's dashboard.** Drops the token. Where the screen goes next depends on
  two facts, both checked in `main()`: a screen the installer built goes back to showing a pairing
  code for its server, as it always has; a screen that was linked from its own panel **and has a
  local account** goes back to standalone, with its own timetables, password and panel exactly as
  it left them. The second case matters — `waitForAdoption` serves no panel at all, so leaving a
  panel-linked screen there would make a keyboard the only way back.
- **Cancel, from the Pi's panel.** While a screen is enrolling, *Cancel and stay standalone*
  clears the address. This is the way back from a typo.
- **An adopted screen's panel is read-only** (`pi/managedPanel.ts`) and that is asserted by a test
  that reads the file, so there is no *Leave* button there. Un-adopting an adopted screen is done
  from the server that owns it.

Nothing is deleted in either direction. The store lives in `$DATA_DIR` and no path in either flow
touches it, which is why "its old timetables and password are still here" is a safe thing for the
panel to say.
