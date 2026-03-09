import api from './client';

export interface ClaudeSession {
  session_id: string;
  slug: string;
  cwd: string;
  created_at: string;
  updated_at: string;
  size_mb: number;
  first_message: string;
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
