/**
 * Custom touch sensor for @dnd-kit that properly handles scroll vs drag on mobile.
 *
 * Interaction model:
 *   - Touch + move immediately → SCROLL (tolerance exceeded or container scrolls)
 *   - Touch + hold 700ms + move → DRAG (ready state, activate on any movement)
 *   - Touch + hold 1200ms → CONTEXT MENU (cancelPendingDrag cancels sensor)
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

// ---- TEMPORARY DEBUG ----
let debugEl: HTMLElement | null = null;
function dbg(msg: string) {
  if (!debugEl) {
    debugEl = document.createElement('div');
    debugEl.style.cssText =
      'position:fixed;bottom:0;left:0;right:0;z-index:999999;' +
      'background:rgba(0,0,0,0.9);color:#0f0;font:12px monospace;' +
      'padding:6px 10px;max-height:30vh;overflow-y:auto;pointer-events:none;';
    document.body.appendChild(debugEl);
  }
  const line = document.createElement('div');
  line.textContent = `[${new Date().toISOString().slice(11, 23)}] ${msg}`;
  debugEl.appendChild(line);
  debugEl.scrollTop = debugEl.scrollHeight;
}
// ---- END DEBUG ----

const CONTEXT_MENU_MS = 1200;

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
  const el = document.createElement('div');
  el.style.cssText = `
    position:fixed;z-index:99999;pointer-events:none;
    left:${x - size / 2}px;top:${y - size / 2}px;
    width:${size}px;height:${size}px;
    transition:opacity 0.15s;
  `;
  // Unique filter IDs to avoid SVG conflicts
  const uid = Math.random().toString(36).slice(2, 8);
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
    const {
      active,
      event,
      onStart,
      onCancel,
      onMove,
      onEnd,
      onAbort,
      options,
    } = props;
    const sensorOpts = (options ?? {}) as SensorOptions;
    const delay = sensorOpts.delay ?? 700;
    const tolerance = sensorOpts.tolerance ?? 10;
    const toleranceSq = tolerance * tolerance;

    dbg(`CTOR active=${active} delay=${delay} tol=${tolerance}`);

    const touchEvent = event as TouchEvent;
    const touch = touchEvent.touches?.[0];
    if (!touch) {
      dbg('NO TOUCH → abort');
      onAbort?.(active);
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
      scrollParent?.removeEventListener('scroll', onScroll);
    };

    const cancel = (reason: string) => {
      if (done) return;
      dbg(`CANCEL: ${reason}`);
      cleanup();
      onAbort?.(active);
      onCancel();
    };

    cancelCurrentSensor = () => {
      if (!activated) cancel('externalCancel');
    };

    const hasScrolled = () => {
      if (!scrollParent) return false;
      return Math.abs(scrollParent.scrollTop - initialScrollTop) > 3 ||
             Math.abs(scrollParent.scrollLeft - initialScrollLeft) > 3;
    };

    const onScroll = () => {
      if (!activated && hasScrolled()) cancel('scroll');
    };

    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;

      if (activated) {
        if (e.cancelable) e.preventDefault();
        onMove({ x: t.clientX, y: t.clientY });
      } else if (ready) {
        dbg(`MOVE in READY → ACTIVATE! cancelable=${e.cancelable}`);
        activated = true;
        cancelCurrentSensor = null;
        removeIndicator();
        if (e.cancelable) e.preventDefault();
        try {
          onStart({ x: initialX, y: initialY });
          dbg('onStart OK');
        } catch (err) {
          dbg(`onStart ERROR: ${err}`);
        }
        onMove({ x: t.clientX, y: t.clientY });
      } else {
        const dx = t.clientX - initialX;
        const dy = t.clientY - initialY;
        const distSq = dx * dx + dy * dy;
        if (distSq > toleranceSq) {
          cancel(`tolerance dist=${Math.sqrt(distSq).toFixed(1)}`);
        }
      }
    };

    const onTouchEnd = () => {
      dbg(`TOUCHEND done=${done} activated=${activated}`);
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
      dbg('TOUCHCANCEL');
      cancel('touchcancel');
    };

    const timer = setTimeout(() => {
      dbg(`TIMER done=${done} scrolled=${hasScrolled()}`);
      if (done) return;
      if (hasScrolled()) {
        cancel('scroll-in-timer');
        return;
      }
      ready = true;
      dbg('READY=true ✓');
      ring?.startPhase2();
    }, delay);

    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchCancel);
    scrollParent?.addEventListener('scroll', onScroll, { passive: true });
  }
}
