// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * devnode — a Raspberry Pi node you can adopt from the control panel, on your laptop.
 *
 * Runs the REAL agent: the real state machine, the real protocol client, the real local
 * adoption API, the real asset cache. Only `Platform` is swapped for one that prints what
 * it was asked to display instead of launching a browser and a video pipeline. That is the
 * whole point of the seam in platform.ts.
 *
 * So this is not a simulator of the feature — it is the feature, minus the HDMI cable. It
 * exercises everything except the parts that need a Pi (hardware decode, KMS output, the
 * Wi-Fi portal, the boot path).
 *
 * ── Run it ──
 *   cd node/agent
 *   npm run devnode                 # binds :8099 on loopback
 *   npm run devnode -- --port 9100  # if 8099 is taken
 *
 * Then in the panel: Settings → turn on "Offer Pi node screens", then Screens → Add screen
 * → OpenMasjid Pi node → enter 127.0.0.1:8099 → Check → Add.
 *
 * ── Why NOT :80 here, when a real node uses :80 ──
 * A real node is a dedicated appliance: nothing else on that board wants :80, and the admin
 * gets to type just the IP they read off the TV. But **OpenMasjidOS binds 80:80 and 443:443
 * on its host**, so a dev harness defaulting to :80 would fight the platform on the very
 * machine you develop on. Hence a high port here, and `nodeOrigin` accepts `host:port` only
 * for loopback — a LAN address with a port stays refused, because that would make the
 * adoption endpoint a port scanner for the masjid's network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentStore } from './store';
import { createLocalApi } from './localApi';
import { Agent } from './agent';
import { primaryIPv4, type Platform, type Proc } from './platform';
import type { NodeCapsMsg, NodeHealthMsg } from '../../../packages/protocol/src/index';

const args = process.argv.slice(2);
const argOf = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
// NEVER default to 80: OpenMasjidOS binds :80 on its host, and this harness runs on a
// developer's machine. A real node (a dedicated board) still uses :80 — see the header.
const PORT = Number.parseInt(argOf('port', '8099'), 10);
const DATA_DIR = argOf('data', path.join(os.tmpdir(), 'omd-devnode'));
const FRESH = args.includes('--fresh');
const SERIAL = argOf('serial', 'dev00000000cafe');

const log = (msg: string) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} [devnode] ${msg}\n`);

/** A platform that narrates instead of driving hardware. */
class ConsolePlatform implements Platform {
  serial(): string {
    return SERIAL;
  }
  model(): string {
    return 'Dev node (not a Raspberry Pi)';
  }
  caps(): NodeCapsMsg {
    // Claim what a Zero 2 W claims, so the controller's direct-vs-relay decisions behave
    // exactly as they would against real hardware.
    return { codecs: ['h264'], maxHeight: 1080, maxFps: 30 };
  }
  health(): NodeHealthMsg {
    return {
      tempC: 42,
      memFreeMb: Math.round(os.freemem() / 1048576),
      uptimeS: Math.round(os.uptime()),
      ip: primaryIPv4() || '127.0.0.1',
    };
  }
  clockSynced(): boolean {
    return true;
  }
  startKiosk(url: string): Proc {
    log(`SCREEN → kiosk page  ${url}`);
    log('       (open that URL in a browser to see exactly what the TV would show)');
    return idleProc();
  }
  startPlayer(url: string, transport: 'tcp' | 'udp'): Proc {
    // Credentials are scrubbed the way the server does in logs — a camera URL can carry
    // them, and this prints to a terminal someone may paste into an issue.
    log(`SCREEN → video       ${url.replace(/\/\/[^@/]*@/, '//***:***@')} (${transport})`);
    return idleProc();
  }
  blank(): void {
    log('SCREEN → blank');
  }
  reboot(): void {
    log('REBOOT requested — a real node would restart now; exiting');
    setTimeout(() => process.exit(0), 100);
  }
  wipeData(): void {
    log(`FACTORY RESET — clearing ${DATA_DIR}`);
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 100);
  }
}

/** A child that just sits there, since nothing is really launched. */
function idleProc(): Proc {
  let alive = true;
  return {
    get running() {
      return alive;
    },
    onExit() {
      /* never exits on its own */
    },
    async stop() {
      alive = false;
    },
  };
}

async function main(): Promise<void> {
  if (FRESH) {
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const store = new AgentStore(DATA_DIR);
  const platform = new ConsolePlatform();
  const agent = new Agent({
    store,
    platform,
    fw: '0.64.0-dev',
    kioskOrigin: `http://127.0.0.1:${PORT}`,
    assetDir: path.join(DATA_DIR, 'assets'),
    log,
  });

  const server = createLocalApi({
    store,
    platform,
    fw: '0.64.0-dev',
    // The built kiosk bundle, so the page a real TV would show is browsable here too.
    kioskDir: path.resolve(__dirname, '../../../kiosk/dist'),
    viewJson: () => agent.view(),
    readAsset: (sha) => agent.readAsset(sha),
    onAdopted: () => {
      log('ADOPTED — dialling the control panel');
      agent.onAdopted();
    },
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
      log(`could not bind :${PORT} (${err.code}). Try:  npm run devnode -- --port 8099`);
      process.exit(1);
    }
    log(`local API error: ${err.message}`);
  });

  server.listen(PORT, () => {
    log(`listening on :${PORT} — serial ${SERIAL}, data ${DATA_DIR}`);
    if (store.adopted) {
      log(`already adopted by "${store.adoption?.controllerName}" — pass --fresh to start over`);
    } else {
      log('ADOPT IT: panel → Settings → turn on "Offer Pi node screens", then');
      log(`          Screens → Add screen → OpenMasjid Pi node → 127.0.0.1:${PORT} → Check → Add`);
      log('          (a real node answers on :80 so an admin types just the IP off the TV; this');
      log('           harness uses a high port because OpenMasjidOS itself binds :80 on the host)');
    }
    log(`kiosk page: http://127.0.0.1:${PORT}/   ·   what it should draw: /api/view`);
  });

  await agent.start();

  const shutdown = () => {
    log('stopping');
    void agent.stop().then(() => {
      server.close();
      setTimeout(() => process.exit(0), 100);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
