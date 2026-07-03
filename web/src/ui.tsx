// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import markUrl from './assets/mark.png';

/** Copy text to the clipboard, with a fallback for non-secure contexts (plain HTTP
 *  over a LAN IP): navigator.clipboard only exists in a secure context, so fall back
 *  to a hidden <textarea> + execCommand('copy'). Rejects if both paths fail, so the
 *  caller can show an error. */
export function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy failed'));
    } catch (e) {
      reject(e instanceof Error ? e : new Error('copy failed'));
    }
  });
}

/* ── Icons (simple stroke set, lucide-flavoured) ─────────────────────────── */
type IP = { size?: number };
function Svg({ size = 18, children }: IP & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
export const IconScreen = (p: IP) => <Svg {...p}><rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></Svg>;
export const IconCamera = (p: IP) => <Svg {...p}><path d="M2 7a2 2 0 0 1 2-2h2l1.5-2h5L14 5h2a2 2 0 0 1 2 2v3l4-2v8l-4-2v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z" /><circle cx="9" cy="12" r="3" /></Svg>;
export const IconCast = (p: IP) => <Svg {...p}><path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" /><path d="M2 12a6 6 0 0 1 6 6M2 16a2 2 0 0 1 2 2" /><circle cx="3" cy="19" r="0.6" fill="currentColor" /></Svg>;
export const IconClock = (p: IP) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
export const IconCalendar = (p: IP) => <Svg {...p}><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4M12 13v4l2.5 1.5" /></Svg>;
// A clean, solid gear (Material-style) — crisp at small sizes, matches OpenMasjidOS.
export const IconCog = ({ size = 18 }: IP) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65A.488.488 0 0 0 14.13 2h-4c-.24 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46c-.12.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.25.42.49.42h4c.24 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.22.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" />
  </svg>
);
export const IconPlus = (p: IP) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const IconTrash = (p: IP) => <Svg {...p}><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" /></Svg>;
export const IconEdit = (p: IP) => <Svg {...p}><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></Svg>;
export const IconX = (p: IP) => <Svg {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>;
export const IconCopy = (p: IP) => <Svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Svg>;
export const IconCheck = (p: IP) => <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>;
export const IconPower = (p: IP) => <Svg {...p}><path d="M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0" /></Svg>;
export const IconMoon = (p: IP) => <Svg {...p}><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" /></Svg>;
export const IconSun = (p: IP) => <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>;
export const IconWarn = (p: IP) => <Svg {...p}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></Svg>;
export const IconRefresh = (p: IP) => <Svg {...p}><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" /></Svg>;
export const IconUser = (p: IP) => <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Svg>;
export const IconExpand = (p: IP) => <Svg {...p}><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /></Svg>;
export const IconShrink = (p: IP) => <Svg {...p}><path d="M4 8h3a1 1 0 0 0 1-1V4M20 8h-3a1 1 0 0 1-1-1V4M4 16h3a1 1 0 0 1 1 1v3M20 16h-3a1 1 0 0 1-1 1v3" /></Svg>;

/** OpenMasjid crescent + dome brand mark. Rendered as a CSS mask painted in
 *  `currentColor`, so it adapts to light/dark themes and stays crisp at any size. */
export function MasjidMark({ size = 26 }: IP) {
  return (
    <span
      className="masjid-mark"
      aria-hidden="true"
      style={{ width: size, height: size, maskImage: `url(${markUrl})`, WebkitMaskImage: `url(${markUrl})` }}
    />
  );
}

/* ── Toggle ──────────────────────────────────────────────────────────────── */
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label}
      className={`toggle${checked ? ' is-on' : ''}`} onClick={() => onChange(!checked)} />
  );
}

/* ── Help (?) tooltip ────────────────────────────────────────────────────── */
/** A small “?” badge that reveals an explanation on hover/focus (and long-press on
 *  touch). Keeps the form uncluttered while making help discoverable on every setting. */
export function Help({ text }: { text: string }) {
  return (
    <span className="help" tabIndex={0} role="note" aria-label={text} data-tip={text}>
      ?
    </span>
  );
}

/* ── Field ───────────────────────────────────────────────────────────────── */
// `hint` renders as a “?” tooltip beside the label (keeps rows tidy). Pass `inlineHint`
// to instead show it as a line under the control (for longer, always-visible notes).
export function Field({ label, hint, inlineHint, children }: { label: string; hint?: string; inlineHint?: boolean; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}{hint && !inlineHint && <Help text={hint} />}</span>
      {children}
      {hint && inlineHint && <span className="hint">{hint}</span>}
    </label>
  );
}

/* ── Modal ───────────────────────────────────────────────────────────────── */
// `windowed` dialogs (settings / editors) get macOS-style window controls and can
// be maximized; plain dialogs (confirmations like "Remove screen?") get a simple
// header with a close button. Nothing minimizes to the dock.
export function Modal({ open, onClose, title, children, footer, wide, windowed }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean; windowed?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (open) setMaximized(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab' && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        );
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop">
      <div
        ref={ref}
        tabIndex={-1}
        className={`modal glass-raised${wide ? ' modal--wide' : ''}${maximized ? ' modal--max' : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className={`modal-head${windowed ? ' modal-head--win' : ''}`}>
          {windowed ? (
            <>
              <div className="traffic" role="group" aria-label="Window controls">
                <button className="tl tl--close" onClick={onClose} aria-label="Close" title="Close" />
                <button className="tl tl--max" onClick={() => setMaximized((v) => !v)} aria-label={maximized ? 'Restore size' : 'Maximize'} title={maximized ? 'Restore size' : 'Maximize'} />
              </div>
              <h2 className="modal-title">{title}</h2>
              <span className="spacer" />
            </>
          ) : (
            <>
              <h2 className="modal-title">{title}</h2>
              <span className="spacer" />
              <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close"><IconX size={18} /></button>
            </>
          )}
        </div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

/* ── Toasts ──────────────────────────────────────────────────────────────── */
type Kind = 'success' | 'error';
interface ToastItem { id: number; msg: string; kind: Kind; }
const ToastCtx = createContext<(msg: string, kind?: Kind) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((msg: string, kind: Kind = 'success') => {
    const id = Date.now() + Math.random();
    setItems((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setItems((t) => t.filter((x) => x.id !== id)), 3600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {items.map((t) => (
          <div key={t.id} className={`toast glass-raised toast--${t.kind}`}>{t.msg}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
