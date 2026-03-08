import { useToaster, toast as hotToast, ToastIcon, resolveValue } from 'react-hot-toast';
import { useRef, useCallback } from 'react';
import type { CSSProperties } from 'react';

const DISMISS_THRESHOLD = 60;
const SPRING_TRANSITION = 'transform 0.25s ease, opacity 0.25s ease';
const DISMISS_TRANSITION = 'transform 0.2s ease-out, opacity 0.2s ease-out';

const isMobile = () => window.matchMedia('(max-width: 640px)').matches;

const toastStyle: CSSProperties = {
  background: 'rgba(255, 255, 255, 0.08)',
  backdropFilter: 'blur(40px) saturate(180%)',
  WebkitBackdropFilter: 'blur(40px) saturate(180%)',
  color: 'rgba(255, 255, 255, 0.95)',
  border: '1px solid rgba(255, 255, 255, 0.18)',
  borderRadius: '9999px',
  padding: '14px 24px',
  boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.15), inset 0 -1px 1px rgba(0,0,0,0.08), 0 8px 32px rgba(0,0,0,0.4)',
  fontSize: '14px',
  fontWeight: 500,
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  maxWidth: '350px',
  pointerEvents: 'auto' as const,
  cursor: 'grab',
  userSelect: 'none' as const,
  WebkitUserSelect: 'none' as const,
  touchAction: 'none' as const,
};

function SwipeableToastItem({ t, updateHeight }: {
  t: { id: string; visible: boolean; type: string; message: any; icon?: any; };
  updateHeight: (id: string, height: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const startRef = useRef({ x: 0, y: 0 });
  const draggingRef = useRef(false);
  const translateRef = useRef({ x: 0, y: 0 });
  const dismissedRef = useRef(false);

  const setTransform = useCallback((x: number, y: number, transition: string, opacity = 1) => {
    if (!ref.current) return;
    ref.current.style.transition = transition;
    ref.current.style.transform = `translate(${x}px, ${y}px)`;
    ref.current.style.opacity = String(opacity);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (dismissedRef.current) return;
    startRef.current = { x: e.clientX, y: e.clientY };
    draggingRef.current = true;
    translateRef.current = { x: 0, y: 0 };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (ref.current) ref.current.style.transition = 'none';
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current || dismissedRef.current) return;
    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;

    // Up swipe always allowed; horizontal swipe only on mobile
    const mobile = isMobile();
    const tx = mobile ? dx : 0;
    const ty = Math.min(0, dy); // only up

    translateRef.current = { x: tx, y: ty };
    const distance = Math.max(Math.abs(tx), Math.abs(ty));
    const opacity = Math.max(0.2, 1 - distance / (DISMISS_THRESHOLD * 2));
    setTransform(tx, ty, 'none', opacity);
  }, [setTransform]);

  const onPointerUp = useCallback(() => {
    if (!draggingRef.current || dismissedRef.current) return;
    draggingRef.current = false;

    const { x, y } = translateRef.current;
    const distance = Math.max(Math.abs(x), Math.abs(y));

    if (distance > DISMISS_THRESHOLD) {
      // Dismiss: fly out in swipe direction
      dismissedRef.current = true;
      const flyX = x !== 0 ? x * 4 : 0;
      const flyY = y !== 0 ? y * 4 : -200;
      setTransform(flyX, flyY, DISMISS_TRANSITION, 0);
      setTimeout(() => hotToast.dismiss(t.id), 200);
    } else {
      // Spring back
      setTransform(0, 0, SPRING_TRANSITION, 1);
    }
  }, [t.id, setTransform]);

  const onPointerCancel = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setTransform(0, 0, SPRING_TRANSITION, 1);
  }, [setTransform]);

  return (
    <div
      ref={(el) => {
        (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
        if (el) updateHeight(t.id, el.getBoundingClientRect().height);
      }}
      style={{
        ...toastStyle,
        opacity: t.visible ? 1 : 0,
        transition: t.visible ? SPRING_TRANSITION : 'opacity 0.3s ease',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <ToastIcon toast={t as any} />
      <span>{resolveValue(t.message, t as any)}</span>
    </div>
  );
}

export default function SwipeableToaster() {
  const { toasts, handlers } = useToaster();
  const { startPause, endPause, calculateOffset, updateHeight } = handlers;

  return (
    <div
      style={{
        position: 'fixed',
        top: 16,
        left: 0,
        right: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        zIndex: 9999,
        pointerEvents: 'none',
      }}
      onMouseEnter={startPause}
      onMouseLeave={endPause}
    >
      {toasts.map((t) => {
        const offset = calculateOffset(t, {
          reverseOrder: false,
          gutter: 8,
        });
        return (
          <div
            key={t.id}
            style={{
              position: 'absolute',
              top: 0,
              transform: `translateY(${offset}px)`,
              transition: 'transform 0.2s ease',
            }}
          >
            <SwipeableToastItem t={t} updateHeight={updateHeight} />
          </div>
        );
      })}
    </div>
  );
}
