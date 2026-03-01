import api from './client';

export interface WorkspaceSession {
  id: string;
  user_id: string;
  name: string;
  device_tag: string;
  snapshot: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export const getWorkspaceSessions = () =>
  api.get<WorkspaceSession[]>('/workspace-sessions');

export const getLatestWorkspaceSession = () =>
  api.get<WorkspaceSession>('/workspace-sessions/latest');

export const createWorkspaceSession = (name: string, deviceTag: string, snapshot: Record<string, unknown>) =>
  api.post<WorkspaceSession>('/workspace-sessions', { name, device_tag: deviceTag, snapshot });

export const updateWorkspaceSession = (id: string, data: { name?: string; snapshot?: Record<string, unknown> }) =>
  api.put<WorkspaceSession>(`/workspace-sessions/${id}`, data);

export const deleteWorkspaceSession = (id: string) =>
  api.delete(`/workspace-sessions/${id}`);
