import { useSyncExternalStore } from 'react';

// Per-terminal-instance view mode: raw xterm terminal vs. the Claude chat-view
// wrapper. Module-level so it survives panel hide/show remounts. Also stores an
// optional cwd hint (the dir claude was launched in) to improve live resolution.

export type TerminalViewMode = 'terminal' | 'chat';

// Провайдер модели per-instance: Anthropic (дефолт) или GLM (Z.ai). Решает, какой ANTHROPIC_*
// env уйдёт в PTY (см. бэк providerEnv). Фронт прокидывает его в WS-URL (?provider=glm).
export type ClaudeProvider = 'anthropic' | 'glm';

const modes = new Map<string, TerminalViewMode>();
const providers = new Map<string, ClaudeProvider>();
const cwdHints = new Map<string, string>();
// Instances launched in a possibly-untrusted (new) folder. Claude shows a
// "Is this a project you trust?" prompt as its FIRST screen there, which blocks
// the session and produces no JSONL yet. For these we surface the real terminal
// first (so the user answers the native prompt), then flip to the chat ribbon
// once the session JSONL resolves. Only set for brand-new "chat in folder".
const trustPending = new Set<string>();
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

export function getTerminalProvider(instanceId: string): ClaudeProvider {
  return providers.get(instanceId) ?? 'anthropic';
}

export function setTerminalProvider(instanceId: string, provider: ClaudeProvider) {
  if (providers.get(instanceId) === provider) return;
  providers.set(instanceId, provider);
  bump();
}

export function getTerminalCwdHint(instanceId: string): string | undefined {
  return cwdHints.get(instanceId);
}

export function setTerminalCwdHint(instanceId: string, cwd: string) {
  if (cwd) cwdHints.set(instanceId, cwd);
}

// Точный sessionId, который пользователь открыл через --resume. Передаём в резолвер
// как детерминированную подсказку, чтобы чат сразу показал ИМЕННО эту сессию, а не
// «новейший» JSONL из фолбэка (хук-карта всё равно приоритетнее — переживёт форк).
const sessionHints = new Map<string, string>();

export function setSessionHint(instanceId: string, sessionId: string) {
  if (sessionId) sessionHints.set(instanceId, sessionId);
}

export function getSessionHint(instanceId: string): string | undefined {
  return sessionHints.get(instanceId);
}

export function markTrustPending(instanceId: string) {
  trustPending.add(instanceId);
}

export function hasTrustPending(instanceId: string): boolean {
  return trustPending.has(instanceId);
}

export function consumeTrustPending(instanceId: string) {
  trustPending.delete(instanceId);
}

export function clearTerminalViewMode(instanceId: string) {
  modes.delete(instanceId);
  providers.delete(instanceId);
  cwdHints.delete(instanceId);
  trustPending.delete(instanceId);
  sessionHints.delete(instanceId);
  bump();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTerminalViewModeVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

// ── Default launch mode for newly opened Claude sessions (user preference) ──
//
// Тройной выбор «Открывать как»: Anthropic (терминал + Anthropic), интерфейс (чат-лента),
// Z (терминал + GLM). Собирает в одном переключателе ДВЕ оси — вид (терминал/чат) и провайдера.

export type ClaudeLaunchMode = 'anthropic' | 'interface' | 'z';

// Маппер launchMode → (вид, провайдер). Чистый — используется и в UI, и в тестах.
export function launchModeToViewProvider(m: ClaudeLaunchMode): { view: TerminalViewMode; provider: ClaudeProvider } {
  switch (m) {
    case 'interface': return { view: 'chat', provider: 'anthropic' };
    case 'z':         return { view: 'terminal', provider: 'glm' };
    case 'anthropic':
    default:          return { view: 'terminal', provider: 'anthropic' };
  }
}

const LAUNCH_MODE_KEY = 'nebulide-claude-launch-mode';
const OPEN_MODE_KEY = 'nebulide-claude-open-mode'; // старый ключ (terminal|chat) — мигрируем

function readLaunchMode(): ClaudeLaunchMode {
  const v = localStorage.getItem(LAUNCH_MODE_KEY);
  if (v === 'anthropic' || v === 'interface' || v === 'z') return v;
  // Миграция со старого openMode: chat → interface, terminal/прочее → anthropic.
  return localStorage.getItem(OPEN_MODE_KEY) === 'chat' ? 'interface' : 'anthropic';
}

let launchMode: ClaudeLaunchMode = readLaunchMode();

export function getClaudeLaunchMode(): ClaudeLaunchMode {
  return launchMode;
}

export function setClaudeLaunchMode(mode: ClaudeLaunchMode) {
  launchMode = mode;
  localStorage.setItem(LAUNCH_MODE_KEY, mode);
  bump();
}

export function useClaudeLaunchMode(): ClaudeLaunchMode {
  useTerminalViewModeVersion();
  return launchMode;
}
