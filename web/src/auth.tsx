import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, post, setUnauthenticatedHandler } from './api';
import { useI18n } from './i18n';
import type { AppConfig, User } from './types';

interface AuthValue {
  user: User | null;
  loading: boolean;
  config: AppConfig | null;
  setUser: (u: User | null) => void;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}
const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const { setLang } = useI18n();

  const setUser = useCallback(
    (u: User | null) => {
      setUserState(u);
      if (u) setLang(u.preferredLanguage);
    },
    [setLang],
  );

  const refresh = useCallback(async () => {
    try {
      const r = await get<{ user: User }>('/me');
      setUser(r.user);
    } catch {
      setUserState(null);
    }
  }, [setUser]);

  useEffect(() => {
    setUnauthenticatedHandler(() => setUserState(null));
    Promise.all([refresh(), get<AppConfig>('/config').then(setConfig).catch(() => setConfig(null))]).finally(() => setLoading(false));
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await post('/auth/logout');
    } finally {
      setUserState(null);
    }
  }, []);

  return <Ctx.Provider value={{ user, loading, config, setUser, logout, refresh }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider missing');
  return v;
}
