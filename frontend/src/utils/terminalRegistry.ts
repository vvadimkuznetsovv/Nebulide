// Terminal numbering registry.
// Module-level Map<instanceId, number> assigns sequential numbers to terminals.
// "default" terminal has no number (label "Terminal"); detached terminals get 1, 2, 3...

import { create } from 'zustand';

// ── Module-level state ──

const registry = new Map<string, number>();
const usedNumbers = new Set<number>();

function nextFreeNumber(): number {
  let n = 1;
  while (usedNumbers.has(n)) n++;
  return n;
}

// ── Tiny Zustand atom so React components can subscribe to changes ──

interface RegistryAtom { version: number }
const useRegistryAtom = create<RegistryAtom>(() => ({ version: 0 }));
function bump() { useRegistryAtom.setState((s) => ({ version: s.version + 1 })); }

// ── Public API ──

export function registerTerminal(instanceId: string): number {
  if (instanceId === 'default') return 0; // default doesn't get a number
  if (registry.has(instanceId)) return registry.get(instanceId)!;
  const num = nextFreeNumber();
  registry.set(instanceId, num);
  usedNumbers.add(num);
  bump();
  return num;
}

export function unregisterTerminal(instanceId: string): void {
  if (instanceId === 'default') return;
  const num = registry.get(instanceId);
  if (num == null) return;
  registry.delete(instanceId);
  usedNumbers.delete(num);
  bump();
}

export function getTerminalNumber(instanceId: string): number | null {
  if (instanceId === 'default') return null;
  return registry.get(instanceId) ?? null;
}

export function getTerminalLabel(instanceId: string): string {
  if (instanceId === 'default') return 'Terminal';
  const num = registry.get(instanceId);
  return num != null ? `Terminal-${num}` : 'Terminal';
}

export function getAllTerminalIds(): string[] {
  return Array.from(registry.keys());
}

/** React hook — re-renders when the registry changes. */
export function useTerminalRegistryVersion(): number {
  return useRegistryAtom((s) => s.version);
}
