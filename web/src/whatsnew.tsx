// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * "What's new" — the release notes THIS build shipped with, from the CHANGELOG.md copied
 * into the image (see GET /api/changelog). OpenMasjidOS updates apps quietly in the
 * background, so without this an admin has no way to learn what changed without leaving
 * for GitHub. It works with no internet because the notes ship with the app.
 *
 * Laid out to match OpenMasjid Kiosk's dialog exactly, so the two apps read alike.
 *
 * The sections are parsed server-side (server/src/changelog.ts, where the test suite can
 * cover it). This file only formats the inline markers into React nodes — there is no
 * dangerouslySetInnerHTML anywhere, so no wording in a release note can inject markup.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import type { Release } from './types';

declare const __APP_VERSION__: string;

/** Render `**bold**` and `` `code` `` as React nodes; everything else stays plain text. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={k++}>{m[1]}</strong>);
    else out.push(<code key={k++}>{m[2]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Strip a leading "v" and any trailing words, so "0.66.1" and a heading like
 *  "0.66.1" or "v0.66.1" compare equal. A range heading simply never matches. */
const normalise = (v: string) => v.trim().replace(/^v/i, '').split(/\s+/)[0];

export function WhatsNewModal({ onClose }: { onClose: () => void }) {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [err, setErr] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);
  const version = __APP_VERSION__;

  useEffect(() => {
    let alive = true;
    api
      .changelog()
      .then((r) => alive && setReleases(r.releases))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : 'Couldn’t load the release notes.'));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="What’s new"
      onClick={onClose}
    >
      <div className="modal glass-raised modal--window" onClick={(e) => e.stopPropagation()}>
        <div className="tl-bar">
          <button ref={closeRef} className="tl tl--red" onClick={onClose} aria-label="Close" title="Close" />
          <span className="tl tl--amber" aria-hidden="true" />
        </div>

        <div className="modal-head">
          <div className="card-head__main">
            <h3 className="section-title-inline">What’s new</h3>
            <p className="muted">
              Release notes for OpenMasjid Display{version ? `, up to the v${version} you’re running` : ''}.
            </p>
          </div>
        </div>

        <div className="modal-body">
          {err && <p className="form-error">{err}</p>}
          {!releases && !err && <p className="muted">Loading…</p>}
          {releases?.length === 0 && <p className="muted">No release notes shipped with this build.</p>}
          {releases?.map((r) => {
            const current = normalise(r.version) === normalise(version);
            return (
              <section className="wn-release" key={r.version}>
                <h4 className="wn-version">
                  {r.version}
                  {current && <span className="pill pill--ok">You’re on this</span>}
                </h4>
                <ul className="wn-list">
                  {r.items.map((it, i) => (
                    <li key={i}>{inline(it)}</li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
