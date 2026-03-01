import { create } from 'zustand';

interface User {
  id: string;
  username: string;
  totp_enabled: boolean;
  is_admin?: boolean;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  isAuthenticated: boolean;

  setAuth: (user: User, accessToken: string, refreshToken: string) => void;
  setUser: (user: User) => void;
  clearAuth: () => void;
  loadFromStorage: () => boolean;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  isAuthenticated: false,

  setAuth: (user, accessToken, refreshToken) => {
    console.log('[AUTH-STORE] setAuth user=', user.username);
    localStorage.setItem('access_token', accessToken);
    localStorage.setItem('refresh_token', refreshToken);
    set({ user, accessToken, isAuthenticated: true });
  },

  setUser: (user) => {
    console.log('[AUTH-STORE] setUser', user.username);
    set({ user });
  },

  clearAuth: () => {
    console.warn('[AUTH-STORE] clearAuth — tokens removed');
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    set({ user: null, accessToken: null, isAuthenticated: false });
  },

  loadFromStorage: () => {
    const token = localStorage.getItem('access_token');
    console.log('[AUTH-STORE] loadFromStorage hasToken=', !!token);
    if (token) {
      set({ accessToken: token, isAuthenticated: true });
      return true;
    }
    return false;
  },
}));
