// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import type {
  AppState,
  Timetable,
  Source,
  Tv,
  ScheduleRule,
  Settings,
  ContentRef,
  Hotspot,
  IqamahYear,
} from './types';

let onUnauth: () => void = () => {};
export function setUnauthHandler(fn: () => void): void {
  onUnauth = fn;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    onUnauth();
    throw new Error('Please sign in.');
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error ?? `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

export const api = {
  session: () =>
    req<{
      needsSetup: boolean;
      authed: boolean;
      hasPassword: boolean;
      sso: { enabled: boolean; reachable?: boolean; username?: string };
    }>('GET', '/api/session'),
  setup: (password: string) => req<{ ok: boolean }>('POST', '/api/setup', { password }),
  login: (password: string) => req<{ ok: boolean }>('POST', '/api/login', { password }),
  logout: () => req<{ ok: boolean }>('POST', '/api/logout'),
  state: () => req<AppState>('GET', '/api/state'),

  saveSettings: (s: Partial<Settings>) => req<Settings>('PUT', '/api/settings', s),
  saveVolunteerConfig: (enabled: boolean, pin?: string) =>
    req<{ ok: boolean; enabled: boolean; pinSet: boolean }>('PUT', '/api/volunteer-config', { enabled, pin }),
  volunteerInfo: () => req<{ publicUrl: string; publicConfigured: boolean }>('GET', '/api/volunteer-info'),

  createTimetable: (b: Partial<Timetable>) => req<Timetable>('POST', '/api/timetables', b),
  updateTimetable: (id: string, b: Partial<Timetable>) => req<Timetable>('PUT', `/api/timetables/${id}`, b),
  duplicateTimetable: (id: string) => req<Timetable>('POST', `/api/timetables/${id}/duplicate`),
  deleteTimetable: (id: string) => req('DELETE', `/api/timetables/${id}`),
  uploadBackground: (id: string, dataUrl: string) =>
    req<Timetable>('POST', `/api/timetables/${id}/background`, { data: dataUrl }),
  removeBackground: (id: string) => req<Timetable>('DELETE', `/api/timetables/${id}/background`),
  uploadLogo: (id: string, dataUrl: string) =>
    req<Timetable>('POST', `/api/timetables/${id}/logo`, { data: dataUrl }),
  removeLogo: (id: string) => req<Timetable>('DELETE', `/api/timetables/${id}/logo`),

  importIqamahCsv: (id: string, csvText: string) =>
    req<{ ok: boolean; rows: number; errors: string[]; data: IqamahYear }>('POST', `/api/timetables/${id}/iqamah-csv`, { data: csvText }),
  clearIqamahCsv: (id: string) => req<Timetable>('DELETE', `/api/timetables/${id}/iqamah-csv`),
  saveIqamahYear: (id: string, year: Record<string, Record<string, string>>) =>
    req<{ ok: boolean; rows: number }>('PUT', `/api/timetables/${id}/iqamah-year`, { year }),
  iqamahCsvUrl: (id: string, mode?: 'template') =>
    `/api/timetables/${id}/iqamah-csv${mode ? `?mode=${mode}` : ''}`,

  uploadAnnouncement: (id: string, dataUrl: string) =>
    req<Timetable>('POST', `/api/timetables/${id}/announcements`, { data: dataUrl }),
  removeAnnouncement: (id: string, file: string) =>
    req<Timetable>('DELETE', `/api/timetables/${id}/announcements/${encodeURIComponent(file)}`),
  announcementImageUrl: (id: string, file: string) =>
    `/api/timetables/${id}/announcements/${encodeURIComponent(file)}`,

  /** Live PNG preview of an unsaved timetable form; returns an object URL. */
  previewLive: async (body: Partial<Timetable>): Promise<string> => {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    if (res.status === 401) {
      onUnauth();
      throw new Error('Please sign in.');
    }
    if (!res.ok) throw new Error('Could not render the preview.');
    return URL.createObjectURL(await res.blob());
  },

  /** Click-to-edit text regions for the live editor. */
  previewMeta: (body: Partial<Timetable>) => req<{ hotspots: Hotspot[] }>('POST', '/api/preview-meta', body),

  /** Printable month of computed prayer times (browser "Save as PDF"). */
  timetablePrintUrl: (id: string) => `/api/timetables/${id}/print`,

  /** Embed info for the public web widget: the VERIFIED public-tunnel URL (or '') and
   *  whether remote access is configured. The LAN URL + snippet are built client-side
   *  from window.location.origin (correct scheme/port). */
  widgetInfo: (id: string) =>
    req<{ enabled: boolean; publicUrl: string; publicConfigured: boolean }>('GET', `/api/timetables/${id}/widget-info`),

  createSource: (b: Partial<Source>) => req<Source>('POST', '/api/sources', b),
  updateSource: (id: string, b: Partial<Source>) => req<Source>('PUT', `/api/sources/${id}`, b),
  deleteSource: (id: string) => req('DELETE', `/api/sources/${id}`),
  testSource: (url: string) => req<{ ok: boolean; transport?: string; message: string }>('POST', '/api/sources/test', { url }),

  createTv: (b: Partial<Tv>) => req<Tv>('POST', '/api/tvs', b),
  updateTv: (id: string, b: Partial<Tv>) => req<Tv>('PUT', `/api/tvs/${id}`, b),
  deleteTv: (id: string) => req('DELETE', `/api/tvs/${id}`),
  setTv: (id: string, content: ContentRef, until: number | null) =>
    req<Tv>('POST', `/api/tvs/${id}/set`, { content, until }),
  resumeTv: (id: string) => req<Tv>('POST', `/api/tvs/${id}/resume`),

  createSchedule: (b: Partial<ScheduleRule>) => req<ScheduleRule>('POST', '/api/schedules', b),
  updateSchedule: (id: string, b: Partial<ScheduleRule>) => req<ScheduleRule>('PUT', `/api/schedules/${id}`, b),
  deleteSchedule: (id: string) => req('DELETE', `/api/schedules/${id}`),

  testNotification: () =>
    req<{ baseUrlSet: boolean; hasSecret: boolean; baseUrlLoopback: boolean; baseUrl: string; appId: string; delivered: boolean; reason?: string }>('POST', '/api/notify-test'),
};

/** The simple mobile volunteer page (served on its own port; PIN-gated). */
export interface VolunteerTv {
  id: string;
  name: string;
  room: string;
  now: { kind: 'timetable' | 'source' | 'off'; id?: string; label: string };
  overridden: boolean;
  ready: boolean;
}
export interface VolunteerData {
  tvs: VolunteerTv[];
  options: { timetables: { id: string; name: string }[]; sources: { id: string; name: string; type: string }[] };
}
// Volunteer calls are prefixed with the app's base path (injected as window.__OMD_BASE__ when
// the page is served under the OS tunnel at /<appId>/volunteer), so "/api/volunteer/…" resolves
// under that same prefix. Empty on the LAN / volunteer port, so it's a no-op there.
const VOL_BASE = (typeof window !== 'undefined' && window.__OMD_BASE__) || '';
export const volApi = {
  session: () => req<{ enabled: boolean; authed: boolean }>('GET', `${VOL_BASE}/api/volunteer/session`),
  login: (pin: string) => req<{ ok: boolean }>('POST', `${VOL_BASE}/api/volunteer/login`, { pin }),
  logout: () => req<{ ok: boolean }>('POST', `${VOL_BASE}/api/volunteer/logout`),
  tvs: () => req<VolunteerData>('GET', `${VOL_BASE}/api/volunteer/tvs`),
  set: (id: string, content: ContentRef) => req<{ ok: boolean }>('POST', `${VOL_BASE}/api/volunteer/tvs/${id}/set`, { content }),
  resume: (id: string) => req<{ ok: boolean }>('POST', `${VOL_BASE}/api/volunteer/tvs/${id}/resume`),
};
