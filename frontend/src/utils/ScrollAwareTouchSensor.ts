/**
 * Custom touch sensor for @dnd-kit that detects scroll and cancels drag activation.
 *
 * Problem: @dnd-kit's built-in TouchSensor only checks finger movement (clientX/Y).
 * When the user scrolls a list, the finger may pause briefly between swipes — the
 * sensor sees "finger didn't move" and activates drag after the delay, hijacking scroll.
 *
 * Solution: also monitor the nearest scrollable ancestor's scrollTop/scrollLeft.
 * If the container scrolls during the delay period → cancel drag activation.
 * Only after the delay passes with NO scroll and NO finger movement → activate drag.
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

interface SensorOptions {
  delay?: number;
  tolerance?: number;
}

// Minimal types matching @dnd-kit's sensor interface (v6.3.x)
interface SensorProps {
  event: Event;
  onStart(coordinates: { x: number; y: number }): void;
  onCancel(): void;
  onMove(coordinates: { x: number; y: number }): void;
  onEnd(): void;
  options: SensorOptions;
  // other fields exist but we don't use them
  [key: string]: unknown;
}

export class ScrollAwareTouchSensor {
  autoScrollEnabled = true;

  static activators = [
    {
      eventName: 'onTouchStart' as const,
      handler: (
        event: React.TouchEvent,
        { onActivation }: { onActivation(opts: { event: Event }): void },
      ) => {
        const { nativeEvent } = event;
        if (nativeEvent.touches.length > 1) return false;
        onActivation({ event: nativeEvent });
        return false; // Don't preventDefault — let browser handle scroll
      },
    },
  ];

  constructor(props: SensorProps) {
    const { event, onStart, onCancel, onMove, onEnd, options } = props;
    const delay = options.delay ?? 500;
    const tolerance = options.tolerance ?? 10;
    const toleranceSq = tolerance * tolerance;

    const touchEvent = event as TouchEvent;
    const touch = touchEvent.touches[0];
    if (!touch) { onCancel(); return; }

    const initialX = touch.clientX;
    const initialY = touch.clientY;

    const target = touchEvent.target as HTMLElement;
    const scrollParent = findScrollParent(target);
    const initialScrollTop = scrollParent?.scrollTop ?? 0;
    const initialScrollLeft = scrollParent?.scrollLeft ?? 0;

    let activated = false;
    let done = false;

    const cleanup = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      document.removeEventListener('touchmove', handleMove);
      document.removeEventListener('touchend', handleEnd);
      document.removeEventListener('touchcancel', handleAbort);
      scrollParent?.removeEventListener('scroll', handleScroll);
    };

    const abort = () => {
      if (done) return;
      cleanup();
      onCancel();
    };

    // If scrollable parent scrolls during delay → not a drag, it's a scroll
    const handleScroll = () => {
      if (!activated) abort();
    };

    const handleMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;

      if (activated) {
        // We own the gesture — prevent browser scroll, report move
        e.preventDefault();
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

      activated = true;
      onStart({ x: initialX, y: initialY });
    }, delay);

    // passive: false so we CAN preventDefault after activation
    document.addEventListener('touchmove', handleMove, { passive: false });
    document.addEventListener('touchend', handleEnd);
    document.addEventListener('touchcancel', handleAbort);
    scrollParent?.addEventListener('scroll', handleScroll, { passive: true });
  }
}
