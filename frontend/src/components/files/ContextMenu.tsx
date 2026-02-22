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

export default function ContextMenu({ x, y, items, onAction, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [maxH, setMaxH] = useState<number | undefined>(undefined);

  // Indices of actionable (non-separator, non-disabled) items for keyboard nav
  const actionableIndices = items
    .map((item, i) => (item.type !== 'separator' && !item.disabled ? i : -1))
    .filter(i => i !== -1);

  // Measure and position after first render
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxHeight = vh - EDGE_PADDING * 2;

    let left = x;
    let top = y;

    // Clamp X
    if (left + rect.width > vw - EDGE_PADDING) left = vw - EDGE_PADDING - rect.width;
    if (left < EDGE_PADDING) left = EDGE_PADDING;

    // Clamp Y
    if (top + rect.height > vh - EDGE_PADDING) top = vh - EDGE_PADDING - rect.height;
    if (top < EDGE_PADDING) top = EDGE_PADDING;

    const overflowing = rect.height > maxHeight;
    setPos({ left, top: overflowing ? EDGE_PADDING : top });
    setIsOverflowing(overflowing);
    setMaxH(overflowing ? maxHeight : undefined);
  }, [x, y, items]);

  // Transform origin from clamping direction
  const originX = pos.left < x ? 'right' : 'left';
  const originY = pos.top < y ? 'bottom' : 'top';

  // Close on outside mousedown, keyboard navigation
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
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
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('keydown', handleKeyDown);
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
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
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
