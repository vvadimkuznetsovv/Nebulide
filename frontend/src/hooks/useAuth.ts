import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { getMe } from '../api/auth';
import { syncThemeFromServer } from '../utils/theme';
import { syncPreferencesFromServer } from '../utils/preferences';
import { log } from '../utils/logger';

export function useAuth() {
  const { user, isAuthenticated, setAuth, clearAuth, loadFromStorage } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    const hasToken = loadFromStorage();
    log('[useAuth] loadFromStorage hasToken=', hasToken, 'user=', !!user);
    if (hasToken && !user) {
      getMe()
        .then(({ data }) => {
          log('[useAuth] getMe OK:', data.username);
          const token = localStorage.getItem('access_token')!;
          const refresh = localStorage.getItem('refresh_token')!;
          setAuth(data, token, refresh);
          syncThemeFromServer();
          syncPreferencesFromServer();
        })
        .catch((err) => {
          console.error('[useAuth] getMe FAILED — navigating to /login', err);
          clearAuth();
          navigate('/login');
        });
    }
  }, []);

  return { user, isAuthenticated, clearAuth };
}
