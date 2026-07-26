// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useState } from 'react';
import { api } from '../api';
import type { AppState, Tv, ContentRef, TvStatus, PiNode } from '../types';
import { contentOptions, ContentPicker, contentLabel } from '../content';
import {
  Modal,
  Field,
  Spinner,
  IconScreen,
  IconCast,
  IconPlus,
  IconEdit,
  IconTrash,
  IconCopy,
  IconCheck,
  IconRefresh,
  IconPower,
  IconWarn,
  MasjidMark,
  copyText,
  useToast,
} from '../ui';

/** Where a masjid downloads the Pi node card image. Release assets are attached to the
 *  tag by .github/workflows/image.yml (see docs/PI_NODE_SPEC.md §7). */
const IMAGE_RELEASES_URL = 'https://github.com/OpenMasjid-Solutions/OpenMasjidDisplay/releases/latest';

/** "3 minutes ago" for a heartbeat timestamp; '' when never seen. */
function sinceLabel(ms: number, now: number): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

interface Props {
  state: AppState;
  refetch: () => Promise<void>;
}

export function Screens({ state, refetch }: Props) {
  const toast = useToast();
  const [edit, setEdit] = useState<Tv | 'new' | null>(null);
  const [confirm, setConfirm] = useState<Tv | null>(null);
  /** null = closed; 'choose' = pick a screen kind; 'node' = the Pi node adopt flow. */
  const [adding, setAdding] = useState<null | 'choose' | 'node'>(null);
  const [drawer, setDrawer] = useState<PiNode | null>(null);
  const options = contentOptions(state);
  const statusById = new Map<string, TvStatus>(state.statuses.map((s) => [s.tvId, s]));
  const nodeById = new Map<string, PiNode>((state.nodes ?? []).map((n) => [n.id, n]));
  const piNodes = state.settings.piNodes;

  // With Pi nodes off there is only one kind of screen, so skip the chooser entirely —
  // an extra click for a choice that does not exist would be worse than no feature.
  const startAdd = () => (piNodes ? setAdding('choose') : setEdit('new'));

  const setContent = async (tv: Tv, content: ContentRef) => {
    try {
      await api.setTv(tv.id, content, null);
      await refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not switch the screen.', 'error');
    }
  };
  const resume = async (tv: Tv) => {
    try {
      await api.resumeTv(tv.id);
      await refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update the screen.', 'error');
    }
  };
  const remove = async (tv: Tv) => {
    try {
      await api.deleteTv(tv.id);
      setConfirm(null);
      await refetch();
      toast('Screen removed.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove the screen.', 'error');
    }
  };

  return (
    <div>
      <div className="page-head row-between">
        <div>
          <h1 className="page-title">Screens</h1>
          <p className="page-sub">Choose what each screen shows. Changes happen within a few seconds.</p>
        </div>
        <button className="btn btn--primary" onClick={startAdd}>
          <IconPlus size={16} /> Add screen
        </button>
      </div>

      {state.tvs.length === 0 ? (
        <div className="empty-state glass" style={{ borderRadius: 'var(--radius-card)' }}>
          <div className="empty-art"><MasjidMark size={64} /></div>
          <h3>No screens yet</h3>
          <p>Add a screen for each TV. You'll get a link to put into its RTSP decoder.</p>
          <button className="btn btn--primary" style={{ marginTop: '1rem' }} onClick={startAdd}>
            <IconPlus size={16} /> Add your first screen
          </button>
        </div>
      ) : (
        <div className="screens-grid">
          {state.tvs.map((tv) => (
            <ScreenCard
              key={tv.id}
              tv={tv}
              status={statusById.get(tv.id)}
              node={tv.nodeId ? nodeById.get(tv.nodeId) : undefined}
              state={state}
              options={options}
              onSet={(c) => setContent(tv, c)}
              onResume={() => resume(tv)}
              onEdit={() => setEdit(tv)}
              onDelete={() => setConfirm(tv)}
              onCopy={(url) => copyText(url).then(() => toast('Link copied.'))}
              onOpenNode={(n) => setDrawer(n)}
            />
          ))}
        </div>
      )}

      {edit && (
        <TvModal
          tv={edit === 'new' ? null : edit}
          options={options}
          onClose={() => setEdit(null)}
          onSaved={async () => {
            setEdit(null);
            await refetch();
          }}
        />
      )}

      <Modal
        open={adding === 'choose'}
        windowed
        onClose={() => setAdding(null)}
        title="What kind of screen?"
        footer={<button className="btn" onClick={() => setAdding(null)}>Cancel</button>}
      >
        <div className="kind-choice">
          <button className="kind-card glass-inset" onClick={() => { setAdding(null); setEdit('new'); }}>
            <IconCast size={22} />
            <span className="kind-card__title">RTSP decoder box</span>
            <span className="kind-card__sub">
              The original setup: you get a video link to paste into a decoder box plugged into the TV.
              Works with any decoder, and this server does the video work for it.
            </span>
          </button>
          <button className="kind-card glass-inset" onClick={() => setAdding('node')}>
            <IconScreen size={22} />
            <span className="kind-card__title">
              OpenMasjid Pi node <span className="tag tag--cam">New</span>
            </span>
            <span className="kind-card__sub">
              A small Raspberry Pi running our card, plugged straight into the TV's HDMI port. It draws
              the timetable itself and plays cameras directly, so this server does no video work.
            </span>
          </button>
        </div>
      </Modal>

      {adding === 'node' && (
        <AdoptNodeModal
          onClose={() => setAdding(null)}
          onAdopted={async () => {
            setAdding(null);
            await refetch();
          }}
        />
      )}

      {drawer && (
        <NodeDrawer
          node={drawer}
          serverNow={state.serverNow}
          screen={state.tvs.find((t) => t.nodeId === drawer.id)}
          onClose={() => setDrawer(null)}
          onChanged={refetch}
        />
      )}

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={`Remove ${confirm?.name ?? 'screen'}?`}
        footer={
          <>
            <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn btn--danger" onClick={() => confirm && remove(confirm)}>Remove screen</button>
          </>
        }
      >
        <p className="muted">The screen's link will stop working. Timetables and sources are not affected.</p>
      </Modal>
    </div>
  );
}

