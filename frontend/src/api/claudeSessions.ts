import api from './client';

export interface ClaudeSession {
  session_id: string;
  slug: string;
  name?: string;
  cwd: string;
  created_at: string;
  updated_at: string;
  size_mb: number;
  first_message: string;
  project: string;
  branch_count?: number;
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
  name?: string;
  updated_at: string;
  size_mb: number;
  snippet: string;
  first_message: string;
  cwd: string;
}

export const searchClaudeSessions = (q: string) =>
  api.get<{ results: ClaudeSearchResult[] }>('/claude-sessions/search', { params: { q } });

export interface ClaudeBranch {
  branch_id: string;
  name?: string;
  first_message: string;
  message_count: number;
  created_at: string;
  parent_msg_id: string;
}

export const listBranches = (project: string, sessionFile: string) =>
  api.get<{ branches: ClaudeBranch[] }>(`/claude-sessions/${encodeURIComponent(project)}/${encodeURIComponent(sessionFile)}/branches`);

export const deleteClaudeSession = (project: string, sessionId: string) =>
  api.delete(`/claude-sessions/${encodeURIComponent(project)}/${encodeURIComponent(sessionId)}`);

export const renameClaudeSession = (project: string, sessionId: string, name: string) =>
  api.put(`/claude-sessions/${encodeURIComponent(project)}/${encodeURIComponent(sessionId)}/rename`, { name });

// ── Chat-view wrapper: rich messages + incremental tail ──

export interface ChatBlock {
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;            // text / thinking
  name?: string;            // tool_use
  input?: unknown;          // tool_use
  tool_use_id?: string;     // tool_use / tool_result
  content?: string;         // tool_result
  is_error?: boolean;       // tool_result
}

export interface RichMessage {
  uuid: string;
  parent_uuid?: string;
  role: 'user' | 'assistant';
  blocks: ChatBlock[];
  timestamp?: string;
}

export interface LiveSessionInfo {
  project: string;
  session_file: string;
  session_id: string;
  cwd: string;
  active: boolean;
}

export interface TailResponse {
  messages: RichMessage[];
  offset: number;
  size: number;
  session_id?: string;
  name?: string;
  eof: boolean;
}

// Resolve the live Claude session JSONL for a running terminal instance.
// `cwd` is an optional hint (the dir the frontend launched claude in).
export const resolveLiveSession = (instanceId: string, cwd?: string) =>
  api.get<LiveSessionInfo>('/claude-sessions/live', { params: { instanceId, cwd } });

// Read messages appended after `offset` (append-only → stable incremental updates).
export const tailClaudeSession = (project: string, sessionFile: string, offset: number) =>
  api.get<TailResponse>(
    `/claude-sessions/${encodeURIComponent(project)}/${encodeURIComponent(sessionFile)}/tail`,
    { params: { offset } }
  );
