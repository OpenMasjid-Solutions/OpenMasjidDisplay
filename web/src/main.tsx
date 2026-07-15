// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { VolunteerApp } from './VolunteerApp';
import { prefsStore } from './prefs';
import { installCursorFx } from './cursorFx';
import './styles/index.css';

declare global {
  interface Window {
    __OMD_VOLUNTEER__?: boolean;
    /** Base path the app is served under (e.g. "/display" behind the OS tunnel, "" otherwise);
     *  injected into the volunteer page so its API calls resolve under the same prefix. */
    __OMD_BASE__?: string;
  }
}

prefsStore.hydrate();
installCursorFx();

// The server injects __OMD_VOLUNTEER__ when this bundle is served on the volunteer
// port, so the same build boots the simple mobile volunteer page there.
const isVolunteer = !!window.__OMD_VOLUNTEER__;
createRoot(document.getElementById('root')!).render(isVolunteer ? <VolunteerApp /> : <App />);
