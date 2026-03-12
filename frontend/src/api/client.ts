import axios from 'axios';
import { refreshTokenOnce } from './tokenRefresh';
import { warn, error } from '../utils/logger';

const api = axios.create({
  baseURL: '/api',
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('access_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Skip refresh only for login/refresh endpoints (prevents infinite loop).
    // Other /auth/* endpoints (me, totp-setup, etc.) ARE protected and need refresh.
    const skipRefresh = ['/auth/login', '/auth/refresh', '/auth/register'].includes(originalRequest?.url);

    if (error.response?.status === 401 && !originalRequest._retry && !skipRefresh) {
      originalRequest._retry = true;
      warn('[AUTH] 401 received for', originalRequest.url, '— attempting token refresh');

      const refreshToken = localStorage.getItem('refresh_token');
      if (refreshToken) {
        try {
          const newToken = await refreshTokenOnce();
          if (newToken) {
            originalRequest.headers.Authorization = `Bearer ${newToken}`;
            return api(originalRequest);
          }
          throw new Error('refresh returned null');
        } catch (refreshErr) {
          error('[AUTH] Token refresh FAILED — redirecting to /login', refreshErr);
          localStorage.removeItem('access_token');
          localStorage.removeItem('refresh_token');
          window.location.href = '/login';
        }
      } else {
        error('[AUTH] No refresh_token — redirecting to /login');
        window.location.href = '/login';
      }
    }

    return Promise.reject(error);
  }
);

export default api;
