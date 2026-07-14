// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import type { AppState, Timetable, TimetableLayout, IqamahRule, IqamahConfig, IqamahYear, Hotspot, Announcements, Ticker, TickerMessage, SalahHadith, SalahBlackout, HadithItem, ProhibitedNotice, IqamahCountdown, IqamahChangeNotice, AdhanOffsets, AdhanPopup, TimetableWidget } from '../types';
import { Modal, Field, Toggle, Spinner, IconPlus, IconEdit, IconTrash, IconCopy, IconClock, IconExpand, IconCalendar, copyText, useToast } from '../ui';
import { timezoneOptions } from '../timezones';
import { readImageForUpload } from '../image';

interface Props {
  state: AppState;
  refetch: () => Promise<void>;
}

const METHODS = ['MWL', 'ISNA', 'Egypt', 'Makkah', 'Karachi', 'Custom'] as const;
export function Timetables({ state, refetch }: Props) {
  const toast = useToast();
  const [confirm, setConfirm] = useState<Timetable | null>(null);
  const [tick, setTick] = useState(0);
  const [creating, setCreating] = useState(false);

  // Editing opens the full-screen editor in a new browser tab (?edit=<id>).
  const openEditor = (id: string) => window.open(`${window.location.pathname}?edit=${id}`, '_blank');
  const createNew = async () => {
    setCreating(true);
    try {
      const created = await api.createTimetable(formBody(toForm(null, state)));
      await refetch();
      setTick((n) => n + 1);
      openEditor(created.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the timetable.', 'error');
    } finally {
      setCreating(false);
    }
  };

  // Refresh the card previews periodically.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 20000);
    return () => clearInterval(t);
  }, []);

  const remove = async (tt: Timetable) => {
    try {
      await api.deleteTimetable(tt.id);
      setConfirm(null);
      await refetch();
      toast('Timetable removed.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove the timetable.', 'error');
    }
  };

  const [dupId, setDupId] = useState<string | null>(null);
  const duplicate = async (tt: Timetable) => {
    setDupId(tt.id);
    try {
      const copy = await api.duplicateTimetable(tt.id);
      await refetch();
      setTick((n) => n + 1);
      toast('Duplicated — opening the copy to edit.');
      openEditor(copy.id); // jump straight into the copy so the small tweak is one step
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not duplicate the timetable.', 'error');
    } finally {
      setDupId(null);
    }
  };

  return (
    <div>
      <div className="page-head row-between">
        <div>
          <h1 className="page-title">Timetables</h1>
          <p className="page-sub">Design a prayer display for each look you need. Open one to edit it live.</p>
        </div>
        <button className="btn btn--primary" disabled={creating} onClick={createNew}>{creating ? <Spinner /> : <IconPlus size={16} />} New timetable</button>
      </div>

      <div className="screens-grid">
        {state.timetables.map((tt) => (
          <div key={tt.id} className="screen-card glass">
            <PreviewImg
              src={`/api/preview/${tt.id}?v=${tick}`}
              portrait={tt.orientation === 'portrait'}
              alt={`Preview of ${tt.name}`}
            />
            <div className="row-between">
              <div style={{ minWidth: 0 }}>
                <div className="screen-name">{tt.name}</div>
                <div className="screen-room">
                  {tt.latitude == null || tt.longitude == null ? 'Location needed' : `${tt.method} · Asr ${tt.asrMadhab}`}
                </div>
              </div>
              <div className="row" style={{ gap: '0.2rem' }}>
                <button className="icon-btn" aria-label="Edit" title="Edit (opens in a new tab)" onClick={() => openEditor(tt.id)}><IconEdit size={16} /></button>
                <button className="icon-btn" aria-label="Duplicate" title="Duplicate" disabled={dupId === tt.id} onClick={() => duplicate(tt)}>{dupId === tt.id ? <Spinner /> : <IconCopy size={16} />}</button>
                <button className="icon-btn" aria-label="Delete" onClick={() => setConfirm(tt)}><IconTrash size={16} /></button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={`Delete ${confirm?.name ?? 'timetable'}?`}
        footer={
          <>
            <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn btn--danger" onClick={() => confirm && remove(confirm)}>Delete</button>
          </>
        }
      >
        <p className="muted">Any screen set to this timetable will show nothing until you pick another.</p>
      </Modal>
    </div>
  );
}

type Form = Omit<Timetable, 'latitude' | 'longitude'> & { latitude: string; longitude: string };

function toForm(tt: Timetable | null, state: AppState): Form {
  if (tt) {
    return { ...tt, latitude: tt.latitude == null ? '' : String(tt.latitude), longitude: tt.longitude == null ? '' : String(tt.longitude) };
  }
  return {
    id: '', name: 'New timetable', themeId: 'emerald', accent: undefined, textColor: '',
    orientation: 'landscape', quality: state.settings.defaultQuality, layout: 'centered', layoutCarousel: false,
    masjidName: state.timetables[0]?.masjidName ?? 'Our Masjid',
    location: '',
    latitude: '', longitude: '',
    method: 'MWL', fajrAngle: 18, ishaAngle: 17, asrMadhab: 'Hanafi', timezone: state.settings.scheduleTimezone ?? '',
    timeFormat: '12h', language: 'en', hijriOffset: 0, gregorianOffset: 0,
    iqamah: { fajr: { mode: 'offset', offset: 20 }, dhuhr: { mode: 'offset', offset: 10 }, asr: { mode: 'offset', offset: 10 }, maghrib: { mode: 'offset', offset: 5 }, isha: { mode: 'offset', offset: 10 } },
    jumuah: ['13:30'], showSunrise: true, showCountdown: true, showDates: true, showLogo: true, showSeconds: false, showFooter: true, showCelestial: true, showName: true,
    backgroundImage: '', logoImage: '', footerNote: '', tickerSpeed: 5, createdAt: '',
  };
}

/** Form (with string lat/long) → a timetable body for save/preview. */
function formBody(f: Form): Partial<Timetable> {
  return {
    ...f,
    latitude: f.latitude.trim() === '' ? null : Number(f.latitude),
    longitude: f.longitude.trim() === '' ? null : Number(f.longitude),
  } as Partial<Timetable>;
}

type EditorTab = 'general' | 'salah' | 'appearance' | 'during' | 'announce' | 'sharing';

// `fullPage` is accepted (App passes it) but the editor is now always a full-page layout.
export function TimetableEditor({ state, tt, onClose, onSaved }: { state: AppState; tt: Timetable | null; onClose: () => void; onSaved: () => void; fullPage?: boolean }) {
  const toast = useToast();
  const [f, setF] = useState<Form>(() => toForm(tt, state));
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<EditorTab>(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return (['general', 'salah', 'appearance', 'during', 'announce', 'sharing'] as const).includes(t as EditorTab) ? (t as EditorTab) : 'general';
  });
  const [previewOpen, setPreviewOpen] = useState(true);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));

  // The screens rotate the layout every 5 min when "Rotate layouts" is on; in the
  // editor we can't wait 5 min, so cycle the preview through the three layouts
  // quickly so you can see what it'll do. (The live display still uses the 15-min clock.)
  const CAROUSEL_LAYOUTS: TimetableLayout[] = ['centered', 'clockTop', 'split'];
  const [demoIdx, setDemoIdx] = useState(0);
  useEffect(() => {
    if (!f.layoutCarousel) return;
    const t = setInterval(() => setDemoIdx((i) => (i + 1) % CAROUSEL_LAYOUTS.length), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.layoutCarousel]);
  const previewBody = f.layoutCarousel
    ? { ...formBody(f), layout: CAROUSEL_LAYOUTS[demoIdx], layoutCarousel: false }
    : formBody(f);

  const themePrimary = state.themes.find((t) => t.id === f.themeId)?.palette.primary ?? '#22D3EE';
  const themeGold = state.themes.find((t) => t.id === f.themeId)?.palette.gold ?? '#D4AF37';

  const save = async () => {
    setBusy(true);
    try {
      const body = formBody(f);
      if (tt) await api.updateTimetable(tt.id, body);
      else await api.createTimetable(body);
      onSaved();
      toast(tt ? 'Timetable saved.' : 'Timetable created.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save.', 'error');
    } finally {
      // Always clear busy — in the full-page editor there's no unmount to rely on,
      // so the Save button would otherwise stay disabled after the first save.
      setBusy(false);
    }
  };

  const pickBackground = (file: File) => {
    if (!tt) return;
    readImageForUpload(file, 1920)
      .then(async (dataUrl) => {
        const updated = await api.uploadBackground(tt.id, dataUrl);
        set('backgroundImage', updated.backgroundImage);
        toast('Background updated.');
      })
      .catch((e) => toast(e instanceof Error ? e.message : 'Could not upload the image.', 'error'));
  };
  const clearBackground = async () => {
    if (!tt) return;
    try {
      await api.removeBackground(tt.id);
      set('backgroundImage', '');
      toast('Background removed.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove the background.', 'error');
    }
  };

  const pickLogo = (file: File) => {
    if (!tt) return;
    readImageForUpload(file, 1024)
      .then(async (dataUrl) => {
        const updated = await api.uploadLogo(tt.id, dataUrl);
        set('logoImage', updated.logoImage);
        toast('Logo updated.');
      })
      .catch((e) => toast(e instanceof Error ? e.message : 'Could not upload the logo.', 'error'));
  };
  const clearLogo = async () => {
    if (!tt) return;
    try {
      await api.removeLogo(tt.id);
      set('logoImage', '');
      toast('Logo removed.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove the logo.', 'error');
    }
  };

  // Click-to-edit in the live preview: rename a prayer, the masjid name or footer.
  const editLabel = (id: string, value: string) => {
    if (id === 'masjidName') set('masjidName', value || 'Our Masjid');
    else if (id === 'location') set('location', value);
    else if (id === 'footerNote') set('footerNote', value);
    else if (id.startsWith('label.')) {
      const key = id.slice(6);
      setF((p) => {
        const labels = { ...(p.labels ?? {}) };
        const v = value.trim();
        if (v) labels[key] = v;
        else delete labels[key];
        return { ...p, labels: Object.keys(labels).length ? labels : undefined };
      });
    }
  };

  // The per-day Iqamah overrides — ONE map keyed "MM-DD", shared by the one-off "Add a
  // date" editor, the monthly table and CSV import/export so none clobbers another. Managed
  // only via the dedicated iqamah endpoints (the normal form save never touches iqamahYear).
  const [iqYear, setIqYear] = useState<IqamahYear>(() => JSON.parse(JSON.stringify(tt?.iqamahYear ?? {})));
  const iqCount = Object.keys(iqYear).length;
  const csvActive = iqCount > 0; // any per-day overrides win over the per-prayer rules
  const [showTable, setShowTable] = useState(false);
  // Persist the whole map (used by the one-off editor and the monthly table).
  const saveIqYear = async (next: IqamahYear) => {
    if (!tt) return;
    await api.saveIqamahYear(tt.id, next);
    setIqYear(next);
  };
  const importCsv = (file: File) => {
    if (!tt) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const r = await api.importIqamahCsv(tt.id, String(reader.result));
        setIqYear(r.data);
        toast(`Imported Iqamah times for ${r.rows} day${r.rows === 1 ? '' : 's'}.`);
        if (r.errors.length) toast(`${r.errors.length} line(s) were skipped.`, 'error');
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Could not read that CSV.', 'error');
      }
    };
    reader.onerror = () => toast('Could not read that file.', 'error');
    reader.readAsText(file);
  };
  const clearCsv = async () => {
    if (!tt) return;
    try {
      await api.clearIqamahCsv(tt.id);
      setIqYear({});
      toast('Reverted to your Iqamah rules.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not clear the CSV.', 'error');
    }
  };

  // ── Announcement slideshow + ticker (local form state; images via endpoints) ──
  const ann: Announcements = f.announcements ?? { enabled: false, images: [], start: '', end: '', everySeconds: 60, forSeconds: 20, imageSeconds: 8 };
  const setAnn = (patch: Partial<Announcements>) => set('announcements', { ...ann, ...patch });
  const addAnnImage = (file: File) => {
    if (!tt) return;
    readImageForUpload(file, 1920)
      .then(async (dataUrl) => {
        const u = await api.uploadAnnouncement(tt.id, dataUrl);
        setAnn({ images: u.announcements?.images ?? ann.images });
        toast('Image added.');
      })
      .catch((e) => toast(e instanceof Error ? e.message : 'Could not upload the image.', 'error'));
  };
  const removeAnnImage = async (fileName: string) => {
    if (!tt) return;
    try {
      const u = await api.removeAnnouncement(tt.id, fileName);
      setAnn({ images: u.announcements?.images ?? ann.images.filter((x) => x !== fileName) });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove the image.', 'error');
    }
  };

  const tk: Ticker = f.ticker ?? { enabled: false, messages: [] };
  const setTk = (patch: Partial<Ticker>) => set('ticker', { ...tk, ...patch });
  const addMsg = () => setTk({ messages: [...tk.messages, { id: `m${Date.now()}`, text: '', start: '', end: '' }] });
  const setMsg = (i: number, patch: Partial<TickerMessage>) => setTk({ messages: tk.messages.map((mm, j) => (j === i ? { ...mm, ...patch } : mm)) });
  const delMsg = (i: number) => setTk({ messages: tk.messages.filter((_, j) => j !== i) });

  // ── During-salah hadith + prohibited-time notice + pre-Iqamah countdown ──
  const sh: SalahHadith = f.salahHadith ?? { enabled: false, minutes: 10, items: [] };
  const setSh = (patch: Partial<SalahHadith>) => set('salahHadith', { ...sh, ...patch });
  const addHadith = () => setSh({ items: [...sh.items, { ar: '', en: '' }] });
  const setHadith = (i: number, patch: Partial<HadithItem>) => setSh({ items: sh.items.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const delHadith = (i: number) => setSh({ items: sh.items.filter((_, j) => j !== i) });
  // Built-in ahadith: all on unless their id is in disabledDefaults.
  const disabledDefaults = sh.disabledDefaults ?? [];
  const defaultOn = (id: string) => !disabledDefaults.includes(id);
  const toggleDefault = (id: string, on: boolean) =>
    setSh({ disabledDefaults: on ? disabledDefaults.filter((x) => x !== id) : [...disabledDefaults, id] });
  const setAllDefaults = (on: boolean) =>
    setSh({ disabledDefaults: on ? [] : state.hadithDefaults.map((h) => h.id) });
  const defaultsOnCount = state.hadithDefaults.filter((h) => defaultOn(h.id)).length;
  // Per-built-in salah targeting: the admin's override (may be empty = "all") or, if none, the
  // shipped targeting from the built-in itself.
  const defaultPrayersMap = sh.defaultPrayers ?? {};
  const prayersForDefault = (id: string, shipped?: string[]) => defaultPrayersMap[id] ?? shipped ?? [];
  const setDefaultPrayers = (id: string, keys: string[]) => setSh({ defaultPrayers: { ...defaultPrayersMap, [id]: keys } });
  // During-salah screen mode: 'normal' (keep showing times), 'hadith' (the overlay below),
  // or 'blackout' (a completely black screen). Blackout and hadith are mutually exclusive,
  // so choosing one turns the other off.
  const bo: SalahBlackout = f.salahBlackout ?? { enabled: false, minutes: sh.minutes };
  const setBo = (patch: Partial<SalahBlackout>) => set('salahBlackout', { ...bo, ...patch });
  const salahMode: 'normal' | 'hadith' | 'blackout' = bo.enabled ? 'blackout' : sh.enabled ? 'hadith' : 'normal';
  const setSalahMode = (mode: 'normal' | 'hadith' | 'blackout') => {
    setSh({ enabled: mode === 'hadith' });
    setBo({ enabled: mode === 'blackout' });
  };
  const pn: ProhibitedNotice = f.prohibitedNotice ?? { enabled: false, minutes: 10 };
  const setPn = (patch: Partial<ProhibitedNotice>) => set('prohibitedNotice', { ...pn, ...patch });
  const ic: IqamahCountdown = f.iqamahCountdown ?? { enabled: false, minutes: 5 };
  const setIc = (patch: Partial<IqamahCountdown>) => set('iqamahCountdown', { ...ic, ...patch });
  const icn: IqamahChangeNotice = f.iqamahChangeNotice ?? { enabled: false, daysBefore: 7 };
  const setIcn = (patch: Partial<IqamahChangeNotice>) => set('iqamahChangeNotice', { ...icn, ...patch });
  const ao: AdhanOffsets = f.adhanOffsets ?? {};
  const setAo = (k: keyof AdhanOffsets, v: number) => set('adhanOffsets', { ...ao, [k]: v });
  const apop: AdhanPopup = f.adhanPopup ?? { enabled: false, seconds: 15 };
  const setApop = (patch: Partial<AdhanPopup>) => set('adhanPopup', { ...apop, ...patch });
  const wg: TimetableWidget = f.widget ?? { enabled: false };
  const setWg = (patch: Partial<TimetableWidget>) => set('widget', { ...wg, ...patch });

  const general = (
    <>
      <div className="card section">
        <h3 className="section-title">Masjid & identity</h3>
        <div className="grid2">
          <Field label="Name (for you)" hint="A private label for this list — e.g. “Main hall” or “Women's section”. Never shown on screen."><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Masjid name (on screen)" hint="Shown in the header. Tip: you can also click it in the preview above to edit it in place."><input className="input" value={f.masjidName} onChange={(e) => set('masjidName', e.target.value)} /></Field>
        </div>
        <Field label="Location (under the name)" hint="A subtitle under the masjid name, e.g. Lansdale, Pennsylvania. Leave blank to hide it."><input className="input" value={f.location} onChange={(e) => set('location', e.target.value)} /></Field>
      </div>

      <div className="card section">
        <h3 className="section-title">Location & time zone</h3>
        <p className="hint" style={{ marginBlockStart: 0 }}>Prayer times are calculated on the device from your coordinates — no internet needed.</p>
        <div className="grid2">
          <Field label="Latitude" hint="Your masjid's latitude, e.g. 40.748222. Use the lookup link below if you're not sure."><input className="input" inputMode="decimal" value={f.latitude} onChange={(e) => set('latitude', e.target.value)} /></Field>
          <Field label="Longitude" hint="Your masjid's longitude, e.g. -73.891075."><input className="input" inputMode="decimal" value={f.longitude} onChange={(e) => set('longitude', e.target.value)} /></Field>
        </div>
        <p className="hint" style={{ marginBlockStart: '-0.2rem', marginBlockEnd: '0.6rem' }}>
          Don't know yours?{' '}
          <a href="https://www.latlong.net/convert-address-to-lat-long.html" target="_blank" rel="noopener noreferrer">Look up your address →</a>
        </p>
        <div className="grid2">
          <Field label="Time zone" hint="Pick the closest city/zone so the clock and times match your local time.">
            <select className="select" value={f.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {timezoneOptions(f.timezone).map((tz) => <option key={tz.id || 'server'} value={tz.id}>{tz.label}</option>)}
            </select>
          </Field>
          <Field label="Clock format" hint="How the big clock and times read: 12-hour (with AM/PM) or 24-hour.">
            <select className="select" value={f.timeFormat} onChange={(e) => set('timeFormat', e.target.value as Form['timeFormat'])}>
              <option value="12h">12-hour</option>
              <option value="24h">24-hour</option>
            </select>
          </Field>
        </div>
      </div>

      <div className="card section">
        <h3 className="section-title">Dates & language</h3>
        <Field label="Language (dates & labels)" hint="Sets the language of the dates and on-screen labels. Arabic & Urdu render right-to-left.">
          <select className="select" value={f.language} onChange={(e) => set('language', e.target.value as Form['language'])}>
            <option value="en">English</option>
            <option value="ar">العربية (Arabic)</option>
            <option value="ur">اردو (Urdu)</option>
          </select>
        </Field>
        <div className="grid2">
          <Field label="Hijri date adjustment" hint="Shift the Islamic (Hijri) date by ±days to match your local moon-sighting.">
            <select className="select" value={f.hijriOffset} onChange={(e) => set('hijriOffset', Number(e.target.value))}>
              {[-3, -2, -1, 0, 1, 2, 3].map((n) => (
                <option key={n} value={n}>{n === 0 ? 'No change' : `${n > 0 ? '+' : ''}${n} day${Math.abs(n) === 1 ? '' : 's'}`}</option>
              ))}
            </select>
          </Field>
          <Field label="Gregorian date adjustment" hint="Shift the Western (Gregorian) date by ±days. Rarely needed — usually leave at 'No change'.">
            <select className="select" value={f.gregorianOffset} onChange={(e) => set('gregorianOffset', Number(e.target.value))}>
              {[-3, -2, -1, 0, 1, 2, 3].map((n) => (
                <option key={n} value={n}>{n === 0 ? 'No change' : `${n > 0 ? '+' : ''}${n} day${Math.abs(n) === 1 ? '' : 's'}`}</option>
              ))}
            </select>
          </Field>
        </div>
      </div>

      <div className="card section">
        <h3 className="section-title">Screen & quality</h3>
        <div className="grid2">
          <Field label="Orientation" hint="Landscape for a normal TV; portrait for a screen turned on its side.">
            <select className="select" value={f.orientation} onChange={(e) => set('orientation', e.target.value as Form['orientation'])}>
              <option value="landscape">Landscape</option>
              <option value="portrait">Portrait</option>
            </select>
          </Field>
          <Field label="Picture quality" hint="720p is lighter and best for a Raspberry Pi; 1080p is sharper but needs more power/bandwidth.">
            <select className="select" value={f.quality} onChange={(e) => set('quality', e.target.value as Form['quality'])}>
              <option value="720p">720p</option>
              <option value="1080p">1080p (Full HD)</option>
            </select>
          </Field>
        </div>
        <div className="grid2">
          <Field label="Bitrate — 720p (kbps)" hint="Video quality at 720p. Higher = sharper but heavier on the network. Blank = default (4000).">
            <input className="input" type="number" min={500} max={20000} step={250} placeholder="4000" value={f.bitrate720 ?? ''} onChange={(e) => set('bitrate720', e.target.value === '' ? undefined : Number(e.target.value))} />
          </Field>
          <Field label="Bitrate — 1080p (kbps)" hint="Video quality at 1080p. Blank = default (8000).">
            <input className="input" type="number" min={500} max={30000} step={250} placeholder="8000" value={f.bitrate1080 ?? ''} onChange={(e) => set('bitrate1080', e.target.value === '' ? undefined : Number(e.target.value))} />
          </Field>
        </div>
      </div>
    </>
  );

  const salah = (
    <>
      <div className="card section">
        <h3 className="section-title">Calculation</h3>
        <div className="grid2">
          <Field label="Calculation method" hint="The convention for Fajr/Isha angles used in your region. Choose 'Custom' to set exact angles.">
            <select className="select" value={f.method} onChange={(e) => set('method', e.target.value as Form['method'])}>
              {METHODS.map((m) => <option key={m} value={m}>{m === 'Custom' ? 'Custom (set angles)' : m}</option>)}
            </select>
          </Field>
          <Field label="Asr time" hint="Hanafi Asr starts later (shadow = 2× object); Standard (Shafi'i/Maliki/Hanbali) is earlier (shadow = 1×).">
            <select className="select" value={f.asrMadhab} onChange={(e) => set('asrMadhab', e.target.value as Form['asrMadhab'])}>
              <option value="Hanafi">Hanafi (later)</option>
              <option value="Standard">Standard (Shafi'i/Maliki/Hanbali)</option>
            </select>
          </Field>
        </div>
        {f.method === 'Custom' && (
          <div className="grid2">
            <Field label="Fajr angle (°)" hint="Degrees the sun sits below the horizon at Fajr — your local convention, e.g. 18.">
              <input className="input" type="number" min={0} max={30} step={0.5} value={f.fajrAngle} onChange={(e) => set('fajrAngle', Number(e.target.value))} />
            </Field>
            <Field label="Isha angle (°)" hint="Degrees below the horizon at Isha, e.g. 17.">
              <input className="input" type="number" min={0} max={30} step={0.5} value={f.ishaAngle} onChange={(e) => set('ishaAngle', Number(e.target.value))} />
            </Field>
          </div>
        )}
      </div>

      <div className="card section">
        <h3 className="section-title">Iqamah times</h3>
        <p className="hint" style={{ marginBlockStart: 0 }}>How long after each Adhan the Iqamah is called — a fixed clock time, or “don't show”.</p>
        {csvActive && (
          <p className="hint">
            A yearly CSV is in use, so these per-prayer rules are turned off. Fine-tune the exact times in the
            table below, or <button type="button" onClick={clearCsv} style={{ background: 'none', border: 0, padding: 0, color: 'var(--color-primary)', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}>clear the CSV</button> to use rules again.
          </p>
        )}
        <div className="list">
          {(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const).map((k) => (
            <IqamahRow key={k} name={k} rule={f.iqamah[k]} disabled={csvActive} onChange={(r) => setF((p) => ({ ...p, iqamah: { ...p.iqamah, [k]: r } as IqamahConfig }))} />
          ))}
        </div>
      </div>

      <div className="card section">
        <h3 className="section-title">Adhan delay</h3>
        <p className="hint" style={{ marginBlockStart: 0 }}>
          Minutes to add to each prayer's calculated Adhan time — for masjids that call the Adhan a few minutes
          after the astronomical time. The displayed Adhan (and any “minutes after Adhan” Iqamah) shifts with it.
        </p>
        <div className="list">
          {(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const).map((k) => (
            <div className="row-between" key={k} style={{ padding: '0.3rem 0' }}>
              <span className="label" style={{ margin: 0, textTransform: 'capitalize' }}>{k}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={60}
                  style={{ width: '5rem' }}
                  value={ao[k] ?? 0}
                  onChange={(e) => setAo(k, Math.max(0, Math.min(60, Number(e.target.value) || 0)))}
                />
                <span className="hint">min</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card section">
        <h3 className="section-title">Jumu'ah times (Fridays)</h3>
        <p className="hint" style={{ marginBlockStart: 0 }}>Shown as a separate strip every day. Add a second time for a second Jumu'ah.</p>
        <JumuahEditor times={f.jumuah} onChange={(j) => set('jumuah', j)} />
      </div>

      <div className="card section">
        <h3 className="section-title">Iqamah changes on specific dates</h3>
        {tt ? (
          <div>
            <p className="hint" style={{ marginBlockStart: 0 }}>
              Set a one-off Iqamah time for a particular date (say a special programme, Ramadan, or an
              early Fajr) — without touching your normal rules. It repeats on that date each year until you
              remove it.
            </p>
            <OneOffIqamahEditor year={iqYear} onSave={saveIqYear} />
          </div>
        ) : (
          <span className="hint">Create the timetable first, then you can add date-specific times.</span>
        )}
      </div>

      <div className="card section">
        <h3 className="section-title">Announce upcoming changes</h3>
        <div className="toggle-row row-between" style={{ marginBlockEnd: '0.7rem' }}>
          <span className="label" style={{ margin: 0 }}>Show a heads-up on the screens before an Iqamah time changes</span>
          <Toggle checked={icn.enabled} onChange={(v) => setIcn({ enabled: v })} label="Announce upcoming Iqamah changes" />
        </div>
        {icn.enabled ? (
          <Field label="Start showing (days before)" hint="A plain line like “From Friday, Asr will be at 5:30 PM” appears at the bottom this many days before a change takes effect. It sits alongside any scrolling announcements, and shows even if those are off.">
            <input className="input" type="number" min={1} max={60} value={icn.daysBefore} onChange={(e) => setIcn({ daysBefore: Number(e.target.value) })} />
          </Field>
        ) : (
          <p className="hint" style={{ marginBlockStart: 0 }}>When on, the screens automatically announce a date-specific change (from above) a few days ahead — no need to type anything.</p>
        )}
      </div>

      <div className="card section">
        <h3 className="section-title">Exact times for the whole year (CSV)</h3>
        {tt ? (
          <div>
            <p className="hint" style={{ marginBlockStart: 0 }}>
              Upload one file with a row per day to set exact Iqamah times for the whole year — they override
              the rules above on matching dates. Download the example to see the format (it comes pre-filled
              from your rules, ready to tweak).
            </p>
            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap', marginBlockStart: '0.6rem' }}>
              <label className="btn btn--primary btn--sm" style={{ cursor: 'pointer' }}>
                <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) importCsv(file); e.target.value = ''; }} />
                Import CSV
              </label>
              <a className="btn btn--ghost btn--sm" href={api.iqamahCsvUrl(tt.id, 'template')}>Download example</a>
              <a className="btn btn--ghost btn--sm" href={api.iqamahCsvUrl(tt.id)}>Export current</a>
              {iqCount > 0 && <button type="button" className="btn btn--ghost btn--sm" onClick={clearCsv}>Clear ({iqCount} days)</button>}
            </div>
            {iqCount > 0 && (
              <p className="hint" style={{ marginBlockStart: '0.5rem' }}>
                {iqCount} day{iqCount === 1 ? '' : 's'} set. These show on the screens; the live preview here
                still uses your rules.
              </p>
            )}
            <button type="button" className="btn btn--ghost btn--sm" style={{ marginBlockStart: '0.6rem' }} onClick={() => setShowTable((v) => !v)}>
              {showTable ? 'Hide the table editor' : csvActive ? 'Fine-tune the imported times (by month)' : 'Or edit times in a table (by month)'}
            </button>
            {showTable && <IqamahYearEditor value={iqYear} existingRows={iqCount} onSave={saveIqYear} />}
          </div>
        ) : (
          <span className="hint">Create the timetable first, then you can set yearly times.</span>
        )}
      </div>
    </>
  );

  const appearance = (
    <>
      <div className="card section">
        <h3 className="section-title">Theme & colours</h3>
        <Field label="Theme colour" hint="A ready-made palette (dark is default). Or pick a custom accent colour below.">
          <div className="chips">
            {state.themes.map((th) => (
              <button
                key={th.id}
                type="button"
                className={`chip${f.themeId === th.id && !f.accent ? ' is-active' : ''}`}
                onClick={() => setF((p) => ({ ...p, themeId: th.id, accent: undefined }))}
                title={th.label}
              >
                <span className="chip-dot" style={{ background: th.palette.primary, opacity: 1 }} />
                {th.label}
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: '0.6rem', marginBlockStart: '0.55rem' }}>
            <label className="row" style={{ gap: '0.45rem' }}>
              <input type="color" className="color-input" value={f.accent ?? themePrimary} onChange={(e) => set('accent', e.target.value)} />
              <span className="hint">Custom colour</span>
            </label>
            {f.accent && <button type="button" className="btn btn--ghost btn--sm" onClick={() => set('accent', undefined)}>Use theme colour</button>}
          </div>
          {!f.accent && f.backgroundImage && (
            <p className="hint" style={{ marginBlockStart: '0.4rem' }}>Matched to your wallpaper automatically. Pick a colour above to set your own. (Text colour also adapts to keep it readable.)</p>
          )}
        </Field>

        <Field label="Gold accent" hint="The second accent colour — Arabic prayer names, Jumu'ah, and the next-prayer highlight. Leave as the theme's gold, or pick your own.">
          <div className="row" style={{ gap: '0.6rem' }}>
            <label className="row" style={{ gap: '0.45rem' }}>
              <input type="color" className="color-input" value={f.goldColor || themeGold} onChange={(e) => set('goldColor', e.target.value)} />
              <span className="hint">{f.goldColor ? 'Custom gold' : 'Theme gold'}</span>
            </label>
            {f.goldColor && <button type="button" className="btn btn--ghost btn--sm" onClick={() => set('goldColor', undefined)}>Use theme gold</button>}
          </div>
        </Field>

        <Field label="Text colour" hint="'Auto' keeps your theme's text and flips to dark on a light photo so it stays readable. Or force light/dark/custom.">
          <div className="chips">
            <button type="button" className={`chip${!f.textColor ? ' is-active' : ''}`} onClick={() => set('textColor', '')} title="Pick the most readable colour automatically">
              <span className="chip-dot" style={{ background: 'linear-gradient(135deg,#f5f8ff 50%,#10161d 50%)' }} />
              Auto
            </button>
            <button type="button" className={`chip${f.textColor?.toLowerCase() === '#f5f8ff' ? ' is-active' : ''}`} onClick={() => set('textColor', '#f5f8ff')}>
              <span className="chip-dot" style={{ background: '#f5f8ff' }} />
              Light
            </button>
            <button type="button" className={`chip${f.textColor?.toLowerCase() === '#10161d' ? ' is-active' : ''}`} onClick={() => set('textColor', '#10161d')}>
              <span className="chip-dot" style={{ background: '#10161d' }} />
              Dark
            </button>
          </div>
          <div className="row" style={{ gap: '0.6rem', marginBlockStart: '0.55rem' }}>
            <label className="row" style={{ gap: '0.45rem' }}>
              <input type="color" className="color-input" value={f.textColor || '#f5f8ff'} onChange={(e) => set('textColor', e.target.value)} />
              <span className="hint">Custom colour</span>
            </label>
            {f.textColor && <button type="button" className="btn btn--ghost btn--sm" onClick={() => set('textColor', '')}>Auto contrast</button>}
          </div>
        </Field>
      </div>

      <div className="card section">
        <h3 className="section-title">Background & logo</h3>
        <Field label="Background" hint="Upload a photo/wallpaper, or leave it on the themed scene. The theme colour auto-matches your photo.">
          {tt ? (
            <div className="row" style={{ gap: '0.6rem', flexWrap: 'wrap' }}>
              <span className="muted" style={{ fontSize: '0.88rem' }}>{f.backgroundImage ? 'Custom image set.' : 'Using the themed scene.'}</span>
              <label className="btn btn--ghost btn--sm" style={{ cursor: 'pointer' }}>
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) pickBackground(file); e.target.value = ''; }} />
                {f.backgroundImage ? 'Replace image' : 'Upload image'}
              </label>
              {f.backgroundImage && <button type="button" className="btn btn--ghost btn--sm" onClick={clearBackground}>Remove</button>}
            </div>
          ) : (
            <span className="hint">Create the timetable first, then you can add a background image.</span>
          )}
        </Field>

        <Field label="Masjid logo" hint="Replaces the built-in dome mark in the header. A transparent PNG or SVG looks best.">
          {tt ? (
            <div className="row" style={{ gap: '0.6rem', flexWrap: 'wrap' }}>
              <span className="muted" style={{ fontSize: '0.88rem' }}>{f.logoImage ? 'Custom logo set.' : 'Using the built-in mark.'}</span>
              <label className="btn btn--ghost btn--sm" style={{ cursor: 'pointer' }}>
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) pickLogo(file); e.target.value = ''; }} />
                {f.logoImage ? 'Replace logo' : 'Upload logo'}
              </label>
              {f.logoImage && <button type="button" className="btn btn--ghost btn--sm" onClick={clearLogo}>Remove</button>}
            </div>
          ) : (
            <span className="hint">Create the timetable first, then you can add a logo.</span>
          )}
        </Field>
      </div>

      <div className="card section">
        <h3 className="section-title">Show on screen</h3>
        <p className="hint" style={{ marginBlockStart: 0 }}>Turn individual elements on or off for this display.</p>
        <div className="toggle-list">
          <ToggleRow label="Logo" checked={f.showLogo} onChange={(v) => set('showLogo', v)} />
          <ToggleRow label="Masjid name" checked={f.showName} onChange={(v) => set('showName', v)} />
          <ToggleRow label="Hijri & Gregorian dates" checked={f.showDates} onChange={(v) => set('showDates', v)} />
          <ToggleRow label="Countdown to next prayer" checked={f.showCountdown} onChange={(v) => set('showCountdown', v)} />
          <ToggleRow label="Seconds on the clock" checked={f.showSeconds} onChange={(v) => set('showSeconds', v)} />
          <ToggleRow label="Sunrise" checked={f.showSunrise} onChange={(v) => set('showSunrise', v)} />
          <ToggleRow label="Sun & moon in the background" checked={f.showCelestial} onChange={(v) => set('showCelestial', v)} />
          <ToggleRow label="Calculation-method footnote" checked={f.showFooter} onChange={(v) => set('showFooter', v)} />
        </div>
        <div style={{ marginBlockStart: '0.9rem' }}>
          <Field label="Footer note (optional)" hint="A small custom line along the bottom. Leave blank to show the calculation-method note instead."><input className="input" value={f.footerNote} onChange={(e) => set('footerNote', e.target.value)} placeholder="e.g. Jumu'ah khutbah at 1:15pm" /></Field>
        </div>
      </div>
    </>
  );

  const during = (
    <>
      <div className="card section">
        <h3 className="section-title">Countdown to Iqamah</h3>
        <div className="toggle-row row-between" style={{ marginBlockEnd: '0.7rem' }}>
          <span className="label" style={{ margin: 0 }}>Show a full-screen countdown in the last minutes before each Iqamah</span>
          <Toggle checked={ic.enabled} onChange={(v) => setIc({ enabled: v })} label="Show a countdown to Iqamah" />
        </div>
        {ic.enabled && (
          <Field label="Start (minutes before the Iqamah)" hint="The full-screen countdown takes over this many minutes before each prayer's Iqamah time.">
            <input className="input" type="number" min={1} max={30} value={ic.minutes} onChange={(e) => setIc({ minutes: Number(e.target.value) })} />
          </Field>
        )}
      </div>

      <div className="card section">
        <h3 className="section-title">Adhan pop-up</h3>
        <div className="toggle-row row-between" style={{ marginBlockEnd: '0.7rem' }}>
          <span className="label" style={{ margin: 0 }}>Show a brief “it's time for salah” pop-up when the Adhan comes in</span>
          <Toggle checked={apop.enabled} onChange={(v) => setApop({ enabled: v })} label="Show an Adhan pop-up" />
        </div>
        {apop.enabled && (
          <Field label="Show for (seconds)" hint="The pop-up appears over the screen the moment each prayer's Adhan time arrives, then fades after this many seconds.">
            <input className="input" type="number" min={3} max={120} value={apop.seconds} onChange={(e) => setApop({ seconds: Number(e.target.value) })} />
          </Field>
        )}
      </div>

      <div className="card section">
        <h3 className="section-title">Prohibited time notice</h3>
        <div className="toggle-row row-between" style={{ marginBlockEnd: '0.7rem' }}>
          <span className="label" style={{ margin: 0 }}>Show a prohibited-time notice before Dhuhr (zawāl / sun at its zenith)</span>
          <Toggle checked={pn.enabled} onChange={(v) => setPn({ enabled: v })} label="Show the prohibited-time notice" />
        </div>
        {pn.enabled && (
          <>
            <Field label="Show for (minutes before the Dhuhr Adhan)" hint="During this window the next-prayer ring becomes a “Prohibited time” notice counting down to the Dhuhr Adhan, when prayer is allowed again.">
              <input className="input" type="number" min={1} max={45} value={pn.minutes} onChange={(e) => setPn({ minutes: Number(e.target.value) })} />
            </Field>
            <div className="toggle-row row-between" style={{ marginBlockStart: '0.7rem' }}>
              <span className="label" style={{ margin: 0 }}>
                Show as a red scroll message at the bottom <span className="hint">— instead of the ring notice; overrides any ticker for the whole window</span>
              </span>
              <Toggle checked={!!pn.ticker} onChange={(v) => setPn({ ticker: v })} label="Show as a bottom scroll message" />
            </div>
          </>
        )}
      </div>

      <div className="card section">
        <h3 className="section-title">During prayer (salah)</h3>
        <p className="hint" style={{ marginBlockStart: 0 }}>What the screens do for a while after each Iqamah, while the congregation prays.</p>
        <div className="chips" style={{ marginBlockEnd: '0.8rem' }}>
          {([
            ['normal', 'Keep showing times'],
            ['hadith', 'Show a hadith'],
            ['blackout', 'Black screen'],
          ] as const).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className={`chip${salahMode === mode ? ' is-active' : ''}`}
              aria-pressed={salahMode === mode}
              onClick={() => setSalahMode(mode)}
            >
              {label}
            </button>
          ))}
        </div>
        {salahMode === 'blackout' && (
          <Field label="Black out for (minutes after each Iqamah)" hint="The whole screen goes black once a prayer's Iqamah time arrives, so it isn't a distraction. It comes back on after this many minutes.">
            <input className="input" type="number" min={1} max={60} value={bo.minutes} onChange={(e) => setBo({ minutes: Number(e.target.value) })} />
          </Field>
        )}
        {salahMode === 'hadith' && (
          <>
            <Field label="Show for (minutes after each Iqamah)" hint="How long the hadith stays on screen once a prayer's Iqamah time arrives.">
              <input className="input" type="number" min={1} max={60} value={sh.minutes} onChange={(e) => setSh({ minutes: Number(e.target.value) })} />
            </Field>

            {state.hadithDefaults.length > 0 && (
              <>
                <div className="row-between" style={{ marginBlockEnd: '0.3rem' }}>
                  <span className="label" style={{ margin: 0 }}>Built-in ahadith on Salāh <span className="hint">({defaultsOnCount} of {state.hadithDefaults.length} on)</span></span>
                  <span style={{ display: 'flex', gap: '0.4rem' }}>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAllDefaults(true)}>All on</button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAllDefaults(false)}>All off</button>
                  </span>
                </div>
                <p className="hint" style={{ marginBlockStart: 0, marginBlockEnd: '0.4rem' }}>Turn off any you don't want. (Sourced from the Madani Academy “Salah Workshop”.)</p>
                <div className="list" style={{ maxHeight: '16rem', overflowY: 'auto' }}>
                  {state.hadithDefaults.map((h) => (
                    <div key={h.id} className="toggle-row row-between" style={{ alignItems: 'flex-start', gap: '0.6rem', padding: '0.4rem 0' }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', opacity: defaultOn(h.id) ? 1 : 0.5 }}>{h.en}</span>
                        <span className="hint">— {h.cite}</span>
                        {defaultOn(h.id) && <PrayerPicker value={prayersForDefault(h.id, h.prayers)} onChange={(v) => setDefaultPrayers(h.id, v)} />}
                      </span>
                      <Toggle checked={defaultOn(h.id)} onChange={(v) => toggleDefault(h.id, v)} label={`Toggle: ${h.cite}`} />
                    </div>
                  ))}
                </div>
              </>
            )}

            <p className="hint" style={{ marginBlockStart: '0.8rem', marginBlockEnd: '0.4rem' }}>Your own ahadith — the screen rotates through these and the built-ins above. Fill in Arabic, English, or both.</p>
            <div className="list">
              {sh.items.map((it, i) => (
                <div key={i} className="hadith-row">
                  <div className="hadith-fields">
                    <textarea className="input" dir="rtl" lang="ar" rows={2} value={it.ar} onChange={(e) => setHadith(i, { ar: e.target.value })} placeholder="النص بالعربية (اختياري)" style={{ resize: 'vertical', fontSize: '1.1rem' }} />
                    <textarea className="input" rows={2} value={it.en} onChange={(e) => setHadith(i, { en: e.target.value })} placeholder="English translation (optional)" style={{ resize: 'vertical' }} />
                    <PrayerPicker value={it.prayers ?? []} onChange={(v) => setHadith(i, { prayers: v })} />
                  </div>
                  <button type="button" className="icon-btn" onClick={() => delHadith(i)} aria-label="Remove hadith"><IconTrash size={15} /></button>
                </div>
              ))}
            </div>
            <button type="button" className="btn btn--ghost btn--sm" style={{ marginBlockStart: '0.5rem' }} onClick={addHadith}><IconPlus size={14} /> Add hadith</button>
          </>
        )}
      </div>
    </>
  );

  const announce = (
    <>
      <div className="card section">
        <h3 className="section-title">Announcement slideshow (images)</h3>
        {tt ? (
          <>
            <div className="toggle-row row-between" style={{ marginBlockEnd: '0.7rem' }}>
              <span className="label" style={{ margin: 0 }}>
                Cycle images over the display <span className="hint">— prayer times stay visible</span>
              </span>
              <Toggle checked={ann.enabled} onChange={(v) => setAnn({ enabled: v })} label="Cycle announcement images" />
            </div>
            <div className="ann-thumbs">
              {ann.images.map((im) => (
                <div key={im} className="ann-thumb">
                  <img src={api.announcementImageUrl(tt.id, im)} alt="Announcement" />
                  <button type="button" className="ann-thumb__x" onClick={() => removeAnnImage(im)} aria-label="Remove image">×</button>
                </div>
              ))}
              <label className="ann-add" style={{ cursor: 'pointer' }}>
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) addAnnImage(file); e.target.value = ''; }} />
                <IconPlus size={18} />
              </label>
            </div>
            <div className="grid2" style={{ marginBlockStart: '0.7rem' }}>
              <Field label="Show timetable for (seconds)" hint="How long the normal prayer display shows before the images cycle in."><input className="input" type="number" min={5} max={3600} value={ann.everySeconds} onChange={(e) => setAnn({ everySeconds: Number(e.target.value) })} /></Field>
              <Field label="Then show images for (seconds)" hint="How long the image slideshow runs before the prayer display returns."><input className="input" type="number" min={3} max={1800} value={ann.forSeconds} onChange={(e) => setAnn({ forSeconds: Number(e.target.value) })} /></Field>
            </div>
            <div className="grid2">
              <Field label="Each image shows (seconds)" hint="How long each individual image stays up during the slideshow."><input className="input" type="number" min={2} max={600} value={ann.imageSeconds} onChange={(e) => setAnn({ imageSeconds: Number(e.target.value) })} /></Field>
              <Field label="Active window (optional)" hint="Only run the slideshow between these times. Leave blank for all day.">
                <div className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
                  <input className="input" type="time" value={ann.start} onChange={(e) => setAnn({ start: e.target.value })} />
                  <span className="muted">to</span>
                  <input className="input" type="time" value={ann.end} onChange={(e) => setAnn({ end: e.target.value })} />
                </div>
              </Field>
            </div>
          </>
        ) : (
          <span className="hint">Create the timetable first, then you can add announcement images.</span>
        )}
      </div>

      <div className="card section">
        <h3 className="section-title">Scrolling messages (ticker)</h3>
        <div className="toggle-row row-between" style={{ marginBlockEnd: '0.7rem' }}>
          <span className="label" style={{ margin: 0 }}>Scroll short messages along the bottom</span>
          <Toggle checked={tk.enabled} onChange={(v) => setTk({ enabled: v })} label="Scroll messages along the bottom" />
        </div>
        {tk.enabled && (
          <Field label={`Scroll speed — ${f.tickerSpeed ?? 5} / 10`} hint="How fast the messages move across the bottom.">
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={f.tickerSpeed ?? 5}
              onChange={(e) => set('tickerSpeed', Number(e.target.value))}
              style={{ width: '100%' }}
              aria-label="Ticker scroll speed"
            />
          </Field>
        )}
        <div className="list">
          {tk.messages.map((mm, i) => (
            <div key={mm.id} className="msg-row">
              <input className="input" value={mm.text} onChange={(e) => setMsg(i, { text: e.target.value })} placeholder="e.g. Fundraising dinner this Saturday at 7pm" />
              <input className="input msg-time" type="time" value={mm.start} onChange={(e) => setMsg(i, { start: e.target.value })} title="Show from (optional)" />
              <input className="input msg-time" type="time" value={mm.end} onChange={(e) => setMsg(i, { end: e.target.value })} title="Show until (optional)" />
              <button type="button" className="icon-btn" onClick={() => delMsg(i)} aria-label="Remove message"><IconTrash size={15} /></button>
            </div>
          ))}
        </div>
        <button type="button" className="btn btn--ghost btn--sm" style={{ marginBlockStart: '0.5rem' }} onClick={addMsg}><IconPlus size={14} /> Add message</button>
      </div>
    </>
  );

  const sharing = (
    <>
      <div className="card section">
        <h3 className="section-title">Website widget</h3>
        <div className="toggle-row row-between" style={{ marginBlockEnd: '0.7rem' }}>
          <span className="label" style={{ margin: 0 }}>Let your website embed this timetable's times (just the times, vertical list)</span>
          <Toggle checked={wg.enabled} onChange={(v) => setWg({ enabled: v })} label="Allow embedding the prayer-times widget" />
        </div>
        {wg.enabled && (tt ? <WidgetEmbed id={tt.id} /> : (
          <p className="hint">Save this timetable, then reopen to get the embed code.</p>
        ))}
      </div>

      <div className="card section">
        <h3 className="section-title">Print</h3>
        {tt ? (
          <>
            <p className="hint" style={{ marginBlockStart: 0, marginBlockEnd: '0.6rem' }}>Open a printable month of prayer times — then use your browser's “Save as PDF”.</p>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => window.open(api.timetablePrintUrl(tt.id), '_blank', 'noopener')}
            >
              <IconCalendar size={14} /> Print this month
            </button>
          </>
        ) : (
          <span className="hint">Create the timetable first, then you can print a month.</span>
        )}
      </div>
    </>
  );

  const TABS: { id: EditorTab; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'salah', label: 'Salah times' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'during', label: 'During prayer' },
    { id: 'announce', label: 'Announcements' },
    { id: 'sharing', label: 'Sharing & print' },
  ];
  const panels: Record<EditorTab, ReactNode> = { general, salah, appearance, during, announce, sharing };

  return (
    <div className="editor-page">
      <div className="editor-bar glass-raised">
        <b className="editor-title">{tt ? 'Edit timetable' : 'New timetable'}</b>
        <span className="spacer" />
        <button className="btn" onClick={() => setPreviewOpen((o) => !o)} aria-pressed={previewOpen}>{previewOpen ? 'Hide preview' : 'Show preview'}</button>
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn btn--primary" onClick={save} disabled={busy}>{tt ? 'Save changes' : 'Create'}</button>
      </div>

      <div className={`tt-editor${previewOpen ? '' : ' tt-editor--nopreview'}`}>
        <nav className="tt-editor__tabs" aria-label="Settings categories">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tt-tab${tab === t.id ? ' is-active' : ''}`}
              aria-current={tab === t.id ? 'true' : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="tt-editor__panel">{panels[tab]}</div>

        {previewOpen && (
          <aside className="tt-editor__preview glass-raised">
            <LivePreview body={previewBody} portrait={f.orientation === 'portrait'} onEditCommit={editLabel} />
            <p className="hint" style={{ textAlign: 'center', marginBlock: '0.5rem 0' }}>
              <IconClock size={12} />{' '}
              {f.layoutCarousel
                ? 'Rotating preview — layouts cycle every 5 min. Click a name, the masjid title or the footer to rename it.'
                : 'Live preview — click a name, the masjid title or the footer to rename it.'}
            </p>
          </aside>
        )}
      </div>
    </div>
  );
}

/** The website-widget embed code + preview for a saved timetable. */
function WidgetEmbed({ id }: { id: string }) {
  const toast = useToast();
  const [info, setInfo] = useState<{ enabled: boolean; publicUrl: string; publicConfigured: boolean } | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    api.widgetInfo(id).then((i) => alive && setInfo(i)).catch(() => alive && setErr(true));
    return () => { alive = false; };
  }, [id]);
  if (err) return <p className="hint">Couldn't load the embed code.</p>;
  if (!info) return <p className="hint"><Spinner /> Preparing embed code…</p>;
  // Build the LAN link from the page's OWN origin so it uses the exact scheme + port
  // the admin is using right now (e.g. the HTTPS proxy port) — never a guessed http://.
  const localUrl = `${window.location.origin}/w/${id}`;
  const url = info.publicUrl || localUrl;
  const snippet = `<iframe src="${url}" title="Prayer times" loading="lazy" style="border:0;width:100%;max-width:420px;height:480px"></iframe>`;
  const copy = async (text: string, what: string) => {
    try { await copyText(text); toast(`${what} copied.`); }
    catch { toast('Could not copy. Select the text and copy manually.', 'error'); }
  };
  return (
    <div>
      <p className="hint" style={{ marginBlockEnd: '0.5rem' }}>
        Paste this into your website to show a live, auto-updating prayer-times box. Save the timetable after turning this on.
      </p>
      <Field label="Embed code">
        <textarea className="input" rows={3} readOnly value={snippet} onFocus={(e) => e.currentTarget.select()} style={{ fontFamily: 'monospace', fontSize: '0.78rem', resize: 'vertical' }} />
      </Field>
      <div className="row" style={{ gap: '0.5rem', marginBlockStart: '0.5rem', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => copy(snippet, 'Embed code')}><IconCopy size={14} /> Copy embed code</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => copy(url, 'Link')}><IconCopy size={14} /> Copy link</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => window.open(url, '_blank', 'noopener')}><IconExpand size={14} /> Preview</button>
      </div>
      <p className="hint" style={{ marginBlockStart: '0.5rem' }}>
        {info.publicUrl
          ? 'Public link — works anywhere (via your OpenMasjidOS remote access).'
          : info.publicConfigured
            ? 'This is a local-network link. Remote access is on, but OpenMasjidOS isn’t routing this app’s public path to it yet (it lands on another app), so a public link isn’t available — ask your OpenMasjidOS admin to enable per-app path routing.'
            : 'This is a local-network link. Turn on remote access (Cloudflare) in OpenMasjidOS to get a public link that works on the open internet.'}
      </p>
    </div>
  );
}

function LivePreview({ body, portrait, onEditCommit, onPopout }: { body: Partial<Timetable>; portrait: boolean; onEditCommit: (id: string, value: string) => void; onPopout?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [spots, setSpots] = useState<Hotspot[]>([]);
  const [active, setActive] = useState<{ id: string; value: string } | null>(null);
  const urlRef = useRef<string | null>(null);
  const key = JSON.stringify(body);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api
        .previewLive(body)
        .then((u) => {
          if (!alive) {
            URL.revokeObjectURL(u);
            return;
          }
          if (urlRef.current) URL.revokeObjectURL(urlRef.current);
          urlRef.current = u;
          setUrl(u);
          setErr(false);
        })
        .catch(() => {
          if (alive) setErr(true);
        });
      api
        .previewMeta(body)
        .then((r) => { if (alive) setSpots(r.hotspots); })
        .catch(() => { if (alive) setSpots([]); });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const commit = () => {
    if (active) onEditCommit(active.id, active.value);
    setActive(null);
  };
  const activeSpot = active ? spots.find((s) => s.id === active.id) : null;

  return (
    <div className={`studio-canvas${portrait ? ' studio-canvas--portrait' : ''}`}>
      {url && <img src={url} alt="Live preview of the timetable" className="studio-canvas__img" />}
      {!url && !err && <div className="studio-canvas__overlay"><Spinner /></div>}
      {err && <div className="studio-canvas__overlay"><span className="muted">Preview unavailable.</span></div>}
      {url &&
        spots.map((s) =>
          active && active.id === s.id ? null : (
            <button
              key={s.id}
              type="button"
              className="hot"
              title="Click to rename"
              style={{ left: `${s.xPct}%`, top: `${s.yPct}%`, width: `${s.wPct}%`, height: `${s.hPct}%` }}
              onClick={() => setActive({ id: s.id, value: s.value })}
            />
          ),
        )}
      {active && activeSpot && (
        <input
          autoFocus
          className="hot-input"
          style={{ left: `${activeSpot.xPct}%`, top: `${activeSpot.yPct}%`, width: `${Math.max(activeSpot.wPct, 14)}%`, height: `${activeSpot.hPct}%` }}
          value={active.value}
          onChange={(e) => setActive({ id: active.id, value: e.target.value })}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); setActive(null); }
          }}
        />
      )}
      {onPopout && (
        <button
          type="button"
          className="canvas-expand"
          onClick={onPopout}
          title="Open the editor in a new tab"
          aria-label="Open the editor in a new tab"
        >
          <IconExpand size={16} />
        </button>
      )}
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="toggle-row row-between">
      <span className="label" style={{ margin: 0 }}>{label}</span>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

const PRAYER_TITLE: Record<string, string> = { fajr: 'Fajr', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };

/** Pick which salawāt a hadith shows after. No chips selected = shown after every prayer. */
function PrayerPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const keys = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
  const toggle = (k: string) => {
    const set = new Set(value);
    if (set.has(k)) set.delete(k); else set.add(k);
    onChange(keys.filter((x) => set.has(x))); // keep canonical order
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.3rem', marginBlockStart: '0.4rem' }}>
      <span className="hint" style={{ marginInlineEnd: '0.2rem' }}>Show after:</span>
      {keys.map((k) => {
        const on = value.includes(k);
        return (
          <button
            type="button"
            key={k}
            onClick={() => toggle(k)}
            aria-pressed={on}
            className="btn btn--sm"
            style={{
              padding: '0.15rem 0.55rem',
              borderRadius: '999px',
              background: on ? 'var(--color-primary)' : 'transparent',
              color: on ? '#fff' : 'var(--color-text-dim, inherit)',
              border: '1px solid var(--color-border, rgba(127,127,127,0.4))',
              opacity: on ? 1 : 0.7,
            }}
          >
            {PRAYER_TITLE[k]}
          </button>
        );
      })}
      {value.length === 0 && <span className="hint">every prayer</span>}
    </div>
  );
}

function IqamahRow({ name, rule, onChange, disabled }: { name: string; rule: IqamahRule; onChange: (r: IqamahRule) => void; disabled?: boolean }) {
  return (
    <div className="list-row" style={disabled ? { opacity: 0.45, pointerEvents: 'none' } : undefined} aria-disabled={disabled}>
      <div className="list-row__main"><div className="list-row__title">{PRAYER_TITLE[name]}</div></div>
      <select className="select" style={{ width: 'auto' }} disabled={disabled} value={rule.mode} onChange={(e) => onChange({ mode: e.target.value as IqamahRule['mode'], offset: 10, fixed: '13:30' })}>
        <option value="offset">Minutes after Adhan</option>
        <option value="fixed">Fixed time</option>
        <option value="none">Don't show</option>
      </select>
      {rule.mode === 'offset' && (
        <input className="input" style={{ width: '5rem' }} type="number" min={0} max={240} disabled={disabled} value={rule.offset ?? 10} onChange={(e) => onChange({ mode: 'offset', offset: Number(e.target.value) })} />
      )}
      {rule.mode === 'fixed' && (
        <input className="input" style={{ width: '8rem' }} type="time" disabled={disabled} value={rule.fixed ?? '13:30'} onChange={(e) => onChange({ mode: 'fixed', fixed: e.target.value })} />
      )}
    </div>
  );
}

function JumuahEditor({ times, onChange }: { times: string[]; onChange: (t: string[]) => void }) {
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
      {times.map((t, i) => (
        <span key={i} className="row" style={{ gap: '0.3rem' }}>
          <input className="input" style={{ width: '8rem' }} type="time" value={t} onChange={(e) => onChange(times.map((x, j) => (j === i ? e.target.value : x)))} />
          <button className="icon-btn" aria-label="Remove time" onClick={() => onChange(times.filter((_, j) => j !== i))}><IconTrash size={15} /></button>
        </span>
      ))}
      <button className="btn btn--ghost btn--sm" onClick={() => onChange([...times, '13:30'])}><IconPlus size={14} /> Add time</button>
    </div>
  );
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Days in a 1-based month, leap-aware for February (29 in a leap year, else 28). */
function daysInMonth(month: number, year: number = new Date().getFullYear()): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** The quick way to add a one-off Iqamah change for a specific date — pick a date, type the
 *  Iqamah time(s) that differ that day, Add. Existing dated entries list below with a remove.
 *  Reads/writes the SAME shared year map as the CSV + monthly table (via `onSave`), so all
 *  three stay in step and none overwrites another. */
function OneOffIqamahEditor({ year, onSave }: { year: IqamahYear; onSave: (next: IqamahYear) => Promise<void> }) {
  const toast = useToast();
  const PR = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const;
  const [date, setDate] = useState(''); // YYYY-MM-DD from <input type=date>
  const [draft, setDraft] = useState<Partial<Record<(typeof PR)[number], string>>>({});
  const [busy, setBusy] = useState(false);

  const entries = Object.keys(year).sort(); // "MM-DD" keys sort chronologically
  const label = (mmdd: string) => {
    const [m, d] = mmdd.split('-').map(Number);
    return `${MONTHS[(m || 1) - 1]?.slice(0, 3) ?? '??'} ${d || ''}`.trim();
  };

  const add = async () => {
    if (!date) return toast('Pick a date first.', 'error');
    const row: Record<string, string> = {};
    for (const pr of PR) { const v = draft[pr]; if (v) row[pr] = v; }
    if (!Object.keys(row).length) return toast('Set at least one Iqamah time for that date.', 'error');
    const mmdd = date.slice(5); // "MM-DD"
    const next: IqamahYear = { ...year, [mmdd]: { ...(year[mmdd] ?? {}), ...row } };
    setBusy(true);
    try {
      await onSave(next);
      setDate('');
      setDraft({});
      toast(`Iqamah change saved for ${label(mmdd)}.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save that change.', 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (mmdd: string) => {
    const next: IqamahYear = { ...year };
    delete next[mmdd];
    setBusy(true);
    try {
      await onSave(next);
      toast(`Removed the change for ${label(mmdd)}.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove that change.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {entries.length > 0 && (
        <div className="list" style={{ marginBlock: '0.8rem' }}>
          {entries.map((mmdd) => {
            const e = year[mmdd] ?? {};
            const parts = PR.filter((pr) => e[pr]).map((pr) => `${PRAYER_TITLE[pr]} ${e[pr]}`);
            return (
              <div key={mmdd} className="oneoff-row">
                <span className="oneoff-date">{label(mmdd)}</span>
                <span className="oneoff-times">{parts.length ? parts.join('  ·  ') : '—'}</span>
                <button type="button" className="icon-btn" onClick={() => remove(mmdd)} disabled={busy} aria-label={`Remove the change for ${label(mmdd)}`}><IconTrash size={15} /></button>
              </div>
            );
          })}
        </div>
      )}
      <div className="oneoff-add">
        <label className="field" style={{ margin: 0 }}>
          <span className="label">Date</span>
          <input type="date" className="input" value={date} onChange={(ev) => setDate(ev.target.value)} />
        </label>
        <div className="oneoff-grid">
          {PR.map((pr) => (
            <label key={pr} className="field" style={{ margin: 0 }}>
              <span className="label">{PRAYER_TITLE[pr]}</span>
              <input type="time" className="input" value={draft[pr] ?? ''} onChange={(ev) => setDraft((x) => ({ ...x, [pr]: ev.target.value }))} />
            </label>
          ))}
        </div>
        <button type="button" className="btn btn--primary btn--sm" onClick={add} disabled={busy}><IconPlus size={14} /> Add change</button>
      </div>
    </div>
  );
}

/** In-app monthly grid for setting exact Iqamah clock times across the year. Edits a copy
 *  of the shared `value` map (seeded fresh whenever it changes — e.g. after a one-off add or
 *  a CSV import) and persists via `onSave`, so it never clobbers the other editors. */
function IqamahYearEditor({ value, existingRows, onSave }: { value: IqamahYear; existingRows: number | null; onSave: (next: IqamahYear) => Promise<void> }) {
  const toast = useToast();
  const [year, setYear] = useState<IqamahYear>(() => JSON.parse(JSON.stringify(value)));
  // Re-seed when the shared map changes underneath us (one-off add, CSV import/clear) so the
  // grid never saves back a stale copy that would drop those changes.
  useEffect(() => { setYear(JSON.parse(JSON.stringify(value))); }, [value]);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [busy, setBusy] = useState(false);
  // True when this timetable already had per-day times when the editor opened (e.g.
  // imported from a CSV) — saving manual edits then overrides them, so we confirm first.
  const [confirmOverride, setConfirmOverride] = useState(false);
  const PR = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const;
  const pad = (n: number) => String(n).padStart(2, '0');
  const key = (d: number) => `${pad(month)}-${pad(d)}`;
  const get = (d: number, pr: (typeof PR)[number]) => year[key(d)]?.[pr] ?? '';
  const setCell = (d: number, pr: (typeof PR)[number], val: string) =>
    setYear((y) => {
      const k = key(d);
      const row = { ...(y[k] ?? {}) };
      if (val) row[pr] = val; else delete row[pr];
      const ny = { ...y };
      if (Object.keys(row).length) ny[k] = row; else delete ny[k];
      return ny;
    });
  const doSave = async () => {
    setBusy(true);
    try {
      await onSave(year);
      const rows = Object.keys(year).length;
      setConfirmOverride(false);
      toast(`Saved Iqamah times for ${rows} day${rows === 1 ? '' : 's'}.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the times.', 'error');
    } finally {
      setBusy(false);
    }
  };
  // Warn before overriding times already imported/saved for this timetable. Read the
  // count LIVE (not captured at mount) so importing a CSV while the editor is open
  // still triggers the warning.
  const save = () => { if ((existingRows ?? 0) > 0) setConfirmOverride(true); else void doSave(); };
  return (
    <>
    <div className="iqyear">
      <div className="row" style={{ gap: '0.5rem', marginBlock: '0.7rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="select" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(Number(e.target.value))}>
          {MONTHS.map((mn, i) => <option key={mn} value={i + 1}>{mn}</option>)}
        </select>
        <button type="button" className="btn btn--primary btn--sm" onClick={save} disabled={busy}>Save times</button>
        <span className="hint">Blank = use the rule. Saved for the whole year.</span>
      </div>
      <div className="iqyear-scroll">
        <table className="iqyear-grid">
          <thead>
            <tr><th>Day</th>{PR.map((pr) => <th key={pr}>{PRAYER_TITLE[pr]}</th>)}</tr>
          </thead>
          <tbody>
            {Array.from({ length: daysInMonth(month) }, (_, i) => i + 1).map((d) => (
              <tr key={d}>
                <td className="iqyear-day">{d}</td>
                {PR.map((pr) => (
                  <td key={pr}><input type="time" className="input iqyear-cell" value={get(d, pr)} onChange={(e) => setCell(d, pr, e.target.value)} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
    <Modal
      open={confirmOverride}
      onClose={() => setConfirmOverride(false)}
      title="Override imported times?"
      footer={
        <>
          <button className="btn" onClick={() => setConfirmOverride(false)}>Cancel</button>
          <button className="btn btn--primary" onClick={() => void doSave()} disabled={busy}>Override &amp; save</button>
        </>
      }
    >
      <p className="muted">This timetable already has per-day Iqāmah times (for example, imported from a CSV file). Saving your changes will override those imported times for the days you edited. Your CSV file itself isn't changed — you can re-import it to undo this.</p>
    </Modal>
    </>
  );
}

function PreviewImg({ src, portrait, alt }: { src: string; portrait: boolean; alt: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const cls = `preview${portrait ? ' preview--portrait' : ''}`;
  if (failed) {
    return (
      <div className={cls} style={{ aspectRatio: portrait ? '9 / 16' : '16 / 9', display: 'grid', placeItems: 'center' }}>
        <span className="muted" style={{ fontSize: '0.85rem' }}>Preview will appear shortly…</span>
      </div>
    );
  }
  return <img className={cls} src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}
