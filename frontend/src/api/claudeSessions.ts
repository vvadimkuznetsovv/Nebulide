import api from './client';

export interface ClaudeSession {
  session_id: string;
  slug: string;
  cwd: string;
  created_at: string;
  updated_at: string;
  size_mb: number;
  first_message: string;
  project: string;
}

export interface ClaudeSessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export interface ClaudeProject {
  slug: string;
  sessions: ClaudeSession[];
}

export interface ClaudePlan {
  slug: string;
  title: string;
  updated_at: string;
  size: number;
}

export const listClaudeSessions = () =>
  api.get<{ projects: ClaudeProject[] }>('/claude-sessions');

export const listClaudePlans = () =>
  api.get<{ plans: ClaudePlan[] }>('/claude-plans');

export const readClaudePlan = (slug: string) =>
  api.get<{ slug: string; content: string; title: string }>(`/claude-plans/${slug}`);

export const readClaudeSession = (project: string, sessionFile: string) =>
  api.get<{ messages: ClaudeSessionMessage[] }>(`/claude-sessions/${encodeURIComponent(project)}/${encodeURIComponent(sessionFile)}`);

export interface ClaudeSearchResult {
  session_id: string;
  project: string;
  slug: string;
  updated_at: string;
  size_mb: number;
  snippet: string;
}

export const searchClaudeSessions = (q: string) =>
  api.get<{ results: ClaudeSearchResult[] }>('/claude-sessions/search', { params: { q } });

export const deleteClaudeSession = (project: string, sessionId: string) =>
  api.delete(`/claude-sessions/${encodeURIComponent(project)}/${encodeURIComponent(sessionId)}`);
