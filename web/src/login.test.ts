// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * From outside the masjid, the sign-in screen offers OpenMasjidOS and nothing else.
 *
 * Opened through the OpenMasjidOS tunnel the server refuses a password (`passwordSignIn: false`
 * from /api/session): from the internet the way in is the platform's two-step sign-in or nobody.
 * A password box there would be a dead end that looks like the way in — and before the server
 * refused it, an invitation to guess. So when single sign-on did not sign the admin in, the
 * screen says to open Display from the dashboard instead. On the masjid's network nothing changes.
 *
 * Rendered to markup (as ServerLink.test.ts does): what matters is what is on the screen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Login } from './App';

type Props = Parameters<typeof Login>[0];
const render = (p: Partial<Props>): string =>
  renderToStaticMarkup(
    createElement(Login, {
      onDone: () => {},
      ssoEnabled: true,
      ssoReachable: true,
      hasPassword: true,
      passwordSignIn: true,
      ...p,
    }),
  );
const hasPasswordBox = (html: string): boolean => /type="password"/.test(html);

test('from outside: no password box, whatever the panel has — the dashboard is the way in', () => {
  for (const p of [
    { hasPassword: true },
    { hasPassword: false },
    { hasPassword: true, ssoEnabled: false },
    { hasPassword: true, ssoReachable: false },
  ]) {
    const html = render({ ...p, passwordSignIn: false });
    assert.equal(hasPasswordBox(html), false, `a password box from outside: ${JSON.stringify(p)}`);
    assert.doesNotMatch(html, /Set a password/, 'and no offer to create one');
    assert.match(html, /OpenMasjidOS/);
  }
  assert.match(render({ passwordSignIn: false }), /Open it from your OpenMasjidOS\s+dashboard/);
});

test('on the masjid’s network the password box is still there', () => {
  assert.equal(hasPasswordBox(render({ hasPassword: true, passwordSignIn: true })), true);
  assert.equal(hasPasswordBox(render({ hasPassword: true, ssoEnabled: false })), true);
});
