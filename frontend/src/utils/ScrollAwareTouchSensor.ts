/**
 * Custom touch sensor for @dnd-kit that properly handles scroll vs drag on mobile.
 *
 * Interaction model:
 *   - Touch and immediately move → SCROLL (finger moved during delay → cancel)
 *   - Touch, hold 500ms, then move → DRAG (delay passed, movement = drag intent)
 *   - Touch, hold 700ms without moving → CONTEXT MENU (long press fires, cancels sensor)
 *
 * Key difference from built-in TouchSensor:
 *   1. Monitors scrollable container — if it scrolls during delay, cancel
 *   2. After delay, enters "ready" state but does NOT call onStart yet
 *   3. Only activates drag on MOVEMENT after the delay (prevents instant grab)
 *   4. Exports cancelPendingDrag() so long-press context menu can cancel the sensor
 */

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  while (el && el !== document.body) {
    const { overflow, overflowY } = getComputedStyle(el);
    if (/(auto|scroll)/.test(overflow + overflowY) && el.scrollHeight > el.clientHeight) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

// Module-level: allows external code (e.g. long-press hook) to cancel a pending drag
let cancelCurrentSensor: (() => void) | null = null;

/** Cancel any pending (not yet activated) drag. Called from long-press context menu. */
export function cancelPendingDrag() {
  cancelCurrentSensor?.();
  cancelCurrentSensor = null;
}

interface ScrollAwareTouchSensorOptions {
  delay?: number;
  tolerance?: number;
}

// Matches @dnd-kit v6.3.x SensorProps shape
interface SensorProps {
  event: Event;
  active: string | number;
  onStart(coordinates: { x: number; y: number }): void;
  onCancel(): void;
  onMove(coordinates: { x: number; y: number }): void;
  onEnd(): void;
  onAbort(id: string | number): void;
  options: ScrollAwareTouchSensorOptions;
  [key: string]: unknown;
}

export class ScrollAwareTouchSensor {
  autoScrollEnabled = true;

  // Required for iOS Safari: a non-passive touchmove listener on window
  // ensures that dynamically added touchmove handlers can call preventDefault()
  static setup() {
    window.addEventListener('touchmove', noop, { capture: false, passive: false });
    return function teardown() {
      window.removeEventListener('touchmove', noop);
    };
    function noop() {}
  }

  static activators = [
    {
      eventName: 'onTouchStart' as const,
      handler: (
        event: React.TouchEvent,
        _options: ScrollAwareTouchSensorOptions,
      ) => {
        const { nativeEvent } = event;
        if (nativeEvent.touches.length > 1) return false;
        return true;
      },
    },
  ];

  constructor(props: SensorProps) {
    const { event, active, onStart, onCancel, onMove, onEnd, onAbort, options } = props;
    const delay = options.delay ?? 500;
    const tolerance = options.tolerance ?? 10;
    const toleranceSq = tolerance * tolerance;

    const touchEvent = event as TouchEvent;
    const touch = touchEvent.touches?.[0];
    if (!touch) {
      onAbort(active);
      onCancel();
      return;
    }

    const initialX = touch.clientX;
    const initialY = touch.clientY;

    const target = touchEvent.target as HTMLElement;
    const scrollParent = findScrollParent(target);
    const initialScrollTop = scrollParent?.scrollTop ?? 0;
    const initialScrollLeft = scrollParent?.scrollLeft ?? 0;

    let ready = false;     // delay passed, waiting for movement
    let activated = false; // drag actually started (onStart called)
    let done = false;

    const cleanup = () => {
      if (done) return;
      done = true;
      cancelCurrentSensor = null;
      clearTimeout(timer);
      document.removeEventListener('touchmove', handleMove);
      document.removeEventListener('touchend', handleEnd);
      document.removeEventListener('touchcancel', handleAbort);
      scrollParent?.removeEventListener('scroll', handleScroll);
    };

    const abort = () => {
      if (done) return;
      cleanup();
      onAbort(active);
      onCancel();
    };

    // External cancel: only cancels if not yet activated (drag not started)
    cancelCurrentSensor = () => {
      if (!activated) abort();
    };

    // If scrollable parent scrolls significantly during delay → not a drag
    const handleScroll = () => {
      if (activated || !scrollParent) return;
      const dY = Math.abs(scrollParent.scrollTop - initialScrollTop);
      const dX = Math.abs(scrollParent.scrollLeft - initialScrollLeft);
      if (dY > 3 || dX > 3) abort();
    };

    const handleMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;

      if (activated) {
        // Drag is active — prevent scroll, report coordinates
        if (e.cancelable) e.preventDefault();
        onMove({ x: t.clientX, y: t.clientY });
      } else if (ready) {
        // Delay passed, user moved → NOW activate drag
        activated = true;
        cancelCurrentSensor = null; // no longer cancellable externally
        if (e.cancelable) e.preventDefault();
        onStart({ x: initialX, y: initialY });
        onMove({ x: t.clientX, y: t.clientY });
      } else {
        // Still in delay period — check if finger moved beyond tolerance
        const dx = t.clientX - initialX;
        const dy = t.clientY - initialY;
        if (dx * dx + dy * dy > toleranceSq) {
          abort();
        }
      }
    };

    const handleEnd = () => {
      if (done) return;
      cleanup();
      if (activated) {
        onEnd();
      } else {
        onAbort(active);
        onCancel();
      }
    };

    const handleAbort = () => {
      abort();
    };

    const timer = setTimeout(() => {
      if (done) return;

      // Double-check: did the container scroll during the delay?
      if (scrollParent) {
        const dY = Math.abs(scrollParent.scrollTop - initialScrollTop);
        const dX = Math.abs(scrollParent.scrollLeft - initialScrollLeft);
        if (dY > 2 || dX > 2) {
          abort();
          return;
        }
      }

      // Enter "ready" state — don't activate until user moves
      ready = true;
    }, delay);

    // passive: false so we CAN preventDefault after activation
    document.addEventListener('touchmove', handleMove, { passive: false });
    document.addEventListener('touchend', handleEnd);
    document.addEventListener('touchcancel', handleAbort);
    scrollParent?.addEventListener('scroll', handleScroll, { passive: true });
  }
}
