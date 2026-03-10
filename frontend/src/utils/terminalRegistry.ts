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

/** Get a snapshot of the registry for persistence (instanceId → number). */
export function getRegistrySnapshot(): Record<string, number> {
  const snap: Record<string, number> = {};
  for (const [id, num] of registry) snap[id] = num;
  return snap;
}

/** Restore registry from a snapshot. Only restores entries whose instanceId is in `keepIds`.
 *  Numbers are compacted (no gaps): if snapshot had {a:1, b:3} and both survive,
 *  they become {a:1, b:2}. 'default' always gets the lowest number. */
export function restoreRegistryFromSnapshot(
  snap: Record<string, number>,
  keepIds: Set<string>,
): void {
  registry.clear();
  usedNumbers.clear();
  // Collect surviving entries sorted by their original number
  const surviving: [string, number][] = [];
  for (const [id, num] of Object.entries(snap)) {
    if (keepIds.has(id)) surviving.push([id, num]);
  }
  // Sort: 'default' first, then by original number
  surviving.sort((a, b) => {
    if (a[0] === 'default') return -1;
    if (b[0] === 'default') return 1;
    return a[1] - b[1];
  });
  // Assign compacted numbers 1, 2, 3...
  let n = 1;
  for (const [id] of surviving) {
    registry.set(id, n);
    usedNumbers.add(n);
    n++;
  }
  // Register any keepIds not in snapshot (new terminals)
  for (const id of keepIds) {
    if (!registry.has(id)) {
      const num = nextFreeNumber();
      registry.set(id, num);
      usedNumbers.add(num);
    }
  }
  bump();
}

/** React hook — re-renders when the registry changes. */
export function useTerminalRegistryVersion(): number {
  return useRegistryAtom((s) => s.version);
}
