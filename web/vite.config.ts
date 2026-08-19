// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

// The control panel is served by the Node server, which also exposes /api and
// /ws. In dev (`npm run dev`) we proxy those to the server on :8080.
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // Two entries. `screen.html` is what a television opens: it boots straight into the
      // display with no auth and none of the control panel's bundle, and it imports the
      // server's own SVG renderer so a browser screen and an RTSP screen draw from one
      // implementation rather than two that drift.
      // fileURLToPath, not URL.pathname: on Windows the latter yields a percent-encoded
      // path with a leading slash, which rollup cannot resolve.
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        screen: fileURLToPath(new URL('./screen.html', import.meta.url)),
      },
    },
  },
});
