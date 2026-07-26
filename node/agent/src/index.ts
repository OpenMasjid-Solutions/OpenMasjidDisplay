// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * omd-agent entry point — wires a real Raspberry Pi to the state machine in agent.ts.
 *
 * Everything interesting lives in agent.ts / display.ts / controller.ts, which know
 * nothing about a Pi. This file only does the wiring, so it stays small enough to read in
 * one sitting and the logic stays testable off-hardware.
 *
 * Runs under systemd; see image/overlay/etc/systemd/system/omd-agent.service.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AgentStore } from './store';
import { LinuxPlatform } from './platform';
import { createLocalApi } from './localApi';
import { Agent } from './agent';

/**
 * The firmware version the node reports.
 *
 * Read defensively. This file's depth below the package root differs between running the
 * TypeScript under tsx and running the build (tsc's rootDir spans the repo so protocol
 * compiles into the same program, putting this at dist/node/agent/src/), and a hard-coded
 * `require('../../package.json')` therefore threw MODULE_NOT_FOUND at startup on a real
 * node — the version is cosmetic, so it must never be able to stop the agent booting.
 */
function firmwareVersion(): string {
  const env = (process.env.OMD_AGENT_VERSION ?? '').trim();
  if (env) return env;
  for (let up = 1; up <= 5; up++) {
    try {
      const p = path.resolve(__dirname, ...Array(up).fill('..'), 'package.json');
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'openmasjid-node-agent' && pkg.version) return pkg.version;
    } catch {
      /* keep walking */
    }
  }
  return '0.0.0';
}

const FW = firmwareVersion();
const DATA_DIR = process.env.OMD_DATA_DIR ?? '/data';
const KIOSK_DIR = process.env.OMD_KIOSK_DIR ?? '/opt/omd/kiosk';
/** Port 80 so a human can type just the IP shown on the TV (spec §15 Q1). */
const PORT = Number.parseInt(process.env.OMD_PORT ?? '80', 10);

const ts = () => new Date().toISOString();
const log = (msg: string) => process.stdout.write(`${ts()} [omd-agent] ${msg}\n`);

async function main(): Promise<void> {
  const store = new AgentStore(DATA_DIR);
  // The binary names are overridable so the agent can be smoke-tested off-hardware and so a
  // different board can point at its own player without a code change.
  const platform = new LinuxPlatform(DATA_DIR, {
    cogBin: process.env.OMD_COG_BIN || undefined,
    gstBin: process.env.OMD_GST_BIN || undefined,
  });
  log(`starting — serial ${platform.serial()}, ${platform.model() || 'unknown board'}, fw ${FW}`);
  log(store.adopted ? `adopted by "${store.adoption?.controllerName}"` : 'not adopted yet');

  const agent = new Agent({
    store,
    platform,
    fw: FW,
    // The kiosk browser and this server are on the same box, so loopback — which also
    // means the view endpoint can be loopback-gated.
    kioskOrigin: `http://127.0.0.1${PORT === 80 ? '' : `:${PORT}`}`,
    assetDir: path.join(DATA_DIR, 'assets'),
    log,
  });

  const server = createLocalApi({
    store,
    platform,
    fw: FW,
    kioskDir: KIOSK_DIR,
    viewJson: () => agent.view(),
    readAsset: (sha) => agent.readAsset(sha),
    onAdopted: () => {
      log('adopted — dialling the control panel');
      agent.onAdopted();
    },
  });

  server.on('error', (err) => {
    // Port 80 needs CAP_NET_BIND_SERVICE (granted by the unit file). If it is missing the
    // node would be unadoptable, so say exactly that rather than dying silently.
    log(`local API could not listen on :${PORT} — ${err.message}`);
  });
  server.listen(PORT, () => log(`local API listening on :${PORT}`));

  await agent.start();

  const shutdown = () => {
    log('shutting down');
    void agent.stop().then(() => {
      server.close();
      setTimeout(() => process.exit(0), 200);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  // Exit non-zero so systemd restarts us. A node that gives up is a dark screen nobody
  // notices until Jumu'ah.
  process.exit(1);
});
