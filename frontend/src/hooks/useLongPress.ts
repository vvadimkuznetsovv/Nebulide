import { useRef, useCallback } from 'react';

/** Merge two sets of event handlers so both fire for the same event key */
export function mergeEventHandlers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  a: Record<string, ((...args: any[]) => void) | undefined>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  b: Record<string, ((...args: any[]) => void) | undefined>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, (...args: any[]) => void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const merged: Record<string, (...args: any[]) => void> = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const fa = a[key];
    const fb = b[key];
    if (fa && fb) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      merged[key] = (...args: any[]) => { fa(...args); fb(...args); };
    } else {
      merged[key] = (fa || fb)!;
    }
  }
  return merged;
}

const LONG_PRESS_MS = 500;
const MOVE_THRESHOLD_SQ = 100; // 10px squared

interface UseLongPressOptions {
  onLongPress: (x: number, y: number) => void;
  stopPropagation?: boolean;
}

/**
 * Reusable long-press hook for mobile context menus.
 *
 * Uses pointer events (not touch) so it coexists with @dnd-kit's
 * pointer-based sensors without event conflicts.
 *
 * - Fires after 500ms hold without moving > 10px (touch/pen only, not mouse)
 * - Cancels on scroll (movement threshold)
 *
 * Returns `{ handlers, longPressedRef }`:
 * - Spread `handlers` onto the element
 * - Use `longPressedRef.current` to guard `onClick` from firing after long-press
 */
export function useLongPress({ onLongPress, stopPropagation = false }: UseLongPressOptions) {
  const timerRef = useRef<number>(0);
  const longPressedRef = useRef(false);
  const startPos = useRef({ x: 0, y: 0 });
  const activePointerRef = useRef<number | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Only long-press for touch/pen, not mouse (mouse has right-click)
    if (e.pointerType === 'mouse') return;
    if (stopPropagation) e.stopPropagation();
    longPressedRef.current = false;
    activePointerRef.current = e.pointerId;
    const x = e.clientX;
    const y = e.clientY;
    startPos.current = { x, y };
    timerRef.current = window.setTimeout(() => {
      longPressedRef.current = true;
      onLongPress(x, y);
    }, LONG_PRESS_MS);
  }, [onLongPress, stopPropagation]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (e.pointerId !== activePointerRef.current) return;
    activePointerRef.current = null;
    clearTimeout(timerRef.current);
    // Prevent click/touchend from firing after successful long-press
    if (longPressedRef.current) {
      e.preventDefault();
      if (stopPropagation) e.stopPropagation();
    }
  }, [stopPropagation]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (e.pointerId !== activePointerRef.current) return;
    const dx = e.clientX - startPos.current.x;
    const dy = e.clientY - startPos.current.y;
    if (dx * dx + dy * dy > MOVE_THRESHOLD_SQ) {
      clearTimeout(timerRef.current);
    }
  }, []);

  const onPointerCancel = useCallback((e: React.PointerEvent) => {
    if (e.pointerId !== activePointerRef.current) return;
    activePointerRef.current = null;
    clearTimeout(timerRef.current);
  }, []);

  return {
    handlers: { onPointerDown, onPointerUp, onPointerMove, onPointerCancel },
    longPressedRef,
  };
}
