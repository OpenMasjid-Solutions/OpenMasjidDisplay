// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * store.ts — the agent's persistent state: /data/agent.json.
 *
 * Holds exactly what a node needs to keep working across reboots with no controller
 * present: who adopted it, where to dial, and its token. Deliberately tiny — the
 * timetable is NOT cached here (a stale timetable is worse than none, and the controller
 * re-pushes on connect), and neither is anything a factory reset should have to hunt for.
 *
 * Written atomically (tmp + rename) because the SD card in a masjid loses power without
 * warning, and a half-written adoption file would brick the node until someone reflashed
 * it. The rootfs is read-only in production (spec §13) — /data is the one writable mount.
 */
import fs from 'node:fs';
import path from 'node:path';
import { TOKEN_HEX_LEN } from '../../../packages/protocol/src/index';

export interface AgentState {
  /** absent until adoption */
  adoption?: {
    controllerName: string;
    /** ws:// or wss:// URL to dial, verbatim from the adopt call */
    wsUrl: string;
    /** the 256-bit hex token; the ONLY copy — the controller keeps just its hash */
    nodeToken: string;
    adoptedAt: string;
  };
}

const EMPTY: AgentState = {};

export class AgentStore {
  private state: AgentState = EMPTY;
  private readonly file: string;

  constructor(private readonly dataDir: string) {
    this.file = path.join(dataDir, 'agent.json');
    this.state = this.load();
  }

  private load(): AgentState {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as AgentState;
      // Validate rather than trust: a truncated or hand-edited file must read as
      // "unadopted" (recoverable, the panel can adopt again) instead of crash-looping the
      // agent, which on a read-only rootfs would need a card reader to fix.
      const a = parsed?.adoption;
      if (
        a &&
        typeof a.wsUrl === 'string' &&
        /^wss?:\/\//i.test(a.wsUrl) &&
        typeof a.nodeToken === 'string' &&
        a.nodeToken.length === TOKEN_HEX_LEN &&
        /^[0-9a-f]+$/.test(a.nodeToken)
      ) {
        return {
          adoption: {
            controllerName: String(a.controllerName ?? '').slice(0, 64),
            wsUrl: a.wsUrl,
            nodeToken: a.nodeToken,
            adoptedAt: String(a.adoptedAt ?? ''),
          },
        };
      }
    } catch {
      /* missing or unreadable — treat as unadopted */
    }
    return EMPTY;
  }

  get adopted(): boolean {
    return !!this.state.adoption;
  }

  get adoption(): AgentState['adoption'] {
    return this.state.adoption;
  }

  /** Record an adoption. Throws if already adopted — adoption is ONE-SHOT (spec §9). */
  adopt(a: NonNullable<AgentState['adoption']>): void {
    if (this.state.adoption) throw new Error('already adopted');
    this.state = { adoption: a };
    this.persist();
  }

  /** Forget everything: back to unadopted. */
  clear(): void {
    this.state = EMPTY;
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      /* ignore */
    }
  }

  private persist(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    // mode 0600: the token is a credential, and the node's local API is reachable on the
    // LAN — nothing but root should be able to read it off the card.
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
