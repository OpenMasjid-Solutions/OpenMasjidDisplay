// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The smallest way to mount a component and poke it, for the few tests that need to.
 *
 * Most of the panel is tested by rendering a pure view to a string — no DOM, no framework, and
 * that is the right tool for "did this state show the right words". It cannot reach a component
 * that FETCHES, though, and the container around the display-server page holds real logic: it
 * polls, it drops a result that arrives after unmount, and it must not report a save as failed
 * when the save worked and only the refresh afterwards did not.
 *
 * jsdom, `react-dom/client` and React's own `act` — no component-testing library. `act` is what
 * flushes effects and state updates, and it ships with React.
 *
 * The document itself is installed by `testing/jsdom.mjs`, which must load BEFORE react-dom; see
 * the reasoning there, which cost an afternoon to find.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';

export interface Mounted {
  /** The rendered markup, read fresh each time. */
  html(): string;
  /** Click the first button whose text contains this, and flush whatever it caused. */
  click(text: string): Promise<void>;
  /** Type into the first input, as a change React will actually see. */
  type(value: string): Promise<void>;
  /** Let pending promises settle — one flush of the microtask queue inside `act`. */
  settle(): Promise<void>;
  unmount(): Promise<void>;
}

/** Mount a component into its own container and hand back the few things a test needs. */
export async function mount(element: ReactElement): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });

  const settle = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
    });
  };

  return {
    html: () => container.innerHTML,
    settle,

    async click(text: string) {
      const button = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text));
      if (!button) throw new Error(`no button containing ${JSON.stringify(text)} in: ${container.innerHTML}`);
      if (button.hasAttribute('disabled')) throw new Error(`the button ${JSON.stringify(text)} is disabled`);
      await act(async () => {
        button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      });
      await settle();
    },

    async type(value: string) {
      const input = container.querySelector('input');
      if (!input) throw new Error(`no input in: ${container.innerHTML}`);
      await act(async () => {
        /**
         * Set through the PROTOTYPE setter, then fire `input`.
         *
         * A controlled input carries a value tracker that React uses to decide whether anything
         * changed. Assigning `input.value` updates the tracker too, so React compares the new
         * value against itself, sees no change, and never calls onChange. Going through the
         * prototype's setter writes the value without touching the tracker, which is what makes
         * the event look like a human typing.
         */
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, value);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      await settle();
    },

    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}
