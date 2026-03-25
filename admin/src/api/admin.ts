import api from './client';

export interface UserListItem {
  id: string;
  username: string;
  is_admin: boolean;
  created_at: string;
  workspace_size_bytes: number;
  active_pty_count: number;
}

export interface UserDetail extends UserListItem {
  totp_enabled: boolean;
  workspace_file_count: number;
}

export interface TerminalSession {
  session_key: string;
  instance_id: string;
  alive: boolean;
  pid: number;
  memory_rss_bytes: number;
  cpu_percent: number;
  command: string;
  writer_count: number;
  status: 'active' | 'hidden' | 'offline';
}

export interface Invite {
  id: string;
  code: string;
  created_by: string;
  created_by_username: string;
  used_by: string | null;
  used_by_username: string;
  used_at: string | null;
  expires_at: string;
  created_at: string;
}

export interface Stats {
  total_users: number;
  total_workspaces_size: number;
  active_pty_count: number;
  invites_pending: number;
}

// Users
export const getUsers = () => api.get<UserListItem[]>('/admin/users');
export const getUser = (id: string) => api.get<UserDetail>(`/admin/users/${id}`);
export const deleteUser = (id: string) => api.delete(`/admin/users/${id}`);

// Terminals
export const getUserTerminals = (id: string) => api.get<TerminalSession[]>(`/admin/users/${id}/terminals`);
export const killTerminal = (userId: string, instanceId: string) =>
  api.delete(`/admin/users/${userId}/terminals/${instanceId}`);
export const forceKillTerminal = (userId: string, instanceId: string) =>
  api.delete(`/admin/users/${userId}/terminals/${instanceId}?force=true`);

// Sessions
export interface WorkspaceSession {
  id: string;
  user_id: string;
  name: string;
  device_tag: string;
  created_at: string;
  updated_at: string;
}
export const getUserSessions = (id: string) => api.get<WorkspaceSession[]>(`/admin/users/${id}/sessions`);
export const deleteUserSession = (userId: string, sessionId: string) =>
  api.delete(`/admin/users/${userId}/sessions/${sessionId}`);

// Workspace
export const getWorkspaceStats = (id: string) => api.get(`/admin/users/${id}/workspace/stats`);
export const deleteWorkspace = (id: string) => api.delete(`/admin/users/${id}/workspace`);

// Invites
export const getInvites = () => api.get<Invite[]>('/admin/invites');
export const createInvite = (expiresInHours = 72) =>
  api.post<Invite>('/admin/invites', { expires_in_hours: expiresInHours });
export const deleteInvite = (id: string) => api.delete(`/admin/invites/${id}`);

// Stats
export const getStats = () => api.get<Stats>('/admin/stats');

// Monitoring
export interface ProcessInfo {
  pid: number;
  user_id: string;
  username: string;
  session_key: string;
  instance_id: string;
  alive: boolean;
  cpu_percent: number;
  memory_rss_bytes: number;
  command: string;
  writer_count: number;
  status: 'active' | 'hidden' | 'offline' | 'system';
}

export interface SystemInfo {
  cpu_count: number;
  cpu_percent: number;
  goroutines: number;
  mem_total_bytes: number;
  mem_used_bytes: number;
  mem_percent: number;
  disk_total_bytes: number;
  disk_used_bytes: number;
  disk_percent: number;
}

export interface MonitoringData {
  system: SystemInfo;
  processes: ProcessInfo[];
}

export const getMonitoring = () => api.get<MonitoringData>('/admin/monitoring');
export const killProcess = (pid: number) => api.delete(`/admin/kill-process/${pid}`);
