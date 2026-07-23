// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Uploaded timetable images — custom backgrounds and masjid logos — stored under
 * /data/uploads and inlined into the rendered SVG as data: URIs (resvg only embeds
 * data URIs, not external files). Reads are cached by modification time so we don't
 * re-encode an image on every frame.
 *
 * Files are named `<id>.<ext>` for the background and `<id>.logo.<ext>` for the
 * logo, so the two never collide.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config';

const uploadsDir = () => path.join(config.dataDir, 'uploads');

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/** Reject anything that isn't a plain filename (no traversal, no separators). */
function safeName(name: string): string | null {
  const base = path.basename(String(name || ''));
  return base && base !== '.' && base !== '..' && /^[A-Za-z0-9._-]+$/.test(base) ? base : null;
}

const cache = new Map<string, { uri: string; mtimeMs: number }>();

/** A data: URI for a stored upload `file`, or null if missing/invalid. */
function dataUri(file: string): string | null {
  const name = safeName(file);
  if (!name) return null;
  const full = path.join(uploadsDir(), name);
  let st: fs.Stats;
  try {
    st = fs.statSync(full);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const cached = cache.get(name);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.uri;
  const mime = MIME[path.extname(name).toLowerCase()] ?? 'image/png';
  let buf: Buffer;
  try {
    buf = fs.readFileSync(full);
  } catch {
    return null;
  }
  const uri = `data:${mime};base64,${buf.toString('base64')}`;
  cache.set(name, { uri, mtimeMs: st.mtimeMs });
  return uri;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
};

/** The on-disk basename (without extension) for an asset of a given kind. */
function prefixFor(id: string, kind: 'bg' | 'logo'): string | null {
  const safeId = safeName(id);
  if (!safeId) return null;
  return kind === 'logo' ? `${safeId}.logo` : safeId;
}

function saveAsset(id: string, kind: 'bg' | 'logo', mime: string, data: Buffer): string {
  const prefix = prefixFor(id, kind);
  if (!prefix) throw new Error('invalid id');
  const ext = EXT_BY_MIME[mime] ?? '.png';
  fs.mkdirSync(uploadsDir(), { recursive: true });
  removeAsset(id, kind); // clear any prior file (the extension may change)
  // A fresh random suffix every upload so REPLACING an image yields a NEW filename.
  // Otherwise a replacement reuses `<id>.<ext>`, the stored value never changes, and
  // the editor preview (keyed on it) — plus any browser cache — shows the old image.
  const name = `${prefix}.${crypto.randomBytes(4).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(uploadsDir(), name), data);
  cache.delete(name);
  return name;
}

function removeAsset(id: string, kind: 'bg' | 'logo'): void {
  const prefix = prefixFor(id, kind);
  if (!prefix) return;
  const dir = uploadsDir();
  try {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const matches = f === prefix || f.startsWith(`${prefix}.`);
      // The background prefix (`<id>`) would also match the logo (`<id>.logo.png`)
      // and announcements (`<id>.ann.…`); exclude those when clearing the background.
      if (matches && !(kind === 'bg' && (f.includes('.logo.') || f.includes('.ann.')))) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {
          /* ignore */
        }
        cache.delete(f);
      }
    }
  } catch {
    /* ignore */
  }
}

/** Is this a content type we accept as an uploaded image? */
export function isAllowedImageMime(mime: string): boolean {
  return mime in EXT_BY_MIME;
}

/** The TRUE image type from magic bytes — never trust the caller's label. Browsers set a
 *  data-URI's MIME from the file *extension*, so a JPEG saved as "logo.png" arrives labeled
 *  image/png; the SVG renderer (resvg) then picks its decoder from that label and fails to
 *  decode the mismatched bytes → a blank image. Sniffing the bytes fixes that. Returns a
 *  canonical mime, or null if it isn't an image we can render (resvg has no WebP support, so
 *  WebP is reported and then refused upstream). */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && (buf.toString('latin1', 0, 6) === 'GIF87a' || buf.toString('latin1', 0, 6) === 'GIF89a')) return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  const head = buf.toString('utf8', 0, Math.min(buf.length, 512)).replace(/^﻿/, '').trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<svg') || /<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** resvg (the display renderer) can decode these; WebP/unknown cannot be shown. */
export function isRenderableImageMime(mime: string): boolean {
  return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif' || mime === 'image/svg+xml';
}

/** Copy an existing upload to a NEW timetable's id (for duplicating a timetable),
 *  returning the new filename — so the copy owns its own files and deleting the
 *  original never affects it. Returns '' if the source is missing. */
export function copyAsset(srcFile: string, newId: string, kind: 'bg' | 'logo' | 'ann'): string {
  const info = uploadFilePath(srcFile);
  if (!info) return '';
  let data: Buffer;
  try {
    data = fs.readFileSync(info.path);
  } catch {
    return '';
  }
  return kind === 'ann' ? saveAnnouncement(newId, info.mime, data) : saveAsset(newId, kind, info.mime, data);
}

/** The full path of an uploaded file if its name is safe and it exists, else null
 *  (used to stream announcement thumbnails to the editor). */
export function uploadFilePath(file: string): { path: string; mime: string } | null {
  const name = safeName(file);
  if (!name) return null;
  const full = path.join(uploadsDir(), name);
  try {
    if (!fs.statSync(full).isFile()) return null;
  } catch {
    return null;
  }
  return { path: full, mime: MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream' };
}

// ── Backgrounds ──────────────────────────────────────────────────────────────
export const backgroundDataUri = (file: string): string | null => dataUri(file);
export const saveBackground = (id: string, mime: string, data: Buffer): string => saveAsset(id, 'bg', mime, data);
export const removeBackground = (id: string): void => removeAsset(id, 'bg');

// ── Logos ────────────────────────────────────────────────────────────────────
export const logoDataUri = (file: string): string | null => dataUri(file);
export const saveLogo = (id: string, mime: string, data: Buffer): string => saveAsset(id, 'logo', mime, data);
export const removeLogo = (id: string): void => removeAsset(id, 'logo');

// ── Announcement images (many per timetable, each its own file) ──────────────
export const announcementDataUri = (file: string): string | null => dataUri(file);
/** Store one announcement image; returns its unique filename `<id>.ann.<rand>.<ext>`. */
export function saveAnnouncement(id: string, mime: string, data: Buffer): string {
  const safeId = safeName(id);
  if (!safeId) throw new Error('invalid id');
  const ext = EXT_BY_MIME[mime] ?? '.png';
  fs.mkdirSync(uploadsDir(), { recursive: true });
  const name = `${safeId}.ann.${crypto.randomBytes(5).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(uploadsDir(), name), data);
  cache.delete(name);
  return name;
}
/** Delete a single announcement image by its (validated) filename. */
export function removeAnnouncement(file: string): void {
  const name = safeName(file);
  if (!name || !name.includes('.ann.')) return;
  try {
    fs.unlinkSync(path.join(uploadsDir(), name));
  } catch {
    /* already gone */
  }
  cache.delete(name);
}
// ── Live parking board frame (from the Parking Attendant app via the Fabric) ──
// A single, deterministically-named frame per timetable, refreshed by parkingFeed.ts.
// The `.ann.` infix means removeAllAnnouncements() cleans it up with the rest on delete,
// and activeAnnouncementImage() can reference the name without a filesystem check.
/** The fixed filename of a timetable's live parking frame. */
export function parkingFrameName(id: string): string | null {
  const safeId = safeName(id);
  return safeId ? `${safeId}.ann.parking.png` : null;
}
/** Write (or replace) a timetable's live parking frame; returns the filename or null. */
export function saveParkingFrame(id: string, data: Buffer): string | null {
  const name = parkingFrameName(id);
  if (!name) return null;
  fs.mkdirSync(uploadsDir(), { recursive: true });
  const tmp = path.join(uploadsDir(), `${name}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, path.join(uploadsDir(), name)); // atomic swap so a frame is never half-written
  cache.delete(name); // invalidate the data-URI cache (mtime changed)
  return name;
}

/** Delete every announcement image belonging to timetable `id` (on timetable delete). */
export function removeAllAnnouncements(id: string): void {
  const safeId = safeName(id);
  if (!safeId) return;
  const dir = uploadsDir();
  try {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${safeId}.ann.`)) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {
          /* ignore */
        }
        cache.delete(f);
      }
    }
  } catch {
    /* ignore */
  }
}
