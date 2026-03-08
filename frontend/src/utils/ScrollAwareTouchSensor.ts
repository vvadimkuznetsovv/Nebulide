/**
 * Custom touch sensor for @dnd-kit that properly handles scroll vs drag on mobile.
 *
 * Interaction model:
 *   - Touch + move immediately → SCROLL (tolerance exceeded or container scrolls)
 *   - Touch + hold 700ms + move → DRAG (ready state, activate on any movement)
 *   - Touch + hold 1200ms → CONTEXT MENU (cancelPendingDrag cancels sensor)
 *
 * Key differences from built-in TouchSensor:
 *   1. Monitors scrollable container — if it scrolls during delay, cancel
 *   2. After delay, enters "ready" state — does NOT call onStart yet
 *   3. Any touchmove in ready state → immediately activates drag (preventDefault)
 *   4. Exports cancelPendingDrag() so long-press can cancel the sensor
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

let cancelCurrentSensor: (() => void) | null = null;

const CONTEXT_MENU_MS = 1200; // must match useLongPress LONG_PRESS_MS

/** Creates a two-phase progress ring: purple (DnD) then white (context menu) */
function createProgressRing(x: number, y: number, delayMs: number): {
  el: HTMLElement;
  startPhase2: () => void;
} {
  const size = 80;
  const r = 30;
  const sw = 4;
  const circ = 2 * Math.PI * r;
  const phase2Ms = CONTEXT_MENU_MS - delayMs;
  const rot = 'transform:rotate(-90deg);transform-origin:center';
  const el = document.createElement('div');
  el.style.cssText = `
    position:fixed;z-index:99999;pointer-events:none;
    left:${x - size / 2}px;top:${y - size / 2}px;
    width:${size}px;height:${size}px;
    transition:opacity 0.15s;
  `;
  el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs>
      <filter id="glow1"><feGaussianBlur stdDeviation="2.5" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="glow2"><feGaussianBlur stdDeviation="3" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}"
      fill="none" stroke="rgba(160,60,255,0.15)" stroke-width="${sw}"/>
    <circle id="phase1" cx="${size / 2}" cy="${size / 2}" r="${r}"
      fill="none" stroke="rgb(180,80,255)" stroke-width="${sw}"
      stroke-linecap="round" filter="url(#glow1)"
      stroke-dasharray="${circ}" stroke-dashoffset="${circ}"
      style="transition:stroke-dashoffset ${delayMs}ms linear;${rot}"/>
    <circle id="phase2" cx="${size / 2}" cy="${size / 2}" r="${r}"
      fill="none" stroke="rgb(255,255,255)" stroke-width="${sw}"
      stroke-linecap="round" filter="url(#glow2)"
      stroke-dasharray="${circ}" stroke-dashoffset="${circ}"
      style="${rot}"/>
  </svg>`;
  document.body.appendChild(el);

  // Start phase 1 animation (purple fills over delayMs)
  requestAnimationFrame(() => {
    const p1 = el.querySelector('#phase1') as SVGCircleElement | null;
    if (p1) p1.style.strokeDashoffset = '0';
  });

  return {
    el,
    startPhase2() {
      const p2 = el.querySelector('#phase2') as SVGCircleElement | null;
      if (p2) {
        p2.style.transition = `stroke-dashoffset ${phase2Ms}ms linear`;
        requestAnimationFrame(() => { p2.style.strokeDashoffset = '0'; });
      }
    },
  };
}

function removeIndicatorSmooth(el: HTMLElement | null) {
  if (!el) return;
  el.style.opacity = '0';
  setTimeout(() => el.remove(), 150);
}

/** Cancel any pending (not yet activated) drag. */
export function cancelPendingDrag() {
  cancelCurrentSensor?.();
  cancelCurrentSensor = null;
}

interface ScrollAwareTouchSensorOptions {
  delay?: number;
  tolerance?: number;
}

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
    const delay = options.delay ?? 300;
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

    let ready = false;
    let activated = false;
    let done = false;
    let indicator: { el: HTMLElement; startPhase2: () => void } | null = null;

    // Show progress ring immediately
    indicator = createProgressRing(initialX, initialY, delay);

    const removeIndicator = () => {
      removeIndicatorSmooth(indicator?.el ?? null);
      indicator = null;
    };

    const cleanup = () => {
      if (done) return;
      done = true;
      cancelCurrentSensor = null;
      removeIndicator();
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

    cancelCurrentSensor = () => {
      if (!activated) abort();
    };

    const hasScrolled = () => {
      if (!scrollParent) return false;
      const dY = Math.abs(scrollParent.scrollTop - initialScrollTop);
      const dX = Math.abs(scrollParent.scrollLeft - initialScrollLeft);
      return dY > 3 || dX > 3;
    };

    const handleScroll = () => {
      if (!activated && hasScrolled()) abort();
    };

    const handleMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;

      if (activated) {
        if (e.cancelable) e.preventDefault();
        onMove({ x: t.clientX, y: t.clientY });
      } else if (ready) {
        // Ready state: purple ring filled. Any movement = drag.
        activated = true;
        cancelCurrentSensor = null;
        removeIndicator();
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
      if (hasScrolled()) {
        abort();
        return;
      }
      ready = true;
      indicator?.startPhase2();
    }, delay);

    document.addEventListener('touchmove', handleMove, { passive: false });
    document.addEventListener('touchend', handleEnd);
    document.addEventListener('touchcancel', handleAbort);
    scrollParent?.addEventListener('scroll', handleScroll, { passive: true });
  }
}
