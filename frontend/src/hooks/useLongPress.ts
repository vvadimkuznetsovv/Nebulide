import { useRef, useCallback } from 'react';

const LONG_PRESS_MS = 500;
const MOVE_THRESHOLD_SQ = 100; // 10px squared

interface UseLongPressOptions {
  onLongPress: (x: number, y: number) => void;
  stopPropagation?: boolean;
}

/**
 * Reusable long-press hook for mobile context menus.
 *
 * - Fires after 500ms hold without moving > 10px
 * - Cancels on scroll (movement threshold)
 * - Checks `e.cancelable` before `preventDefault()` (avoids browser intervention warnings)
 *
 * Returns `{ handlers, longPressedRef }`:
 * - Spread `handlers` onto the element: `onTouchStart`, `onTouchEnd`, `onTouchMove`
 * - Use `longPressedRef.current` to guard `onClick` from firing after long-press
 */
export function useLongPress({ onLongPress, stopPropagation = false }: UseLongPressOptions) {
  const timerRef = useRef<number>(0);
  const longPressedRef = useRef(false);
  const startPos = useRef({ x: 0, y: 0 });

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (stopPropagation) e.stopPropagation();
    longPressedRef.current = false;
    const touch = e.touches[0];
    const x = touch.clientX;
    const y = touch.clientY;
    startPos.current = { x, y };
    timerRef.current = window.setTimeout(() => {
      longPressedRef.current = true;
      onLongPress(x, y);
    }, LONG_PRESS_MS);
  }, [onLongPress, stopPropagation]);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    clearTimeout(timerRef.current);
    if (longPressedRef.current && e.cancelable) {
      e.preventDefault();
      if (stopPropagation) e.stopPropagation();
    }
  }, [stopPropagation]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    const dx = touch.clientX - startPos.current.x;
    const dy = touch.clientY - startPos.current.y;
    if (dx * dx + dy * dy > MOVE_THRESHOLD_SQ) {
      clearTimeout(timerRef.current);
    }
  }, []);

  return {
    handlers: { onTouchStart, onTouchEnd, onTouchMove },
    longPressedRef,
  };
}
