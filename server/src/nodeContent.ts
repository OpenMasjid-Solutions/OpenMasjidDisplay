// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * nodeContent.ts — decide WHAT to tell a Pi node to show, as a pure function.
 *
 * Kept separate from orchestrator.ts (and free of I/O) because this is where the
 * interesting judgements live: direct play versus a controller relay, and what to do
 * when a relay would break a legacy decoder screen. Pure means it is unit-testable
 * without MediaMTX, ffmpeg, a store or a socket — see nodeContent.test.ts.
 *
 * The compute win this whole feature exists for is upstream of here: the orchestrator
 * never adds a node screen's content to the ffmpeg/MediaMTX working set, so a timetable
 * shown only on nodes costs the controller nothing. This module just picks the frame.
 */
import type { ContentRef, NodeCaps, Source, Timetable } from './types';
import type { AssetRef, SetContent } from '../../packages/protocol/src/index';

export interface NodePlan {
  /** the frame to send the node */
  content: SetContent;
  /**
   * A source id the CONTROLLER must transcode to H.264 for this plan to work. The
   * orchestrator adds it to the normalize set, which publishes to `src_<id>` — the same
   * path the returned relay URL points at.
   */
  normalizeSourceId?: string;
  /**
   * An admin-facing problem with this plan. Set when we had to compromise, so the panel
   * and the Fabric alert can say what to change instead of leaving a screen mysteriously
   * black. Never contains a stream URL (they can embed camera credentials).
   */
  problem?: string;
}

export interface NodePlanInput {
  /** the screen's resolved effective content */
  content: ContentRef;
  /** the timetable, when content.kind === 'timetable' and it still exists */
  timetable?: Timetable;
  /** the source, when content.kind === 'source' and it still exists */
  source?: Source;
  /** what the node told us it can decode in hardware (absent until its first `hello`) */
  caps?: NodeCaps;
  /** RTSP origin a node on the LAN can reach us at, e.g. 'rtsp://192.168.1.10:8554' */
  relayBase: string;
  /** is this source ALSO driving a legacy decoder screen right now? */
  usedByDecoder: boolean;
  /** assets the node must fetch for a timetable (background photo, masjid logo) */
  assets?: AssetRef[];
}

const OFF: SetContent = { type: 'off' };

/**
 * Do we already know this node cannot decode this source?
 *
 * Unknown codec → `false` on purpose. We do NOT probe on the controller (that would
 * spend CPU on every source to save one failed attempt); instead the node tries once,
 * reports `unsupported_codec`, we record the codec on the Source, and every node from
 * then on is routed correctly. Learning by failing once is cheaper than always probing.
 */
function knownUndecodable(source: Source, caps?: NodeCaps): boolean {
  const codec = (source.videoCodec ?? '').trim().toLowerCase();
  if (!codec || !caps) return false;
  return !caps.codecs.map((c) => c.toLowerCase()).includes(codec);
}

/** Decide what a node should show. */
export function planNodeContent(input: NodePlanInput): NodePlan {
  const { content, timetable, source, caps, relayBase, usedByDecoder } = input;

  if (content.kind === 'off') return { content: OFF };

  if (content.kind === 'timetable') {
    // A deleted timetable resolves to nothing rather than a stale render.
    if (!timetable) return { content: OFF };
    return { content: { type: 'timetable', doc: timetable, assets: input.assets ?? [] } };
  }

  // ── A camera / HDMI source ────────────────────────────────────────────────
  if (!source || !source.enabled) return { content: OFF };

  const playback = source.nodePlayback ?? 'auto';
  const wantRelay =
    playback === 'always-relay' ? true : playback === 'direct-only' ? false : knownUndecodable(source, caps);

  if (!wantRelay) {
    // The happy path and the entire point of a node: video goes camera → node over the
    // LAN, and not one byte passes through the controller. `source.url` was already
    // scheme-allowlisted when it was saved (validate.ts safeSourceUrl), so we are not
    // widening the SSRF surface by handing it to the node.
    return { content: { type: 'stream', url: source.url, transport: 'tcp', relay: false } };
  }

  // ── A relay is wanted. Is it actually safe to start one? ──────────────────
  // A 'normalize' source is already transcoded by us and published to `src_<id>`, so
  // reusing it is free. A 'direct' source instead has `src_<id>` configured as a
  // MediaMTX PROXY path — starting a transcode that publishes into the same name would
  // fight the proxy and could break the decoder screen watching it. We refuse to do
  // that: a legacy screen must never regress to make a node work.
  const canRelay = source.mode === 'normalize' || !usedByDecoder;
  if (!canRelay) {
    return {
      content: { type: 'stream', url: source.url, transport: 'tcp', relay: false },
      problem:
        `"${source.name}" needs re-encoding for this screen, but it is also feeding an ` +
        `RTSP decoder screen directly. Set the source's mode to "normalize" so both can share ` +
        `the re-encoded stream.`,
    };
  }

  if (!relayBase) {
    // No LAN address to hand out — the controller is cloud-hosted (or we could not work
    // out our own address). Per the spec this combination cannot work: a cloud
    // controller has no path to a camera on the masjid's LAN.
    return {
      content: OFF,
      problem:
        `"${source.name}" cannot be shown on this screen: the Pi cannot decode it, and ` +
        `re-encoding needs a controller on the same network as the camera. Set the camera to ` +
        `H.264, or run the controller locally.`,
    };
  }

  return {
    content: { type: 'stream', url: `${relayBase}/${source.id}`, transport: 'tcp', relay: true },
    normalizeSourceId: source.id,
  };
}
