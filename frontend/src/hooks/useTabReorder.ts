import { useSyncExternalStore } from 'react';

/**
 * Module-level tab reorder state.
 * Uses useSyncExternalStore to avoid full Zustand store re-renders on every pointer move.
 */

export interface ReorderHover {
  containerId: string;    // 'editor-main' | layoutNodeId (for panel tabs)
  insertIndex: number;    // where to insert (0-based, before this index)
  draggedWidth: number;   // width of dragged tab (px) — gap size
  draggedId: string;      // ID of the tab being dragged
}

let _hover: ReorderHover | null = null;
const _listeners = new Set<() => void>();

function notify() {
  for (const cb of _listeners) cb();
}

export function setReorderHover(hover: ReorderHover) {
  _hover = hover;
  notify();
}

export function clearReorderHover() {
  if (_hover === null) return;
  _hover = null;
  notify();
}

export function getReorderHover(): ReorderHover | null {
  return _hover;
}

function subscribe(cb: () => void) {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}

function getSnapshot(): ReorderHover | null {
  return _hover;
}

export function useReorderHover(): ReorderHover | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Calculate translateX for a tab at `tabIndex` in container `containerId`.
 * `draggedIndex` is the index of the dragged tab in this container (-1 if from another container).
 */
export function getTabShift(
  hover: ReorderHover | null,
  containerId: string,
  tabIndex: number,
  draggedIndex: number,
): number {
  if (!hover || hover.containerId !== containerId) return 0;

  const { insertIndex, draggedWidth } = hover;

  // Tab being dragged — hidden (DragOverlay shows ghost)
  if (tabIndex === draggedIndex) return 0;

  // Adjust for the gap left by the dragged tab being "removed" visually
  // When dragging within same container:
  if (draggedIndex >= 0) {
    // Effective index ignoring the dragged tab
    const effectiveInsert = insertIndex > draggedIndex ? insertIndex - 1 : insertIndex;
    const effectiveTab = tabIndex > draggedIndex ? tabIndex - 1 : tabIndex;

    if (tabIndex > draggedIndex && effectiveTab >= effectiveInsert) {
      return draggedWidth;
    }
    if (tabIndex < draggedIndex && effectiveTab >= effectiveInsert) {
      return draggedWidth;
    }
    return 0;
  }

  // Dragging from another container — simple shift
  if (tabIndex >= insertIndex) {
    return draggedWidth;
  }
  return 0;
}
