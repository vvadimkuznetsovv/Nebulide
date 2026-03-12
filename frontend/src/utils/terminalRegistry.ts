// Terminal numbering registry.
// Module-level Map<instanceId, number> assigns sequential numbers to terminals.
// Numbers are assigned lazily on mount (registerTerminal), not eagerly on restore.
// Snapshot numbers are stored as hints — applied when the terminal actually mounts.

import { create } from 'zustand';

// ── Module-level state ──

const registry = new Map<string, number>();
const usedNumbers = new Set<number>();
const customNames = new Map<string, string>();

/** Pending numbers from snapshot — used as hints when terminals register on mount. */
let pendingNumbers: Record<string, number> = {};

/** Recently closed terminals — prevents stale snapshot restore from resurrecting them.
 *  Map<instanceId, closeTimestamp>. Entries expire after CLOSED_EXPIRY_MS. */
const closedTerminals = new Map<string, number>();
const CLOSED_EXPIRY_MS = 10_000;

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
  // Use pending number from snapshot if available (and not already taken)
  let num: number | undefined;
  if (instanceId in pendingNumbers) {
    const hint = pendingNumbers[instanceId];
    delete pendingNumbers[instanceId];
    if (!usedNumbers.has(hint)) num = hint;
  }
  if (num == null) num = nextFreeNumber();
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
  customNames.delete(instanceId);
  // Compact: close gaps so remaining terminals are 1, 2, 3...
  // e.g. if Terminal-1 removed and Terminal-2 remains → becomes Terminal-1
  if (registry.size > 0) {
    const entries = [...registry.entries()].sort((a, b) => a[1] - b[1]);
    registry.clear();
    usedNumbers.clear();
    let n = 1;
    for (const [id] of entries) {
      registry.set(id, n);
      usedNumbers.add(n);
      n++;
    }
  }
  bump();
}

export function getTerminalNumber(instanceId: string): number | null {
  return registry.get(instanceId) ?? null;
}

export function getTerminalLabel(instanceId: string): string {
  const custom = customNames.get(instanceId);
  if (custom) return custom;
  const num = registry.get(instanceId);
  return num != null ? `Terminal-${num}` : 'Terminal';
}

export function setTerminalName(instanceId: string, name: string): void {
  const trimmed = name.trim();
  if (trimmed) {
    customNames.set(instanceId, trimmed);
  } else {
    customNames.delete(instanceId);
  }
  bump();
}

export function getTerminalCustomName(instanceId: string): string | null {
  return customNames.get(instanceId) ?? null;
}

export function getAllTerminalIds(): string[] {
  return Array.from(registry.keys());
}

/** Clear the entire registry and pending hints. */
export function resetTerminalRegistry(): void {
  registry.clear();
  usedNumbers.clear();
  customNames.clear();
  pendingNumbers = {};
  bump();
}

/** Store number hints from snapshot — applied lazily when terminals mount. */
export function setPendingNumbers(numbers: Record<string, number>): void {
  pendingNumbers = { ...numbers };
}

/** Mark a terminal as recently closed — survives resetTerminalRegistry(). */
export function markTerminalClosed(instanceId: string): void {
  closedTerminals.set(instanceId, Date.now());
}

/** Check if a terminal was closed within the last CLOSED_EXPIRY_MS. */
export function isTerminalRecentlyClosed(instanceId: string): boolean {
  const ts = closedTerminals.get(instanceId);
  if (!ts) return false;
  if (Date.now() - ts > CLOSED_EXPIRY_MS) {
    closedTerminals.delete(instanceId);
    return false;
  }
  return true;
}

/** Clear closed-terminal tracking (on workspace switch). */
export function clearClosedTerminals(): void {
  closedTerminals.clear();
}

/** Get a snapshot of the registry for persistence (instanceId → number). */
export function getRegistrySnapshot(): Record<string, number> {
  const snap: Record<string, number> = {};
  for (const [id, num] of registry) snap[id] = num;
  return snap;
}

/** Get a snapshot of custom terminal names for persistence. */
export function getCustomNamesSnapshot(): Record<string, string> {
  const snap: Record<string, string> = {};
  for (const [id, name] of customNames) snap[id] = name;
  return snap;
}

/** Restore custom terminal names from a snapshot. */
export function setCustomNames(names: Record<string, string>): void {
  customNames.clear();
  for (const [id, name] of Object.entries(names)) {
    customNames.set(id, name);
  }
  bump();
}

/** React hook — re-renders when the registry changes. */
export function useTerminalRegistryVersion(): number {
  return useRegistryAtom((s) => s.version);
}
