// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * httpio.ts — the request/response plumbing shared by the admin API (api.ts) and the
 * volunteer API (volunteerApi.ts).
 *
 * Both had their own byte-identical copy of the body reader and their own idea of which
 * response headers to set, which is how the volunteer half ended up serving HTML and JSON
 * with no baseline headers at all while the admin half had them. One copy means one
 * behaviour, and a fix lands on both entry points at once.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Baseline security headers for the control panel, the volunteer page, and their APIs.
 *
 * The app already does this properly where it thought about it — uploaded files get
 * `nosniff` + a sandbox CSP, and the public widget deliberately sets `frame-ancestors *`
 * because it is MEANT to be embedded. Impact is modest (SameSite=Lax means a cross-site
 * frame carries no session cookie, so clickjacking can't reach an authenticated panel) but
 * there is no reason to leave it off.
 *
 * `frame-ancestors 'self'` only — deliberately NOT applied to the public widget, which
 * exists to be framed by a masjid's own website and sets its own headers.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "frame-ancestors 'self'",
};

export function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

/**
 * Read a JSON request body, capped at `maxBytes`.
 *
 * The chunks are buffered and decoded ONCE at the end rather than appended as strings as
 * they arrive. `chunk.toString()` decodes each chunk independently, so a multi-byte UTF-8
 * sequence straddling a chunk boundary is decoded as two invalid halves and becomes U+FFFD
 * in both — silent, permanent corruption of exactly one character. Node's default read
 * buffer is 64 KB, and a timetable body carrying Arabic hadith text, Urdu labels or an
 * Arabic masjid name goes well past that, so this was reachable with ordinary content and
 * would have been blamed on the font. Buffering keeps the sequence intact across the seam.
 *
 * The size cap is applied to BYTES as they arrive (not to the decoded string), so it still
 * bounds memory before anything is decoded.
 */
/** Thrown when a body exceeds its cap. Carries a CODE, so a caller can answer 413 without
 *  string-matching a message — the same brittleness the camera-error handling already refuses. */
export const BODY_TOO_LARGE = 'BODY_TOO_LARGE';

export function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        // Reject once, then keep DISCARDING rather than destroying the request.
        //
        // It used to call req.destroy() here, and that made the failure invisible to both ends: the
        // socket went away, so no 413 could be written, and the caller's `.catch(() => null)` then
        // answered 200 as though the body had been accepted. A device sending a slightly-too-large
        // check-in was told everything was fine, forever. Memory is still bounded because nothing
        // more is retained — which is what the cap was actually for.
        if (!over) {
          over = true;
          chunks.length = 0;
          reject(Object.assign(new Error('body too large'), { code: BODY_TOO_LARGE }));
        }
        return;
      }
      if (!over) chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
