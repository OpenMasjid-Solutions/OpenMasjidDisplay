// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The container around the display-server page: what it fetches, and what it does with the answer.
 *
 * Its sibling test renders the VIEW and asserts the words. This one is about the behaviour the
 * view cannot have, because it has no state of its own:
 *
 *   • it polls, so a code that arrives seconds later appears without a refresh;
 *   • a save that worked must not be reported as failed because the refresh after it did not;
 *   • a result that arrives after the component is gone must not be applied.
 *
 * The last two are the ones worth the machinery. "The save worked but the refresh failed" was
 * written as a deliberate `.catch(() => {})` and nothing proved it stayed that way, and a late
 * result applied after unmount is a React warning in a browser console that nobody is reading.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { mount } from '../../testing/dom';
import { ServerLinkSection } from './ServerLink';
import { api } from '../api';
import { ToastProvider } from '../ui';

type Status = { server: string; adopted: boolean; code: string; connected: boolean; status: string };

const STANDALONE: Status = { server: '', adopted: false, code: '', connected: false, status: '' };
const ENROLLING: Status = {
  server: 'http://192.168.1.18:7860',
  adopted: false,
  code: 'K7M2QX',
  connected: true,
  status: 'Waiting for this code to be entered in the dashboard',
};

/**
 * Swap the two API calls this page makes, and record what it asked for.
 *
 * The real `api` object is reached through the module, so the methods are replaced on it and put
 * back afterwards. Nothing here goes near `fetch`: what is under test is the component's handling
 * of an answer, not the transport that brought it.
 */
function stubApi(opts: { status: () => Promise<Status>; join?: (server: string) => Promise<unknown> }) {
  const real = { piLinkStatus: api.piLinkStatus, piJoinServer: api.piJoinServer };
  const joined: string[] = [];
  let statusCalls = 0;
  api.piLinkStatus = (() => {
    statusCalls += 1;
    return opts.status();
  }) as typeof api.piLinkStatus;
  api.piJoinServer = ((server: string) => {
    joined.push(server);
    return (opts.join ?? (() => Promise.resolve({ ok: true, server, adopted: false })))(server);
  }) as typeof api.piJoinServer;
  return {
    joined,
    statusCalls: () => statusCalls,
    restore: () => Object.assign(api, real),
  };
}

/** The section inside the toast provider it reads out of context. */
const page = () => createElement(ToastProvider, null, createElement(ServerLinkSection));

test('it asks the screen what it is doing, and shows the answer', async () => {
  const stub = stubApi({ status: () => Promise.resolve(ENROLLING) });
  try {
    const ui = await mount(page());
    await ui.settle();
    assert.match(ui.html(), /K7M2QX/, 'the code the first poll returned');
    assert.ok(stub.statusCalls() >= 1);
    await ui.unmount();
  } finally {
    stub.restore();
  }
});

test('typing an address and pressing Connect sends exactly that address', async () => {
  // The container's whole job on this path: take what is in the box, hand it to the API, and clear
  // it. Trimmed, because an address pasted out of an address bar often brings a space with it.
  const stub = stubApi({ status: () => Promise.resolve(STANDALONE) });
  try {
    const ui = await mount(page());
    await ui.settle();
    await ui.type('  http://192.168.1.18:7860  ');
    await ui.click('Connect to this server');
    assert.deepEqual(stub.joined, ['http://192.168.1.18:7860']);
    await ui.unmount();
  } finally {
    stub.restore();
  }
});

test('Cancel sends an empty address, which is how a screen is set free', async () => {
  const stub = stubApi({ status: () => Promise.resolve(ENROLLING) });
  try {
    const ui = await mount(page());
    await ui.settle();
    await ui.click('Cancel and stay standalone');
    assert.deepEqual(stub.joined, ['']);
    await ui.unmount();
  } finally {
    stub.restore();
  }
});

test('a save that worked is not reported as failed because the refresh after it did not', async () => {
  // The refresh exists only so the page turns over without waiting for the next poll. It is
  // deliberately allowed to fail — the save has already happened — and this is what holds that
  // `.catch` in place. Without it an admin is told their screen did not join, when it did.
  let first = true;
  const stub = stubApi({
    status: () => {
      if (first) {
        first = false;
        return Promise.resolve(STANDALONE);
      }
      return Promise.reject(new Error('refresh blew up'));
    },
  });
  try {
    const ui = await mount(page());
    await ui.settle();
    await ui.type('http://192.168.1.18:7860');
    await ui.click('Connect to this server');
    await ui.settle();

    const html = ui.html();
    assert.deepEqual(stub.joined, ['http://192.168.1.18:7860'], 'the save itself went out');
    // On the TOAST, not on a message. The first version of this asserted that the words "Could
    // not save that address" were absent — and they are absent either way, because a rejected
    // refresh reaches the same catch and toasts ITS message instead. The test passed with the
    // `.catch` removed, which is the one thing it existed to notice.
    assert.doesNotMatch(html, /toast--error/, `an error toast was shown: ${html}`);
    assert.match(html, /toast--success/, 'and the admin is told it worked');
    await ui.unmount();
  } finally {
    stub.restore();
  }
});

test('a save that genuinely failed IS reported', async () => {
  // The other half: the catch above must not have swallowed real failures with it.
  const stub = stubApi({
    status: () => Promise.resolve(STANDALONE),
    join: () => Promise.reject(new Error('That is not a web address.')),
  });
  try {
    const ui = await mount(page());
    await ui.settle();
    await ui.type('nonsense');
    await ui.click('Connect to this server');
    await ui.settle();
    assert.match(ui.html(), /That is not a web address/);
    assert.match(ui.html(), /toast--error/, 'and shown as a failure, not a success');
    await ui.unmount();
  } finally {
    stub.restore();
  }
});

test('unmounting stops the polling', async () => {
  // The cleanup in the effect. This page asks the screen how it is getting on every three
  // seconds, so an interval left running is not a tidy-up detail — it is a request every three
  // seconds, for ever, against a component nobody is looking at.
  //
  // Written as "no further calls after it is gone" rather than as anything about the `live` flag
  // beside it: React 18 makes a setState after unmount a silent no-op, so that flag is hygiene
  // with nothing observable behind it, and a test claiming to check it would be checking nothing.
  // The interval is the half that leaks, and this is what notices.
  const stub = stubApi({ status: () => Promise.resolve(STANDALONE) });
  try {
    const ui = await mount(page());
    await ui.settle();
    await ui.unmount();
    const atUnmount = stub.statusCalls();

    await new Promise((r) => setTimeout(r, 3500)); // comfortably past the 3s poll
    assert.equal(stub.statusCalls(), atUnmount, 'it kept polling after the page was gone');
  } finally {
    stub.restore();
  }
});

test('it keeps polling, so a code that arrives later appears on its own', async () => {
  // Somebody is watching this page for exactly this: they set an address, and the code turns up a
  // few seconds later when the agent has enrolled.
  let answer: Status = STANDALONE;
  const stub = stubApi({ status: () => Promise.resolve(answer) });
  try {
    const ui = await mount(page());
    await ui.settle();
    assert.doesNotMatch(ui.html(), /K7M2QX/);

    answer = ENROLLING;
    // The component polls on an interval; jsdom's timers are real, so rather than wait three
    // seconds this drives the same path the interval does — a save, which refreshes.
    await ui.type('http://192.168.1.18:7860');
    await ui.click('Connect to this server');
    await ui.settle();
    assert.match(ui.html(), /K7M2QX/, 'the later answer reached the page');
    await ui.unmount();
  } finally {
    stub.restore();
  }
});
