// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * How often this app is willing to tell an admin that a screen is offline.
 *
 * This alert fires on an EXTERNAL failure — a decoder or a network, not a person doing
 * something — and that is the shape with no natural bound. A screen that is simply down is
 * reported once, because the notified flag latches; a decoder that FLAPS was reported every
 * ninety seconds, a down alert and a recovery alert each time, which is around 950 pairs a day
 * for one screen. Each one is an email and a webhook.
 *
 * Nothing outside this app limited it. The platform's alert route gates on whether the admin
 * wants that alert type at all, not on how often it arrives; and the per-recipient cooldown that
 * used to absorb this class of thing on the WhatsApp side was removed in OpenMasjidOS 0.51.1.
 *
 * The rule these tests pin: **the floor is on the down alert, never on the recovery.** A recovery
 * can only follow a down alert the admin already received, so suppressing it would leave them
 * believing a screen is dead — and it resets the floor, so the bound is two alerts per screen per
 * window with every "down" still getting its matching "back online".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from './orchestrator';
import type { Tv } from './types';

interface Alert {
  title?: string;
  text: string;
  level?: string;
}

/** The one screen these tests talk about. runAlerts reads only the id and the name. */
const TV = { id: 'tv_1', name: 'Main hall' } as unknown as Tv;

/**
 * A real Orchestrator — its constructor only assigns, so the store and the renderer are never
 * touched — driven through a fake clock.
 *
 * Built rather than Object.create'd so the intervals under test are the class's own: a harness
 * that supplied its own OFFLINE_MS would still pass if somebody set the real one to zero.
 */
function harness() {
  const sent: Alert[] = [];
  const o = new Orchestrator(null as never, null as never, () => {}, (p) => {
    sent.push(p as Alert);
  });
  const priv = o as unknown as {
    OFFLINE_MS: number;
    ALERT_MIN_GAP_MS: number;
    runAlerts(items: { tv: Tv; pulling: boolean; off: boolean; stale?: boolean; litUp?: boolean }[]): void;
  };
  const realNow = Date.now;
  let clock = Date.parse('2026-08-21T09:00:00Z');
  Date.now = () => clock;
  return {
    sent,
    offlineMs: priv.OFFLINE_MS,
    gapMs: priv.ALERT_MIN_GAP_MS,
    /** move the clock and run one reconcile */
    tick: (ms: number, state: { pulling: boolean; off?: boolean }) => {
      clock += ms;
      priv.runAlerts([{ tv: TV, pulling: state.pulling, off: !!state.off }]);
    },
    restore: () => {
      Date.now = realNow;
    },
  };
}

test('a screen that goes down is reported once, and staying down does not repeat it', () => {
  const h = harness();
  try {
    h.tick(0, { pulling: false });
    assert.equal(h.sent.length, 0, 'not until it has been down long enough to be real');
    h.tick(h.offlineMs + 1000, { pulling: false });
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0].title ?? '', /offline/i);
    for (let i = 0; i < 20; i++) h.tick(60_000, { pulling: false });
    assert.equal(h.sent.length, 1, 'a screen that is still down is not news every minute');
  } finally {
    h.restore();
  }
});

test('a recovery is always delivered, because the admin was told it was down', () => {
  const h = harness();
  try {
    h.tick(0, { pulling: false });
    h.tick(h.offlineMs + 1000, { pulling: false });
    h.tick(10_000, { pulling: true });
    assert.equal(h.sent.length, 2);
    assert.match(h.sent[1].title ?? '', /back online/i);
  } finally {
    h.restore();
  }
});

test('a recovery with no down alert behind it says nothing', () => {
  const h = harness();
  try {
    // Down, but not for long enough to be reported — so there is nothing to recover FROM, and
    // "back online" about a screen nobody was told about is noise.
    h.tick(0, { pulling: false });
    h.tick(h.offlineMs / 2, { pulling: true });
    assert.deepEqual(h.sent, []);
  } finally {
    h.restore();
  }
});

test('a flapping decoder cannot flood the admin — this is the bug', () => {
  const h = harness();
  try {
    // Four hours of a decoder dropping and coming back, which is what a failing power supply or
    // a saturated switch actually looks like. Before the floor this was a pair every 90 seconds.
    const cycles = Math.ceil((4 * 60 * 60_000) / (h.offlineMs + 2000));
    for (let i = 0; i < cycles; i++) {
      h.tick(h.offlineMs + 1000, { pulling: false });
      h.tick(1000, { pulling: true });
    }
    const hours = ((h.offlineMs + 2000) * cycles) / 3_600_000;
    // Two per window is the designed bound: one down, one recovery.
    const ceiling = 2 * Math.ceil((hours * 3_600_000) / h.gapMs) + 2;
    assert.ok(
      h.sent.length <= ceiling,
      `${h.sent.length} alerts in ${hours.toFixed(1)}h of flapping — the bound is ${ceiling}`,
    );
    // And it really is bounded, not merely small because the loop was short.
    assert.ok(h.sent.length < cycles / 4, `${h.sent.length} alerts for ${cycles} flaps is not a bound`);
  } finally {
    h.restore();
  }
});

test('a screen still down when the floor expires IS reported — delayed, never dropped', () => {
  const h = harness();
  try {
    h.tick(0, { pulling: false }); // the down clock starts on the first reconcile that sees it
    h.tick(h.offlineMs + 1000, { pulling: false }); // down alert
    h.tick(1000, { pulling: true }); // recovery, which resets the floor
    assert.equal(h.sent.length, 2);

    // Down again, and this time it stays down. The floor blocks the alert at first…
    h.tick(1000, { pulling: false });
    h.tick(h.offlineMs + 1000, { pulling: false });
    assert.equal(h.sent.length, 2, 'floored — the admin heard about this screen a moment ago');

    // …and then it is sent, because the screen really is down. A dropped alert here would be a
    // screen dark all through jummah with nobody told.
    h.tick(h.gapMs, { pulling: false });
    assert.equal(h.sent.length, 3);
    assert.match(h.sent[2].title ?? '', /offline/i);
  } finally {
    h.restore();
  }
});

test('a screen switched off on purpose is never called offline', () => {
  const h = harness();
  try {
    for (let i = 0; i < 30; i++) h.tick(60_000, { pulling: false, off: true });
    assert.deepEqual(h.sent, []);
  } finally {
    h.restore();
  }
});

test('turning a screen off and on again is not a way round the floor', () => {
  const h = harness();
  try {
    h.tick(0, { pulling: false });
    h.tick(h.offlineMs + 1000, { pulling: false });
    h.tick(1000, { pulling: true });
    assert.equal(h.sent.length, 2);
    // `off` clears the pending state, and deliberately does NOT clear the floor.
    h.tick(1000, { pulling: false, off: true });
    h.tick(1000, { pulling: false });
    h.tick(h.offlineMs + 1000, { pulling: false });
    assert.equal(h.sent.length, 2, 'the floor survives an off/on toggle');
  } finally {
    h.restore();
  }
});
