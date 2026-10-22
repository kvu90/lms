import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { UserProfile } from '@lms/contracts';
import { userProfileSchema } from '@lms/contracts';
import { apiFetch, loginWithPassword, logoutSession, tokenStore } from './api';

interface AuthState {
  user: UserProfile | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<UserProfile>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!tokenStore.access) { setUser(null); setLoading(false); return; }
    const res = await apiFetch('/api/v1/users/me');
    if (res.ok) setUser(userProfileSchema.parse(await res.json()));
    else { setUser(null); tokenStore.clear(); }
    setLoading(false);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const login = useCallback(async (username: string, password: string) => {
    await loginWithPassword(username, password);
    const res = await apiFetch('/api/v1/users/me');
    const profile = userProfileSchema.parse(await res.json());
    setUser(profile);
    return profile;
  }, []);

  const logout = useCallback(async () => { await logoutSession(); setUser(null); }, []);

  const value = useMemo(() => ({ user, loading, login, logout, reload }), [user, loading, login, logout, reload]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
