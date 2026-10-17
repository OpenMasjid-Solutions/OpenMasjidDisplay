// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The states a screen's own panel moves through while it joins a display server.
 *
 * This page is the whole of one half of adoption, and every bug found in it so far has been a
 * STATE bug rather than a logic one — the right words shown at the wrong moment. The worst of them
 * went on saying "enter this code in the dashboard" for the five or six seconds after the code had
 * been accepted, which reads as a failure to whoever has just typed it, and offered a Cancel button
 * that in exactly that window would strand the display server holding a row for a device that
 * would never call.
 *
 * So the states are what is tested, and they are tested by rendering them.
 *
 * ## Why this needs no browser and no test framework
 *
 * `ServerLinkView` is a pure function of its props — that split is why it exists — so
 * `renderToStaticMarkup` turns any state into a string with no network, no DOM, no providers and
 * no component-testing library. The repository gains a web test runner for the cost of `tsx`,
 * which it already used on the server side.
 *
 * What that cannot cover is anything only a real browser decides: focus, layout, whether a click
 * reaches a disabled button. It covers what is RENDERED, which is where these bugs have been.
 *
 * React prints one warning per run about `useLayoutEffect` doing nothing on the server. It comes
 * from the tooltip inside `Field` and is expected: that effect only positions a tooltip, and the
 * markup these tests read is correct without it. It is left to print rather than silenced, because
 * silencing it means silencing `console.error`, which is where a real problem would appear.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ServerLinkView, type LinkState } from './ServerLink';

/**
 * The view in one state, as the markup an admin would be looking at.
 *
 * `createElement` rather than JSX, and that is the only reason this file is `.ts`. Test files are
 * excluded from `tsconfig.json` — the build typechecks the APP with that config, and the app is a
 * browser bundle that must not see node's types — but tsx reads the same file to decide which JSX
 * transform to use, so an excluded `.tsx` silently fell back to the classic one and every test
 * died on "React is not defined". One `createElement` call removes the question instead of
 * answering it, and nothing below here renders anything anyway: the assertions are about a string.
 */
function render(st: LinkState | null, address = '', busy = false): string {
  return renderToStaticMarkup(
    createElement(ServerLinkView, { st, address, busy, onAddress: () => {}, onSave: () => {} }),
  );
}

const STANDALONE: LinkState = { server: '', adopted: false, code: '', connected: false, status: '' };
const ENROLLING: LinkState = {
  server: 'http://192.168.1.18:7860',
  adopted: false,
  code: 'K7M2QX',
  connected: true,
  status: 'Waiting for this code to be entered in the dashboard',
};
const UNREACHABLE: LinkState = {
  server: 'http://192.168.1.18:7860',
  adopted: false,
  code: '',
  connected: false,
  status: 'Cannot reach the display server at http://192.168.1.18:7860',
};
const HANDING_OVER: LinkState = { ...ENROLLING, adopted: true };

test('before the first poll it says it is checking, and offers nothing', () => {
  const html = render(null);
  assert.match(html, /Checking/);
  assert.doesNotMatch(html, /<input/, 'nothing to type into until we know the state');
  assert.doesNotMatch(html, /<button/, 'and nothing to press');
});

test('a standalone screen is offered the box and nothing else', () => {
  const html = render(STANDALONE);
  assert.match(html, /<input/, 'the address box');
  assert.match(html, /Connect to this server/);
  assert.doesNotMatch(html, /K7M2QX|enter this code/i, 'there is no code to show yet');
  assert.doesNotMatch(html, /Cancel/, 'nothing has been started, so there is nothing to cancel');
});

test('the Connect button is dead until something is typed', () => {
  // Pressing it with an empty box would ask the screen to join "", which is how it is set free —
  // the opposite of what the button says.
  assert.match(render(STANDALONE, '').split('<button')[1] ?? '', /disabled/);
  assert.doesNotMatch(render(STANDALONE, 'http://192.168.1.18:7860').split('<button')[1] ?? '', /disabled/);
});

test('while enrolling it shows the code, where to type it, and that it is in contact', () => {
  const html = render(ENROLLING);
  assert.match(html, /K7M2QX/, 'the code is the whole content of this state');
  assert.match(html, /Screens/, 'and where to type it');
  assert.match(html, /192\.168\.1\.18:7860/, 'and which server it is joining');
  assert.match(html, /Cancel and stay standalone/, 'the way back from a typo');
});

test('a server it cannot reach says so, and still offers the way back', () => {
  // This is the mistyped-address state, and the Cancel button is the only thing that gets an
  // admin out of it without a keyboard plugged into the Pi.
  const html = render(UNREACHABLE);
  assert.match(html, /Cannot reach the display server/);
  assert.match(html, /Cancel and stay standalone/);
  assert.match(html, /color:var\(--color-warning\)|color:var\(--color-warning\);/, 'and it is coloured as a warning');
});

test('once the code is accepted it stops asking for the code', () => {
  // The bug this test exists for: the code is SPENT the moment the server accepts it, but the
  // agent goes on reporting it until it restarts to hand over. Said again here, it reads as a
  // failure at the exact moment the thing worked.
  const html = render(HANDING_OVER);
  assert.doesNotMatch(html, /K7M2QX/, 'a spent code must not still be on the page');
  assert.doesNotMatch(html, /enter this code/i);
  assert.match(html, /Accepted/, 'it says what actually happened');
});

test('and it stops offering Cancel, because that would strand the server', () => {
  // Pressing Cancel in the handover window writes an empty server and drops the token the screen
  // has just been given: the screen stays standalone while the display server keeps an adopted
  // row for a device that will never call. The route refuses it too — this is the other half.
  const html = render(HANDING_OVER);
  assert.doesNotMatch(html, /Cancel/, 'there must be no way to press it');
  assert.doesNotMatch(html, /<input/, 'and nothing to re-point it with');
});

test('every state says which server, so nobody has to guess', () => {
  for (const st of [ENROLLING, UNREACHABLE, HANDING_OVER]) {
    assert.match(render(st), /192\.168\.1\.18:7860/, JSON.stringify(st));
  }
});

test('a busy save does not leave a button that can be pressed again', () => {
  for (const [st, address] of [
    [STANDALONE, 'http://192.168.1.18:7860'],
    [ENROLLING, ''],
  ] as const) {
    const html = render(st, address, true);
    const buttons = html.split('<button').slice(1);
    assert.ok(buttons.length > 0, 'this state should have a button');
    for (const b of buttons) assert.match(b, /disabled/, `a button stayed live while busy: ${JSON.stringify(st)}`);
  }
});

test('nothing in any state leaks a credential', () => {
  // The status payload carries no token or secret — pinned on the server side too — but this page
  // renders whatever it is handed, so it is worth asserting that it renders only what it should.
  const sneaky = { ...ENROLLING, status: 'Waiting', code: 'K7M2QX' } as LinkState & { token?: string };
  sneaky.token = 'tok-should-never-render';
  assert.doesNotMatch(render(sneaky), /tok-should-never-render/);
});
