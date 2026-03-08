/**
 * Custom touch sensor for @dnd-kit that properly handles scroll vs drag on mobile.
 *
 * Interaction model:
 *   - Touch + move immediately → SCROLL (manual JS scroll via scrollParent.scrollTop)
 *   - Touch + hold 700ms + move → DRAG (ready state, activate on any movement)
 *   - Touch + hold 1200ms → CONTEXT MENU (cancelPendingDrag cancels sensor)
 *
 * Key design:
 *   - FileTreeItem has `touch-action: none` so browser delivers ALL touchmove to JS
 *   - During delay: sensor manually scrolls container (scrollParent.scrollTop -= dy)
 *   - When finger moves > tolerance: sensor cancels, continues manual scrolling until touchend
 *   - After delay (ready=true): any movement = drag activation
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

// ---- DEBUG (temporary) ----
let debugEl: HTMLElement | null = null;
function dbg(msg: string) {
  if (!debugEl) {
    debugEl = document.createElement('div');
    debugEl.style.cssText =
      'position:fixed;bottom:0;left:0;right:0;z-index:999999;' +
      'background:rgba(0,0,0,0.95);color:#0f0;font:11px monospace;' +
      'padding:4px 8px;max-height:25vh;overflow-y:auto;pointer-events:none;';
    document.body.appendChild(debugEl);
  }
  const l = document.createElement('div');
  l.textContent = `[${Date.now() % 100000}] ${msg}`;
  debugEl.appendChild(l);
  if (debugEl.childNodes.length > 30) debugEl.removeChild(debugEl.firstChild!);
  debugEl.scrollTop = debugEl.scrollHeight;
}
// ---- END DEBUG ----

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
      fill="none" stroke="rgba(200,120,255,0.18)" stroke-width="${sw}"/>
    <circle id="p1" cx="${size / 2}" cy="${size / 2}" r="${r}"
      fill="none" stroke="rgb(200,120,255)" stroke-width="${sw}"
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
 * Continue manual scrolling after sensor cancels (tolerance exceeded during delay).
 * Keeps scrolling the container in sync with finger movement until touchend.
 */
function startContinuationScroll(lastY: number, scrollParent: HTMLElement | null) {
  if (!scrollParent) return;
  let prevY = lastY;

  const onMove = (e: TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    const dy = t.clientY - prevY;
    prevY = t.clientY;
    scrollParent.scrollTop -= dy;
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
    const delay = sensorOpts.delay ?? 700;
    const tolerance = sensorOpts.tolerance ?? 10;
    const toleranceSq = tolerance * tolerance;

    dbg(`CTOR id=${String(active).slice(-20)} d=${delay}`);

    const touchEvent = event as TouchEvent;
    const touch = touchEvent.touches?.[0];
    if (!touch) {
      dbg('no touch');
      onAbort?.(active);
      onCancel();
      return;
    }

    const initialX = touch.clientX;
    const initialY = touch.clientY;
    let lastTouchY = initialY;

    const target = touchEvent.target as HTMLElement;
    const scrollParent = findScrollParent(target);
    dbg(`scrollParent=${scrollParent?.tagName ?? 'NONE'}`);

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

    const cancel = (reason: string) => {
      if (done) return;
      dbg(`CANCEL: ${reason}`);
      cleanup();
      onAbort?.(active);
      onCancel();
    };

    cancelCurrentSensor = () => {
      if (!activated) cancel('external');
    };

    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;

      if (activated) {
        // Active drag — forward movement to @dnd-kit
        if (e.cancelable) e.preventDefault();
        onMove({ x: t.clientX, y: t.clientY });
      } else if (ready) {
        // Ready state — activate DnD on any movement
        dbg(`ACTIVATE cancelable=${e.cancelable}`);
        activated = true;
        cancelCurrentSensor = null;
        removeIndicator();
        if (e.cancelable) e.preventDefault();
        try {
          onStart({ x: initialX, y: initialY });
          dbg('onStart OK');
        } catch (err) {
          dbg(`onStart ERR: ${err}`);
        }
        onMove({ x: t.clientX, y: t.clientY });
      } else {
        // During delay: manual scroll (compensates for touch-action:none)
        const dy = t.clientY - lastTouchY;
        lastTouchY = t.clientY;

        if (scrollParent) {
          scrollParent.scrollTop -= dy;
        }

        // Check tolerance from initial position
        const totalDx = t.clientX - initialX;
        const totalDy = t.clientY - initialY;
        if (totalDx * totalDx + totalDy * totalDy > toleranceSq) {
          dbg(`tol ${Math.sqrt(totalDx * totalDx + totalDy * totalDy).toFixed(0)}px → scroll`);
          cancel('tol');
          // Continue manual scrolling until finger lifts
          startContinuationScroll(t.clientY, scrollParent);
        }
      }
    };

    const onTouchEnd = () => {
      dbg(`END done=${done} act=${activated}`);
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
      cancel('touchcancel');
    };

    const timer = setTimeout(() => {
      if (done) return;
      ready = true;
      dbg('READY ✓');
      ring?.startPhase2();
    }, delay);

    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchCancel);
    // No scroll listener needed — with touch-action:none, we handle scrolling manually
  }
}
