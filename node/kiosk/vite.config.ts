// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { defineConfig } from 'vite';

// The kiosk page the Pi's browser loads over loopback from omd-agent. Built to plain
// static files the agent serves from /opt/omd/kiosk.
export default defineConfig({
  // Relative asset URLs so the bundle works from whatever path the agent serves it at.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // One JS file, nothing inlined as a data URI. A Pi Zero 2 W over loopback gains
    // nothing from code splitting, and fewer requests means the screen paints sooner
    // after a reboot.
    assetsInlineLimit: 0,
    rollupOptions: { output: { manualChunks: undefined } },
    // The Pi's WPE WebKit is current, so there is no reason to down-level.
    target: 'es2022',
  },
  server: {
    port: 5174,
    // packages/render-core sits outside this app's root, so dev needs permission to read
    // up the tree. Production is unaffected — the build inlines it into the bundle.
    fs: { allow: ['../..'] },
    // Lets the page be developed against a real (or mock) agent.
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
});
