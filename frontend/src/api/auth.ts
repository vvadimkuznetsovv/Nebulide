import api from './client';

export const login = (username: string, password: string) =>
  api.post('/auth/login', { username, password });

export const totpVerify = (code: string, partialToken: string) =>
  api.post('/auth/totp-verify', { code }, {
    headers: { Authorization: `Bearer ${partialToken}` },
  });

export const totpSetup = () =>
  api.post('/auth/totp-setup');

export const totpConfirm = (code: string) =>
  api.post('/auth/totp-confirm', { code });

export const refreshToken = (token: string) =>
  api.post('/auth/refresh', { refresh_token: token });

export const logout = () =>
  api.post('/auth/logout');

export const getMe = () =>
  api.get('/auth/me');

export const changePassword = (currentPassword: string, newPassword: string) =>
  api.post('/auth/change-password', { current_password: currentPassword, new_password: newPassword });

export const register = (username: string, password: string, inviteCode: string) =>
  api.post('/auth/register', { username, password, invite_code: inviteCode });
