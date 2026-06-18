import { useSyncExternalStore } from 'react';

// Per-terminal-instance view mode: raw xterm terminal vs. the Claude chat-view
// wrapper. Module-level so it survives panel hide/show remounts. Also stores an
// optional cwd hint (the dir claude was launched in) to improve live resolution.

export type TerminalViewMode = 'terminal' | 'chat' | 'agent';

export interface AgentLaunch {
  resume?: string;
  historyProject?: string;
  historySessionFile?: string;
}

const modes = new Map<string, TerminalViewMode>();
const cwdHints = new Map<string, string>();
const agentLaunches = new Map<string, AgentLaunch>();
const listeners = new Set<() => void>();
let version = 0;

function bump() {
  version++;
  for (const l of listeners) l();
}

export function getTerminalViewMode(instanceId: string): TerminalViewMode {
  return modes.get(instanceId) ?? 'terminal';
}

export function setTerminalViewMode(instanceId: string, mode: TerminalViewMode) {
  if (modes.get(instanceId) === mode) return;
  modes.set(instanceId, mode);
  bump();
}

// Set the initial mode only if none chosen yet (used at launch from a preference).
export function setInitialTerminalViewMode(instanceId: string, mode: TerminalViewMode) {
  if (modes.has(instanceId)) return;
  modes.set(instanceId, mode);
  bump();
}

export function getTerminalCwdHint(instanceId: string): string | undefined {
  return cwdHints.get(instanceId);
}

export function setTerminalCwdHint(instanceId: string, cwd: string) {
  if (cwd) cwdHints.set(instanceId, cwd);
}

export function getAgentLaunch(instanceId: string): AgentLaunch | undefined {
  return agentLaunches.get(instanceId);
}

export function setAgentLaunch(instanceId: string, info: AgentLaunch) {
  agentLaunches.set(instanceId, info);
}

export function clearTerminalViewMode(instanceId: string) {
  modes.delete(instanceId);
  cwdHints.delete(instanceId);
  agentLaunches.delete(instanceId);
  bump();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTerminalViewModeVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

// ── Default mode for newly launched Claude sessions (user preference) ──

const OPEN_MODE_KEY = 'nebulide-claude-open-mode';
let openMode: TerminalViewMode =
  (localStorage.getItem(OPEN_MODE_KEY) as TerminalViewMode) === 'chat' ? 'chat' : 'terminal';

export function getClaudeOpenMode(): TerminalViewMode {
  return openMode;
}

export function setClaudeOpenMode(mode: TerminalViewMode) {
  openMode = mode;
  localStorage.setItem(OPEN_MODE_KEY, mode);
  bump();
}

export function useClaudeOpenMode(): TerminalViewMode {
  useTerminalViewModeVersion();
  return openMode;
}
