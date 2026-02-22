import { useEffect, useRef, useState, useLayoutEffect, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  type?: 'item' | 'separator';
  label?: string;
  action?: string;
  danger?: boolean;
  icon?: ReactNode;
  disabled?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onAction: (action: string) => void;
  onClose: () => void;
}

const EDGE_PADDING = 8;

// Module-level singleton — closes any open menu when a new one mounts
const menuCloser = new EventTarget();

export default function ContextMenu({ x, y, items, onAction, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const [positioned, setPositioned] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [maxH, setMaxH] = useState<number | undefined>(undefined);

  // Indices of actionable (non-separator, non-disabled) items for keyboard nav
  const actionableIndices = items
    .map((item, i) => (item.type !== 'separator' && !item.disabled ? i : -1))
    .filter(i => i !== -1);

  // Close any existing menu when this one mounts (one menu at a time)
  useEffect(() => {
    const self = { dispatched: false };
    const handleClose = () => {
      if (self.dispatched) { self.dispatched = false; return; }
      onClose();
    };
    menuCloser.addEventListener('close', handleClose);
    self.dispatched = true;
    menuCloser.dispatchEvent(new Event('close'));
    return () => menuCloser.removeEventListener('close', handleClose);
  }, [onClose]);

  // Measure and position after first render
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    // Use offsetWidth/offsetHeight — they ignore CSS transforms (scale from animation)
    // getBoundingClientRect() returns scaled dimensions which causes wrong clamping
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const maxHeight = vh - EDGE_PADDING * 2;

    // Constrain height first so clamping uses the actual rendered height
    const overflowing = h > maxHeight;
    const effectiveH = overflowing ? maxHeight : h;

    let left = x;
    let top = y;

    // Clamp X
    if (left + w > vw - EDGE_PADDING) left = vw - EDGE_PADDING - w;
    if (left < EDGE_PADDING) left = EDGE_PADDING;

    // Clamp Y
    if (top + effectiveH > vh - EDGE_PADDING) top = vh - EDGE_PADDING - effectiveH;
    if (top < EDGE_PADDING) top = EDGE_PADDING;

    setPos({ left, top });
    setIsOverflowing(overflowing);
    setMaxH(overflowing ? maxHeight : undefined);
    setPositioned(true);
  }, [x, y, items]);

  // Transform origin from clamping direction
  const originX = pos.left < x ? 'right' : 'left';
  const originY = pos.top < y ? 'bottom' : 'top';

  // Close on outside mousedown/touchstart, keyboard navigation
  useEffect(() => {
    const handleOutside = (e: Event) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex(prev => {
          const cur = actionableIndices.indexOf(prev);
          return actionableIndices[cur < actionableIndices.length - 1 ? cur + 1 : 0];
        });
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex(prev => {
          const cur = actionableIndices.indexOf(prev);
          return actionableIndices[cur > 0 ? cur - 1 : actionableIndices.length - 1];
        });
      }
      if (e.key === 'Enter' && focusedIndex >= 0) {
        e.preventDefault();
        const item = items[focusedIndex];
        if (item?.action && !item.disabled) onAction(item.action);
      }
    };
    // Use capture phase so clicks inside Monaco editor (which stopPropagation) still close the menu
    window.addEventListener('pointerdown', handleOutside, true);
    window.addEventListener('keydown', handleKeyDown);
    // Close when focus moves to an iframe (clicks inside iframe don't bubble to parent)
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', handleOutside, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose, onAction, focusedIndex, actionableIndices, items]);

  const handleItemClick = useCallback((action: string | undefined, disabled: boolean | undefined) => {
    if (disabled || !action) return;
    onAction(action);
  }, [onAction]);

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu context-menu-enter"
      role="menu"
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        zIndex: 9999,
        maxHeight: maxH,
        transformOrigin: `${originX} ${originY}`,
        visibility: positioned ? 'visible' : 'hidden',
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
    >
      <div className="context-menu-scroll" style={{ maxHeight: maxH ? maxH - (isOverflowing ? 44 : 0) : undefined }}>
        {items.map((item, i) =>
          item.type === 'separator' ? (
            <div key={i} className="context-menu-separator" />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={[
                'context-menu-item',
                item.danger ? 'danger' : '',
                item.disabled ? 'disabled' : '',
                focusedIndex === i ? 'focused' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => handleItemClick(item.action, item.disabled)}
              onMouseEnter={() => !item.disabled && setFocusedIndex(i)}
              onMouseLeave={() => setFocusedIndex(-1)}
            >
              {item.icon && <span className="context-menu-icon">{item.icon}</span>}
              <span className="context-menu-label">{item.label}</span>
            </button>
          ),
        )}
      </div>
      {isOverflowing && (
        <button
          type="button"
          className="context-menu-dismiss"
          onClick={onClose}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          Dismiss
        </button>
      )}
    </div>,
    document.body,
  );
}
