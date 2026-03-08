/**
 * Custom touch sensor for @dnd-kit that properly handles scroll vs drag on mobile.
 *
 * Interaction model:
 *   - Touch + move immediately → SCROLL (manual JS scroll for touch-action:none elements)
 *   - Touch + hold 600ms + move → DRAG (ready state, activate on any movement)
 *   - Touch + hold 1200ms → CONTEXT MENU (cancelPendingDrag cancels sensor)
 *
 * Key design:
 *   - Elements with touch-action:none: sensor manually scrolls their container.
 *     Tolerance check detects scroll intent (no scroll listener — avoids self-cancel).
 *   - Elements without touch-action:none (tabs): browser handles scroll natively.
 *     findScrollParent returns null → no manual scroll, no scroll listener.
 *   - Exports cancelPendingDrag() so long-press context menu can cancel the sensor.
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

function createProgressRing(x: number, y: number, delayMs: number): {
  el: HTMLElement;
  startPhase2: () => void;
} {
  const size = 80;
  const r = 30;
  const sw = 4.5;
  const circ = 2 * Math.PI * r;
  const phase2Ms = CONTEXT_MENU_MS - delayMs;
  const rot = 'transform:rotate(-90deg);transform-origin:center';
  const uid = Math.random().toString(36).slice(2, 8);

  // Read current accent color from CSS variables (adaptive to theme)
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7F00FF';
  const ar = parseInt(accent.slice(1, 3), 16);
  const ag = parseInt(accent.slice(3, 5), 16);
  const ab = parseInt(accent.slice(5, 7), 16);

  const el = document.createElement('div');
  el.style.cssText = `
    position:fixed;z-index:99999;pointer-events:none;
    left:${x - size / 2}px;top:${y - size / 2}px;
    width:${size}px;height:${size}px;
    transition:opacity 0.15s;
  `;
  el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs>
      <filter id="g1${uid}"><feGaussianBlur stdDeviation="3" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="g2${uid}"><feGaussianBlur stdDeviation="3.5" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}"
      fill="none" stroke="rgba(${ar},${ag},${ab},0.18)" stroke-width="${sw}"/>
    <circle id="p1" cx="${size / 2}" cy="${size / 2}" r="${r}"
      fill="none" stroke="rgb(${ar},${ag},${ab})" stroke-width="${sw}"
      stroke-linecap="round" filter="url(#g1${uid})"
      stroke-dasharray="${circ}" stroke-dashoffset="${circ}"
      style="transition:stroke-dashoffset ${delayMs}ms linear;${rot}"/>
    <circle id="p2" cx="${size / 2}" cy="${size / 2}" r="${r}"
      fill="none" stroke="rgb(255,255,255)" stroke-width="${sw}"
      stroke-linecap="round" filter="url(#g2${uid})"
      stroke-dasharray="${circ}" stroke-dashoffset="${circ}"
      style="${rot}"/>
  </svg>`;
  document.body.appendChild(el);

  requestAnimationFrame(() => {
    const p1 = el.querySelector('#p1') as SVGCircleElement | null;
    if (p1) p1.style.strokeDashoffset = '0';
  });

  return {
    el,
    startPhase2() {
      const p2 = el.querySelector('#p2') as SVGCircleElement | null;
      if (p2) {
        p2.style.transition = `stroke-dashoffset ${phase2Ms}ms linear`;
        requestAnimationFrame(() => { p2.style.strokeDashoffset = '0'; });
      }
    },
  };
}

function removeRing(el: HTMLElement | null) {
  if (!el) return;
  el.style.opacity = '0';
  setTimeout(() => el.remove(), 150);
}

/**
 * Continue manual scrolling after sensor cancels (tolerance exceeded).
 */
