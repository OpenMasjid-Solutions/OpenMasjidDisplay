// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * What the host serving this panel supports, for whichever component needs to know.
 *
 * The same bundle is served by an OpenMasjidOS server and (from phase 2) by a Raspberry Pi
 * running on its own, and the only difference between the two panels is what this says is
 * there. See server/src/capabilities.ts for the contract and
 * docs/PI_STANDALONE_DESIGN.md §2 for the rule: a capability that is off is ABSENT, never shown
 * disabled.
 *
 * A context rather than a prop because the consumers are scattered — a settings panel, a section
 * of the timetable editor, which is opened from two different routes — and threading one value
 * through four layers to reach them is more code than this, and more to get wrong. It mirrors
 * `useToast` and `usePrefs`, which is how everything else of this shape is done here.
 */
import { createContext, useContext } from 'react';
import { ALL_CAPABILITIES, type Capabilities } from './types';

const CapsCtx = createContext<Capabilities>(ALL_CAPABILITIES);

/** The host's capabilities. Defaults to everything on, which is what the server has — so a
 *  component rendered outside the provider behaves exactly as it did before this existed. */
export const useCaps = (): Capabilities => useContext(CapsCtx);

export const CapabilitiesProvider = CapsCtx.Provider;
