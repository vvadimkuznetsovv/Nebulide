// WebSocket URL for the headless agent chat (Claude Agent SDK bridge).
export function agentWsUrl(opts: { cwd?: string; resume?: string; mode?: string }): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = localStorage.getItem('access_token') || '';
  const params = new URLSearchParams({ token });
  if (opts.cwd) params.set('cwd', opts.cwd);
  if (opts.resume) params.set('resume', opts.resume);
  if (opts.mode) params.set('mode', opts.mode);
  return `${protocol}//${window.location.host}/ws/agent?${params.toString()}`;
}

export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';
export type PermissionScope = 'session' | 'project' | 'always';