function startContinuationScroll(lastY: number, scrollParent: HTMLElement | null) {
  if (!scrollParent) return;
  let prevY = lastY;

  const onMove = (e: TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    scrollParent.scrollTop -= (t.clientY - prevY);
    prevY = t.clientY;
  };

  const onEnd = () => {
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);
    document.removeEventListener('touchcancel', onEnd);
  };

  document.addEventListener('touchmove', onMove, { passive: true });
  document.addEventListener('touchend', onEnd);
  document.addEventListener('touchcancel', onEnd);
}

/** Cancel any pending (not yet activated) drag. */
export function cancelPendingDrag() {
  cancelCurrentSensor?.();
  cancelCurrentSensor = null;
}

interface SensorOptions {
  delay?: number;
  tolerance?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SensorProps = Record<string, any>;

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
        _options: SensorOptions,
      ) => {
        const { nativeEvent } = event;
        if (nativeEvent.touches.length > 1) return false;
        return true;
      },
    },
  ];

  constructor(props: SensorProps) {
    const { active, event, onStart, onCancel, onMove, onEnd, onAbort, options } = props;
    const sensorOpts = (options ?? {}) as SensorOptions;
    const delay = sensorOpts.delay ?? 600;
    const tolerance = sensorOpts.tolerance ?? 10;
    const toleranceSq = tolerance * tolerance;

    const touchEvent = event as TouchEvent;
    const touch = touchEvent.touches?.[0];
    if (!touch) {
      onAbort?.(active);
      onCancel();
      return;
    }

    const initialX = touch.clientX;
    const initialY = touch.clientY;
    let lastTouchY = initialY;

    const target = touchEvent.target as HTMLElement;

    // Check if the element has touch-action:none — if so, browser won't scroll
    // natively and we need to manually scroll the container.
    const touchAction = getComputedStyle(target).touchAction;
    const needsManualScroll = touchAction === 'none';
    const scrollParent = needsManualScroll ? findScrollParent(target) : null;

    let ready = false;
    let activated = false;
    let done = false;
    let ring: { el: HTMLElement; startPhase2: () => void } | null = null;

    ring = createProgressRing(initialX, initialY, delay);

    const removeIndicator = () => {
      removeRing(ring?.el ?? null);
      ring = null;
    };

    const cleanup = () => {
      if (done) return;
      done = true;
      cancelCurrentSensor = null;
      removeIndicator();
      clearTimeout(timer);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchCancel);
    };

    const cancel = () => {
      if (done) return;
      cleanup();
      onAbort?.(active);
      onCancel();
    };

    cancelCurrentSensor = () => {
      if (!activated) cancel();
    };

    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;

      if (activated) {
        // Active drag — forward to @dnd-kit
        if (e.cancelable) e.preventDefault();
        onMove({ x: t.clientX, y: t.clientY });
      } else if (ready) {
        // Ready state — activate DnD
        activated = true;
        cancelCurrentSensor = null;
        removeIndicator();
        if (e.cancelable) e.preventDefault();
        onStart({ x: initialX, y: initialY });
        onMove({ x: t.clientX, y: t.clientY });
      } else {
        // Delay period — manual scroll if needed, check tolerance
        if (needsManualScroll && scrollParent) {
          const dy = t.clientY - lastTouchY;
          lastTouchY = t.clientY;
          scrollParent.scrollTop -= dy;
        }

        const totalDx = t.clientX - initialX;
        const totalDy = t.clientY - initialY;
        if (totalDx * totalDx + totalDy * totalDy > toleranceSq) {
          cancel();
          if (needsManualScroll) {
            startContinuationScroll(t.clientY, scrollParent);
          }
        }
      }
    };

    const onTouchEnd = () => {
      if (done) return;
      cleanup();
      if (activated) {
        onEnd();
      } else {
        onAbort?.(active);
        onCancel();
      }
    };

    const onTouchCancel = () => {
      cancel();
    };

    const timer = setTimeout(() => {
      if (done) return;
      ready = true;
      ring?.startPhase2();
    }, delay);

    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchCancel);
    // No scroll listener for touch-action:none elements — manual scroll handles it.
    // No scroll listener for tabs — findScrollParent returns null (no vertical overflow).
  }
}
