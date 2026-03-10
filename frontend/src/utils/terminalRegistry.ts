// Terminal numbering registry.
// Module-level Map<instanceId, number> assigns sequential numbers to terminals.
// All terminals get numbers: default → 1, next → 2, 3, ...

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
  if (registry.has(instanceId)) return registry.get(instanceId)!;
  const num = nextFreeNumber();
  registry.set(instanceId, num);
  usedNumbers.add(num);
  bump();
  return num;
}

export function unregisterTerminal(instanceId: string): void {
  const num = registry.get(instanceId);
  if (num == null) return;
  registry.delete(instanceId);
  usedNumbers.delete(num);
  bump();
}

export function getTerminalNumber(instanceId: string): number | null {
  return registry.get(instanceId) ?? null;
}

export function getTerminalLabel(instanceId: string): string {
  const num = registry.get(instanceId);
  return num != null ? `Terminal-${num}` : 'Terminal';
}

export function getAllTerminalIds(): string[] {
  return Array.from(registry.keys());
}

/** Clear the entire registry. Called before layout restore to prevent stale numbering. */
export function resetTerminalRegistry(): void {
  registry.clear();
  usedNumbers.clear();
  bump();
}

/** React hook — re-renders when the registry changes. */
export function useTerminalRegistryVersion(): number {
  return useRegistryAtom((s) => s.version);
}
