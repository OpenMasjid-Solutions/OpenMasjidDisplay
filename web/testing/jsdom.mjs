// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * One document for the whole test process, installed BEFORE anything imports react-dom.
 *
 * The order is the whole point of this file existing separately. `react-dom/client` reads the
 * globals it needs when it is first imported, so a DOM created later — inside a `mount()` helper,
 * say — arrives after React has already decided there is no document. Nothing throws: events
 * dispatch, the handlers never run, and every interaction test quietly asserts against a component
 * that cannot see input. Measured, before this file existed: typing into a controlled input left
 * its state at `len=0`.
 *
 * So this is loaded with `--import`, which runs before the test files and therefore before the
 * import of react-dom inside them.
 *
 * One document for the process, not one per test: creating a second would leave React's listeners
 * attached to the first. Tests get their own container element from `mount()` and remove it again,
 * which is the isolation that actually matters.
 *
 * It is also why `npm test` passes `--test-force-exit`. A jsdom window holds handles that keep
 * node's event loop alive after the last assertion, so without it the runner simply never returns
 * — measured, and it looks exactly like a hung test. The companion `--test-timeout` is what keeps
 * a genuinely hung test loud: it fails at thirty seconds rather than being swept up by the exit.
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://screen.test/',
  pretendToBeVisual: true,
});

/**
 * `defineProperty`, not assignment.
 *
 * Node defines some of these on globalThis as getter-only — `navigator` has been one since Node
 * 21 — so a plain assignment throws "Cannot set property navigator of #<Object> which has only a
 * getter" and takes the whole file down with it.
 */
const put = (name, value) => {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
};

put('window', dom.window);
for (const name of [
  'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
  'HTMLElement', 'HTMLInputElement', 'SVGElement', 'Element', 'Node', 'DocumentFragment',
  'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'ResizeObserver',
]) {
  if (name in dom.window) put(name, dom.window[name]);
}

// React checks this before allowing `act`, and warns on every call without it.
put('IS_REACT_ACT_ENVIRONMENT', true);