function ScreenCard({
  tv,
  status,
  node,
  state,
  options,
  onSet,
  onResume,
  onEdit,
  onDelete,
  onCopy,
  onOpenNode,
}: {
  tv: Tv;
  status?: TvStatus;
  node?: PiNode;
  state: AppState;
  options: ReturnType<typeof contentOptions>;
  onSet: (c: ContentRef) => void;
  onResume: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopy: (url: string) => void;
  onOpenNode: (n: PiNode) => void;
}) {
  const [copied, setCopied] = useState(false);
  const effective = status?.effective ?? tv.defaultContent;
  const ready = status?.streamReady ?? false;
  const isNode = tv.kind === 'node';
  // The link uses whatever address this panel was opened with — the same address
  // a decoder on the network reaches this server at. Nothing to configure.
  const url = `rtsp://${location.hostname}:${state.rtsp.port}/${tv.id}`;
  const localHost = /^(localhost|127\.|0\.0\.0\.0|::1|\[)/.test(location.hostname);
  const sourceTag =
    status?.source === 'override' ? 'Manual' : status?.source === 'schedule' ? 'Scheduled' : 'Default';

  return (
    <div className="screen-card glass">
      <div className="screen-card__head">
        <span className={`status-dot${ready ? '' : ' status-dot--idle'}`} title={ready ? 'A screen is connected' : 'No screen connected yet'} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="screen-name">
            {tv.name}
            {isNode && (
              <span
                className="tag tag--cam"
                style={{ marginInlineStart: '0.5rem' }}
                title="Driven by an OpenMasjid Pi node plugged into the TV. This server does no video work for it."
              >
                Pi node
              </span>
            )}
            {effective.kind !== 'off' && !ready && (
              <span
                className="tag"
                style={{ marginInlineStart: '0.5rem', background: 'rgba(229,115,107,0.16)', color: '#e5736b' }}
                title={
                  isNode
                    ? 'This Pi node hasn’t checked in recently — it may be powered off or off the network.'
                    : 'This screen isn’t pulling its stream — the screen or its decoder may be off or disconnected.'
                }
              >
                Offline
              </span>
            )}
          </div>
          {tv.room && <div className="screen-room">{tv.room}</div>}
        </div>
        <button className="icon-btn" aria-label="Edit screen" onClick={onEdit}><IconEdit size={16} /></button>
        <button className="icon-btn" aria-label="Remove screen" onClick={onDelete}><IconTrash size={16} /></button>
      </div>

      <div className="screen-now glass-inset">
        <IconScreen size={16} />
        <span className="screen-now__label">{contentLabel(effective, state)}</span>
        <span className={`tag screen-now__src ${status?.source === 'schedule' ? 'tag--hdmi' : 'tag--cam'}`}>{sourceTag}</span>
      </div>

      <ContentPicker options={options} value={effective} onChange={onSet} />

      {status?.source === 'override' && (
        <button className="btn btn--ghost btn--sm" onClick={onResume}>
          <IconRefresh size={14} /> Back to schedule
        </button>
      )}

      {/* A Pi node has no decoder to configure, so the RTSP link is meaningless for it —
          show what the box is doing instead, with the way in to its controls. */}
      {isNode ? (
        node ? (
          <div className="rtsp-box">
            <span className="rtsp-url" title={`${node.model || 'Pi node'} · ${node.serial}`}>
              {node.ip || 'address unknown'} · firmware {node.fw}
              {node.health?.tempC != null && ` · ${Math.round(node.health.tempC)}°C`}
              {` · seen ${sinceLabel(node.lastSeen, state.serverNow)}`}
            </span>
            <button className="btn btn--ghost btn--sm" onClick={() => onOpenNode(node)}>
              <IconScreen size={14} /> Node
            </button>
          </div>
        ) : (
          <div className="hint">
            <IconWarn size={14} /> This screen is set up as a Pi node but its node record is missing.
            Remove the screen and adopt the node again.
          </div>
        )
      ) : (
        <>
          <div className="rtsp-box">
            <span className="rtsp-url" title={url}>{url}</span>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => {
                onCopy(url);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />} {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
          {localHost && (
            <div className="hint">
              You're viewing this on the server itself — open this panel from another device using this
              server's network address, and the link will use that address for your screens.
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Adopt a Pi node by the address it is showing on the TV (the UniFi model).
 *
 * Two steps on purpose: "Check" confirms we are talking to an unadopted node and shows the
 * admin the serial and model, so pairing the wrong box in a hall full of TVs is caught
 * before a token is minted rather than after.
 */
function AdoptNodeModal({ onClose, onAdopted }: { onClose: () => void; onAdopted: () => void }) {
  const toast = useToast();
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ serial: string; model: string; fw: string; adopted: boolean } | null>(null);
  const [error, setError] = useState('');

  const check = async () => {
    setBusy(true);
    setError('');
    setFound(null);
    try {
      const r = await api.probeNode(address.trim());
      setFound(r);
      if (r.adopted) setError('That node is already set up. Factory-reset it first (see the setup guide).');
      else if (!name.trim()) setName(`Screen ${r.serial.slice(-4)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach that address.');
    } finally {
      setBusy(false);
    }
  };

  const adopt = async () => {
    setBusy(true);
    setError('');
    try {
      await api.adoptNode(address.trim(), name.trim() || undefined);
      toast('Pi node added. It will show the timetable in a few seconds.');
      onAdopted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that node.');
      setBusy(false);
    }
  };

  const canAdopt = !!found && !found.adopted && !busy;

  return (
    <Modal
      open
      windowed
      onClose={onClose}
      title="Add a Pi node"
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          {found && !found.adopted ? (
            <button className="btn btn--primary" onClick={adopt} disabled={!canAdopt}>
              {busy ? <Spinner /> : 'Add this screen'}
            </button>
          ) : (
            <button className="btn btn--primary" onClick={check} disabled={busy || address.trim().length < 3}>
              {busy ? <Spinner /> : 'Check'}
            </button>
          )}
        </>
      }
    >
      <ol className="steps">
        <li>
          <strong>Write the card.</strong> Download the OpenMasjid node image and write it to a microSD
          card with <a href="https://etcher.balena.io/" target="_blank" rel="noreferrer noopener">Balena Etcher</a>.
          <div style={{ marginBlockStart: '0.4rem' }}>
            <a className="btn btn--ghost btn--sm" href={IMAGE_RELEASES_URL} target="_blank" rel="noreferrer noopener">
              Download the node image
            </a>
          </div>
        </li>
        <li>
          <strong>Plug it in.</strong> Card into the Pi, Pi into the TV's HDMI port, then power. If it has
          no network cable it will offer a Wi-Fi setup page — join <em>OpenMasjid-Node-…</em> and pick your
          Wi-Fi.
        </li>
        <li>
          <strong>Read the address off the TV</strong> and type it here.
        </li>
      </ol>

      <Field label="Address shown on the screen" hint="For example 192.168.1.40, or omd-node-1a2b.local">
        <input
          className="input"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            setFound(null);
            setError('');
          }}
          placeholder="192.168.1.40"
          autoFocus
        />
      </Field>

      {found && (
        <div className="glass-inset" style={{ padding: '0.7rem 0.9rem', borderRadius: 'var(--radius-card)', marginBlockEnd: '0.8rem' }}>
          <div><strong>{found.model || 'Raspberry Pi'}</strong></div>
          <div className="muted">Serial {found.serial} · firmware {found.fw}</div>
        </div>
      )}

      {found && !found.adopted && (
        <Field label="Screen name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Main hall TV" />
        </Field>
      )}

      {error && (
        <div className="hint" style={{ color: '#e5736b' }}>
          <IconWarn size={14} /> {error}
        </div>
      )}
      <p className="hint">
        Adoption happens over your local network and only once — after that the node talks to this server
        on its own, and nothing else on the network can reconfigure it.
      </p>
    </Modal>
  );
}

/** Details and live controls for one adopted node. */
function NodeDrawer({
  node,
  screen,
  serverNow,
  onClose,
  onChanged,
}: {
  node: PiNode;
  screen?: Tv;
  serverNow: number;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [name, setName] = useState(node.name);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      toast(label);
      await onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That did not work.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const rows: [string, string][] = [
    ['Model', node.model || '—'],
    ['Serial', node.serial],
    ['Firmware', node.fw],
    ['Address', node.ip || '—'],
    ['Last seen', sinceLabel(node.lastSeen, serverNow)],
    ['Temperature', node.health?.tempC != null ? `${Math.round(node.health.tempC)} °C` : '—'],
    ['Free memory', node.health?.memFreeMb != null ? `${node.health.memFreeMb} MB` : '—'],
    ['Wi-Fi signal', node.health?.wifiRssi != null ? `${node.health.wifiRssi} dBm` : 'wired or unknown'],
    ['Can decode', node.caps.codecs.length ? node.caps.codecs.join(', ').toUpperCase() : '—'],
  ];

  // The removal confirmation is a STATE OF THIS PANEL, not a second Modal on top of it.
  // Modal binds Escape and its Tab trap to `window`, so a nested one would close both
  // dialogs on a single Escape and the two focus traps would fight over the same DOM.
  return (
    <Modal
      open
      windowed
      onClose={onClose}
      title={confirmRemove ? `Remove ${node.name}?` : screen ? `${screen.name} · Pi node` : 'Pi node'}
      footer={
        confirmRemove ? (
          <>
            <button className="btn" onClick={() => setConfirmRemove(false)} disabled={busy}>Cancel</button>
            <button
              className="btn btn--danger"
              disabled={busy}
              onClick={() =>
                run('Node removed.', async () => {
                  await api.deleteNode(node.id);
                  onClose();
                })
              }
            >
              {busy ? <Spinner /> : 'Remove node'}
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={onClose}>Close</button>
            <button className="btn btn--danger" onClick={() => setConfirmRemove(true)} disabled={busy}>
              Remove node
            </button>
          </>
        )
      }
    >
      {confirmRemove ? (
        <p className="muted">
          The Pi wipes its settings and goes back to waiting to be set up. The screen itself stays, and
          reverts to needing an RTSP decoder — so your schedules keep working. If the Pi is powered off it
          cannot be told to wipe, so reset it by hand (see the setup guide).
        </p>
      ) : (
        <>
          <Field label="Node name" hint="Just a label for this box — the screen keeps its own name.">
            <div className="row" style={{ gap: '0.5rem' }}>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              <button
                className="btn btn--ghost btn--sm"
                disabled={busy || !name.trim() || name.trim() === node.name}
                onClick={() => run('Node renamed.', () => api.renameNode(node.id, name.trim()))}
              >
                Save
              </button>
            </div>
          </Field>

          <div className="kv-list">
            {rows.map(([k, v]) => (
              <div className="kv-row" key={k}>
                <span className="kv-key">{k}</span>
                <span className="kv-val">{v}</span>
              </div>
            ))}
          </div>

          <div className="row" style={{ gap: '0.5rem', marginBlockStart: '0.9rem', flexWrap: 'wrap' }}>
            <button
              className="btn btn--ghost btn--sm"
              disabled={busy}
              onClick={() => run('Showing its name on the screen.', () => api.identifyNode(node.id, 30))}
            >
              <IconScreen size={14} /> Identify
            </button>
            <button
              className="btn btn--ghost btn--sm"
              disabled={busy}
              onClick={() => run('Rebooting.', () => api.rebootNode(node.id))}
            >
              <IconPower size={14} /> Reboot
            </button>
          </div>
          <p className="hint">
            Identify shows this node's name and address big on its TV for 30 seconds — handy for working out
            which box drives which screen.
          </p>
        </>
      )}
    </Modal>
  );
}

function TvModal({
  tv,
  options,
  onClose,
  onSaved,
}: {
  tv: Tv | null;
  options: ReturnType<typeof contentOptions>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(tv?.name ?? '');
  const [room, setRoom] = useState(tv?.room ?? '');
  const [content, setContent] = useState<ContentRef>(tv?.defaultContent ?? { kind: 'off' });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const body = { name: name.trim() || 'Screen', room: room.trim(), defaultContent: content };
      if (tv) await api.updateTv(tv.id, body);
      else await api.createTv(body);
      onSaved();
      toast(tv ? 'Screen updated.' : 'Screen added.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save.', 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      windowed
      onClose={onClose}
      title={tv ? 'Edit screen' : 'Add a screen'}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save} disabled={busy}>{tv ? 'Save' : 'Add screen'}</button>
        </>
      }
    >
      <div className="grid2">
        <Field label="Screen name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Main hall TV" /></Field>
        <Field label="Room (optional)"><input className="input" value={room} onChange={(e) => setRoom(e.target.value)} placeholder="Main hall" /></Field>
      </div>
      <Field label="Normally shows" hint="What this screen returns to when no schedule or manual choice applies.">
        <ContentPicker options={options} value={content} onChange={setContent} />
      </Field>
    </Modal>
  );
}
