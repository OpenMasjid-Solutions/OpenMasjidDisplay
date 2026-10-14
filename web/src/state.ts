// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useCallback, useEffect, useState } from 'react';
import { api, setUnauthHandler } from './api';
import type { AppState, TvStatus, Capabilities } from './types';
import { ALL_CAPABILITIES } from './types';

export interface UseApp {
  state: AppState | null;
  /** signed in (locally or via OpenMasjidOS SSO) */
  authed: boolean;
  /** whether a local control-panel password has been set */
  hasPassword: boolean;
  /** whether OpenMasjidOS sign-on is available for this install */
  ssoEnabled: boolean;
  /** whether the OpenMasjidOS platform was reachable on the last session check
   *  (false → SSO can't complete right now; offer the local-password recovery) */
  ssoReachable: boolean;
  /** what the host serving this panel supports — a Pi serves the same app with less of it on */
  caps: Capabilities;
  /** first run on a screen that wants the code off its own television before it will be claimed */
  setupCodeRequired: boolean;
  loading: boolean;
  refetch: () => Promise<void>;
  onAuthed: () => void;
}

export function useAppState(): UseApp {
  const [state, setState] = useState<AppState | null>(null);
  const [authed, setAuthed] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [ssoReachable, setSsoReachable] = useState(true);
  const [caps, setCaps] = useState<Capabilities>(ALL_CAPABILITIES);
  const [setupCodeRequired, setSetupCodeRequired] = useState(false);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const s = await api.state();
      setState(s);
      setAuthed(true);
    } catch {
      /* 401 → handled by the unauth handler (re-checks the session) */
    } finally {
      setLoading(false);
    }
  }, []);

  // Resolve who we are: a local session, OpenMasjidOS SSO (which the server turns
  // into a local session), or not signed in. Drives which screen shows.
  const checkSession = useCallback(async () => {
    try {
      const s = await api.session();
      setHasPassword(!!s.hasPassword);
      setSsoEnabled(!!s.sso?.enabled);
      setSsoReachable(s.sso?.reachable !== false);
      // A host too old to answer keeps every feature, which is what it had.
      if (s.capabilities) setCaps(s.capabilities);
      setSetupCodeRequired(!!s.setupCodeRequired);
      if (s.authed) {
        await refetch();
        return;
      }
      setAuthed(false);
    } catch {
      setAuthed(false);
    }
    setLoading(false);
  }, [refetch]);

  useEffect(() => {
    setUnauthHandler(() => {
      setAuthed(false);
      void checkSession();
    });
    void checkSession();
  }, [checkSession]);

  // Live updates over WebSocket (only while signed in).
  useEffect(() => {
    if (!authed) return;
    let closed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as { type: string; data: unknown };
          if (msg.type === 'state') void refetch();
          else if (msg.type === 'status') {
            setState((s) => (s ? { ...s, statuses: msg.data as TvStatus[] } : s));
          }
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 3000);
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  }, [authed, refetch]);

  const onAuthed = useCallback(() => {
    setLoading(true);
    void checkSession();
  }, [checkSession]);

  return { state, authed, hasPassword, ssoEnabled, ssoReachable, caps, setupCodeRequired, loading, refetch, onAuthed };
}
