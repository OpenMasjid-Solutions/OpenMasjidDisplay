// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Entry point: wires the store, renderer, orchestrator, HTTP API and WebSocket
 *  hub together, waits for MediaMTX, and keeps schedules ticking. */
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { config } from './config';
import { makeLog } from './logger';
import { Store } from './store';
import { RenderManager } from './render/renderer';
import { Orchestrator } from './orchestrator';
import { createApi } from './api';
import { createVolunteerApi } from './volunteerApi';
import { WsHub } from './ws';
import { hasValidSession } from './auth';
import { attachShellAdmin, attachShellDevice, sweepShellSessions } from './piShell';
import { findDeviceByToken } from './piAgent';
import { ping } from './mediamtx';
import { MediaMtxServer } from './mediamtxServer';
import { notify } from './fabric';
import { WhatsAppAnnouncer } from './whatsappAnnounce';
import { FabricCommands } from './fabricCommands';
import { regenerateReportFrames } from './render/reportFrames';

const log = makeLog('main');

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const store = new Store();
  const render = new RenderManager();
  let hub: WsHub | null = null;

  // The RTSP server (MediaMTX) runs inside this same container; bring it up first.
  const mediamtx = new MediaMtxServer();
  mediamtx.start();

  // Alerts the masjid via the Fabric when a screen stops/starts pulling its stream.
  const orchestrator = new Orchestrator(
    store,
    render,
    (statuses) => {
      hub?.broadcast('status', statuses);
    },
    (p) => notify(p),
  );

  // Any data change → tell panels to refetch state and re-reconcile (debounced).
  let pending: NodeJS.Timeout | null = null;
  store.onChange(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      hub?.broadcast('state', null);
      void orchestrator.reconcile();
    }, 100);
  });

  // Posts the Iqāmah-change notice to the masjid's WhatsApp group when the change comes into
  // range. Inert until an admin switches it on and picks a group; the check is local, so a
  // masjid not using it never talks to the platform.
  const whatsapp = new WhatsAppAnnouncer({ store });

  // Admin commands arriving from OpenMasjidOS (an admin messaging the masjid's WhatsApp
  // number). Holds the Iqamah wizard's session across calls, so it is built once here.
  const commands = new FabricCommands({ store });

  // The volunteer page handler is shared: it runs on its own port (below) AND is mounted on
  // the main control-panel port (under /volunteer) so it rides the OS tunnel with no platform
  // change. One instance → one shared PIN rate-limiter across both entry points.
  const volunteerHandler = createVolunteerApi({ store, orchestrator });
  const handler = createApi({ store, orchestrator, volunteer: volunteerHandler, whatsapp, commands });
  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      log.error('request handler crashed', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"Internal error."}');
      }
    });
  });
  /**
   * The two halves of a Pi terminal, both dialled IN to us — see piShell.ts for why it is built
   * that way and what holds it shut. Authentication differs per half and neither is the panel
   * cookie by default: the device presents its own token and a one-time secret.
   */
  const shellRoutes = (
    path: string,
    req: IncomingMessage,
    upgrade: (onOpen: (ws: import('ws').WebSocket) => void) => void,
  ): boolean => {
    // The panel's viewer. Same session check as every other admin surface.
    const admin = /^\/api\/pi\/shell\/([A-Za-z0-9_-]{16,64})$/.exec(path);
    if (admin) {
      if (!hasValidSession(req, store.secret)) return false;
      upgrade((ws) => {
        if (!attachShellAdmin(admin[1], ws)) ws.close(1008, 'no such session');
      });
      return true;
    }
    // The device. Behind the platform tunnel the app is served under /<basePath>/…, and the
    // platform does not strip the prefix — so the optional segment is what lets a tunnelled screen
    // reach this at all, exactly as the polling routes allow it.
    const dev = /^(?:\/[a-z0-9-]+)?\/pi\/([A-Za-z0-9_-]{16,64})\/shell\/([A-Za-z0-9_-]{16,64})$/.exec(path);
    if (dev) {
      const device = findDeviceByToken(store.db, dev[1]);
      const secret = req.headers['x-openmasjid-shell-secret'];
      if (!device || typeof secret !== 'string') return false;
      upgrade((ws) => {
        if (!attachShellDevice(dev[2], device.id, secret, ws)) ws.close(1008, 'not accepted');
      });
      return true;
    }
    return false;
  };
  hub = new WsHub(server, (req) => hasValidSession(req, store.secret), shellRoutes);
  // Owned here rather than inside piShell so that module holds no timer of its own and a test can
  // drive the clock directly.
  setInterval(() => sweepShellSessions(), 30_000).unref?.();

  server.listen(config.port, () => {
    log.info(`OpenMasjid Display control panel listening on :${config.port}`);
    if (!store.db.admin) log.info('first run — open the control panel to create your admin account');
  });

  // The simple mobile volunteer page ALSO runs on its own port (a clean phone URL that can be
  // firewalled separately). It always listens, but the API stays inert until an admin enables
  // it and sets a PIN (see Settings). Same handler instance as the main-port mount above.
  const volunteerServer = http.createServer((req, res) => {
    volunteerHandler(req, res).catch((err) => {
      log.error('volunteer request handler crashed', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"Internal error."}');
      }
    });
  });
  volunteerServer.listen(config.volunteerPort, () => {
    log.info(`volunteer page listening on :${config.volunteerPort}`);
  });

  // Wait (briefly) for MediaMTX to come up, then reconcile.
  void (async () => {
    for (let i = 0; i < 60; i++) {
      if (await ping()) {
        log.info('MediaMTX is reachable');
        break;
      }
      await delay(1000);
    }
    await orchestrator.reconcile();
  })();

  // Re-evaluate schedules and stream health on a steady cadence.
  setInterval(() => void orchestrator.reconcile(), 15000);

  whatsapp.start();

  // Build the incorrect-parking alert frames from any existing volunteer reports.
  regenerateReportFrames(store);

  const shutdown = () => {
    log.info('shutting down');
    whatsapp.stop();
    render.stopAll();
    mediamtx.stop();
    server.close();
    volunteerServer.close();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.error('fatal startup error', err);
  process.exit(1);
});
