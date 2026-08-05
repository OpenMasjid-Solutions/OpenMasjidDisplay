// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * render/renderPool.ts — thin owner of the render worker thread(s).
 *
 * `RenderWorker` wraps one worker_threads worker with a promise-based request API
 * and recreates it transparently if it dies. The timetable video pipeline gets its
 * own worker (so a busy editor preview can't stall the live stream); previews share
 * a single lazily-created worker.
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { makeLog } from '../logger';
import type { Timetable } from '../types';

const log = makeLog('render');

// Resolve the worker next to this module. In the built container it's the emitted
// .js; under tsx (local dev) __filename ends in .ts and we load the .ts through the
// same loader.
/** How long a single render may take before we call the worker wedged rather than busy.
 *  Generous: the video loop asks for one render per second, and even a 4K-ish frame on a
 *  loaded 2-core box finishes in well under a second. Overridable for very slow hardware
 *  (and so the tests don't have to wait 15 real seconds). */
const REQUEST_TIMEOUT_MS = (() => {
  const n = Number.parseInt(process.env.RENDER_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
})();

const isTs = __filename.endsWith('.ts');
const WORKER_FILE = path.join(__dirname, isTs ? 'renderWorker.ts' : 'renderWorker.js');
/**
 * Under tsx (local dev + tests) the worker has to load a .ts file. Register tsx's CJS hook,
 * NOT `--import tsx`.
 *
 * `--import tsx` installs the ESM loader, so the worker loads renderWorker.ts as an ES
 * module — and then its own extensionless `import './svg'` has to go through ESM resolution,
 * which does not add extensions. On Node 24 that happened to resolve; on **Node 22 — the
 * version the runtime image actually uses** — it fails with ERR_MODULE_NOT_FOUND, so
 * rendering was broken for anyone running the server through tsx on the production Node
 * version. It went unnoticed because nothing ran the tests on Node 22 until now.
 *
 * This package is CommonJS (no "type" in package.json, `module: CommonJS` in tsconfig), so
 * tsx/cjs is the matching hook: renderWorker.ts loads as CJS and its extensionless requires
 * resolve the way the rest of the codebase already expects. The compiled container path is
 * unaffected — it loads plain .js with no hook at all.
 */
const WORKER_OPTS = isTs ? { execArgv: ['--require', 'tsx/cjs'] } : undefined;

interface Pending {
  resolve: (m: WorkerMsg) => void;
  reject: (e: Error) => void;
}
export interface Hotspot {
  id: string;
  value: string;
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}
interface WorkerMsg {
  id: number;
  ok: boolean;
  error?: string;
  width?: number;
  height?: number;
  buf?: ArrayBuffer;
  hotspots?: Hotspot[];
}

export class RenderWorker {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private disposed = false;

  /** @param timeoutMs deadline for a single render (see REQUEST_TIMEOUT_MS). */
  constructor(private readonly timeoutMs: number = REQUEST_TIMEOUT_MS) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(WORKER_FILE, WORKER_OPTS);
    w.on('message', (m: WorkerMsg) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m);
      else p.reject(new Error(m.error || 'render failed'));
    });
    // Only the CURRENT worker may fail the pending queue.
    //
    // `pending` is one Map for the life of the RenderWorker, shared across every worker
    // generation, but this handler is created per worker. A recycled worker (see the
    // deadline in request()) is terminated and REPLACED, then fires its 'exit' — and the
    // old handler used to reject and clear the whole map, killing the *replacement*
    // worker's in-flight render as collateral. On a screen that already timed out once,
    // that turned one wedged render into a second failed render, delaying recovery.
    const fail = (err: Error) => {
      if (this.worker !== w) return; // a zombie's death is not the live worker's problem
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker = null;
    };
    w.on('error', (err) => {
      log.debug(`render worker error: ${err.message}`);
      fail(err);
    });
    w.on('exit', () => {
      if (!this.disposed) fail(new Error('render worker exited'));
    });
    this.worker = w;
    return w;
  }

  private request(payload: Record<string, unknown>): Promise<WorkerMsg> {
    if (this.disposed) return Promise.reject(new Error('render worker disposed'));
    const id = ++this.seq;
    const w = this.ensure();
    return new Promise((resolve, reject) => {
      // A render MUST NOT be able to hang forever. A worker that crashes is handled
      // ('error'/'exit' reject everything pending), but one that simply never answers
      // used to leave this promise unsettled for the life of the process — and the video
      // pipeline gates its next render on the previous one finishing, so the screen froze
      // on its last frame permanently while still looking healthy. Deadline + recycle.
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return; // already settled
        log.warn(`render request timed out after ${this.timeoutMs}ms; recycling the worker`);
        // recycle() rejects every OTHER request that was queued on this worker too — they
        // were all sent to w and w is about to be terminated, so none of them can ever be
        // answered. Our own entry is already removed above, so it is not double-settled.
        this.recycle(w, new Error('render worker recycled after a timeout'));
        reject(new Error(`render timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.(); // never hold the process open on a pending render
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      w.postMessage({ ...payload, id });
    });
  }

  /** Drop a wedged worker so the NEXT request starts a fresh thread instead of queueing
   *  behind one that will never answer. This is what lets a hung render self-heal.
   *
   *  Rejects everything still pending: `ensure()` hands out one worker at a time, so every
   *  in-flight request was queued on `w`, and `w` is about to be terminated. We cannot leave
   *  that to w's 'exit' handler, because the generation guard there deliberately ignores a
   *  zombie's exit — without this, a second concurrent render (the shared preview worker can
   *  have several) would never settle at all.
   *
   *  Note terminate() cannot interrupt a synchronous native call already inside resvg: that
   *  thread keeps a core busy until the render returns. So this restores *correctness*
   *  promptly but not necessarily CPU; a genuinely pathological SVG still costs one core
   *  until it finishes. */
  private recycle(w: Worker, err: Error): void {
    if (this.worker === w) this.worker = null;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    try {
      void w.terminate();
    } catch {
      /* already gone */
    }
  }

  /** An RGBA frame for the video pipeline. `renderWidth` (optional) rasterises the
   *  SVG at that width instead of its native size, so the heavy render stays cheap and
   *  the per-second loop never slips; ffmpeg upscales to the output resolution. */
  async raw(tt: Timetable, nowMs: number, renderWidth?: number): Promise<{ width: number; height: number; pixels: Buffer }> {
    const m = await this.request({ kind: 'raw', tt, nowMs, renderWidth });
    return { width: m.width ?? 0, height: m.height ?? 0, pixels: Buffer.from(m.buf as ArrayBuffer) };
  }

  /** A downscaled PNG for the control-panel preview. `bgFile`/`logoFile` come from
   *  the raw form body (which the validator strips), so unsaved uploads still show. */
  async png(tt: Timetable, nowMs: number, width: number, bgFile: string, logoFile: string): Promise<Buffer> {
    const m = await this.request({ kind: 'png', tt, nowMs, width, bgFile, logoFile });
    return Buffer.from(m.buf as ArrayBuffer);
  }

  /** Click-to-edit text regions for the live editor (fractional coordinates). */
  async meta(tt: Timetable, nowMs: number): Promise<Hotspot[]> {
    const m = await this.request({ kind: 'meta', tt, nowMs });
    return m.hotspots ?? [];
  }

  dispose(): void {
    this.disposed = true;
    const w = this.worker;
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error('render worker disposed'));
    this.pending.clear();
    if (w) void w.terminate();
  }
}

// Shared worker for one-off preview renders (created on first use).
let previewWorker: RenderWorker | null = null;

export function renderPreviewPng(tt: Timetable, nowMs: number, width: number, bgFile: string, logoFile: string): Promise<Buffer> {
  if (!previewWorker) previewWorker = new RenderWorker();
  return previewWorker.png(tt, nowMs, width, bgFile, logoFile);
}

export function renderPreviewMeta(tt: Timetable, nowMs: number): Promise<Hotspot[]> {
  if (!previewWorker) previewWorker = new RenderWorker();
  return previewWorker.meta(tt, nowMs);
}
