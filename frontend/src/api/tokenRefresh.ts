import axios from 'axios';
import { useAuthStore } from '../store/authStore';

// ── Deduplicating refresh: only one in-flight refresh at a time ──
// Prevents race condition when multiple callers (axios interceptor +
// ensureFreshToken from WS reconnect) try to refresh simultaneously
// with the same single-use refresh token.

let refreshPromise: Promise<string | null> | null = null;

async function doRefresh(): Promise<string | null> {
  const refreshTok = localStorage.getItem('refresh_token');
  if (!refreshTok) return null;

  console.log('[tokenRefresh] doRefresh — calling /api/auth/refresh');
  const { data } = await axios.post('/api/auth/refresh', {
    refresh_token: refreshTok,
  });
  console.log('[tokenRefresh] doRefresh SUCCESS');
  localStorage.setItem('access_token', data.access_token);
  localStorage.setItem('refresh_token', data.refresh_token);
  useAuthStore.getState().loadFromStorage();
  return data.access_token as string;
}

/**
 * Refresh tokens exactly once — concurrent callers share the same promise.
 * Used by both ensureFreshToken() and the axios 401 interceptor.
 */
export function refreshTokenOnce(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

/**
 * Ensure we have a valid (non-expired) access token, refreshing via
 * /api/auth/refresh if needed. Used by WebSocket connections (terminal, chat)
 * which bypass the axios interceptor.
 */
export async function ensureFreshToken(): Promise<string | null> {
  const token = localStorage.getItem('access_token');
  if (!token) return null;

  // Decode JWT payload to check expiry
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    const now = Math.floor(Date.now() / 1000);
    // If token expires in more than 60s, it's fine
    if (payload.exp && payload.exp - now > 60) return token;
  } catch {
    // Can't decode — try refreshing
  }

  // Token expired or about to expire — use shared refresh
  try {
    const newToken = await refreshTokenOnce();
    if (newToken) return newToken;
  } catch (err) {
    console.error('[ensureFreshToken] Token refresh FAILED — using old token', err);
  }
  return token; // try with old token anyway
}
