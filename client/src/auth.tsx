import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { clearSession, getStoredUser, getToken, setSession } from './api';
import type { DemoUser } from './types';

interface AuthContextValue {
  user: DemoUser | null;
  login: (token: string, user: DemoUser) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  login: () => undefined,
  logout: () => undefined,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<DemoUser | null>(() => (getToken() ? getStoredUser() : null));

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      login: (token, nextUser) => {
        setSession(token, nextUser);
        setUser(nextUser);
      },
      logout: () => {
        clearSession();
        setUser(null);
      },
    }),
    [user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
