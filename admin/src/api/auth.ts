import api from './client';

export function login(username: string, password: string) {
  return api.post<{
    access_token: string;
    refresh_token: string;
    user: { id: string; username: string; is_admin: boolean };
    requires_totp?: boolean;
    partial_token?: string;
  }>('/auth/login', { username, password });
}

export function getMe() {
  return api.get<{ id: string; username: string; is_admin: boolean; totp_enabled: boolean }>('/auth/me');
}

export function logout() {
  return api.post('/auth/logout');
}
