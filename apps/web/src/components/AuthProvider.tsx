'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { MeResponse } from '@conquest/shared';
import { fetchMe } from '@/lib/api';

interface AuthState {
  /** `loading` tant que la première réponse de /api/me n'est pas arrivée. */
  status: 'loading' | 'ready' | 'error';
  me: MeResponse | null;
  /** Remplace l'état courant (réponse d'une mutation) ou recharge depuis le serveur. */
  refresh: (next?: MeResponse) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé sous <AuthProvider>');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [me, setMe] = useState<MeResponse | null>(null);

  const refresh = useCallback(async (next?: MeResponse) => {
    if (next) {
      setMe(next);
      setStatus('ready');
      return;
    }
    try {
      setMe(await fetchMe());
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(() => ({ status, me, refresh }), [status, me, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
