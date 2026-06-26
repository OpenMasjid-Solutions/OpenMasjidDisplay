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
const isTs = __filename.endsWith('.ts');
const WORKER_FILE = path.join(__dirname, isTs ? 'renderWorker.ts' : 'renderWorker.js');
const WORKER_OPTS = isTs ? { execArgv: ['--import', 'tsx'] } : undefined;

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
    const fail = (err: Error) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      if (this.worker === w) this.worker = null;
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
      this.pending.set(id, { resolve, reject });
      w.postMessage({ ...payload, id });
    });
  }

  /** An RGBA frame for the video pipeline. `renderWidth` (optional) rasterises the
   *  SVG at that width instead of its native size — used to cap 4K at 1080p so the
   *  frame stays light; ffmpeg upscales it to the true output resolution. */
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
