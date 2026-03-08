import { useRef, useCallback } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { FileEntry } from '../../api/files';
import { useLongPress, mergeEventHandlers } from '../../hooks/useLongPress';
import { cancelPendingDrag } from '../../utils/ScrollAwareTouchSensor';

interface FileTreeItemProps {
  file: FileEntry;
  depth: number;
  isExpanded?: boolean;
  isLoading?: boolean;
  isSelected?: boolean;
  isContextTarget?: boolean;
  onClick: (e?: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  onContextMenu: (x: number, y: number, file: FileEntry) => void;
  isRenaming?: boolean;
  onRenameSubmit?: (newName: string) => void;
  onRenameCancel?: () => void;
}

export const FILE_ICONS: Record<string, string> = {
  '.ts': 'TS',
  '.tsx': 'TX',
  '.js': 'JS',
  '.jsx': 'JX',
  '.go': 'GO',
  '.py': 'PY',
  '.rs': 'RS',
  '.md': 'MD',
  '.json': '{}',
  '.yaml': 'YM',
  '.yml': 'YM',
  '.css': 'CS',
  '.html': '<>',
  '.sql': 'SQ',
  '.sh': 'SH',
  '.env': 'EN',
  '.toml': 'TM',
  '.mod': 'GM',
  '.pdf': 'PD',
  '.docx': 'DX',
  '.doc': 'WD',
  '.jpg': 'IM',
  '.jpeg': 'IM',
  '.png': 'IM',
  '.gif': 'GF',
  '.webp': 'WP',
  '.svg': 'SV',
  '.bmp': 'BM',
  '.ico': 'IC',
};

export const FILE_COLORS: Record<string, string> = {
  '.ts': '#3b82f6',
  '.tsx': '#3b82f6',
  '.js': '#eab308',
  '.jsx': '#eab308',
  '.go': '#06b6d4',
  '.py': '#22c55e',
  '.rs': '#f97316',
  '.md': '#a78bfa',
  '.json': '#fbbf24',
  '.css': '#ec4899',
  '.html': '#f97316',
  '.pdf': '#ef4444',
  '.docx': '#2563eb',
  '.doc': '#2563eb',
  '.jpg': '#10b981',
  '.jpeg': '#10b981',
  '.png': '#10b981',
  '.gif': '#10b981',
  '.webp': '#10b981',
  '.svg': '#f59e0b',
  '.bmp': '#10b981',
  '.ico': '#6b7280',
};

export function getFileIcon(file: FileEntry): string {
  if (file.is_dir) return '';
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();
  return FILE_ICONS[ext] || '--';
}

export function getFileColor(file: FileEntry): string {
  if (file.is_dir) return 'var(--accent)';
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();
  return FILE_COLORS[ext] || 'var(--text-secondary)';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
  return (bytes / (1024 * 1024)).toFixed(1) + 'M';
}

const DOUBLE_TAP_MS = 5000;

export default function FileTreeItem({
  file, depth, isExpanded, isLoading, isSelected, isContextTarget,
  onClick, onDoubleClick, onContextMenu, isRenaming, onRenameSubmit, onRenameCancel,
}: FileTreeItemProps) {
  // DnD: every item is draggable (registers with outer Workspace DndContext)
  // NOTE: DON'T spread attributes — they apply CSS transform which clips inside overflow:auto
  const { listeners: dragListeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: `file:${file.path}`,
    data: { file },
  });

  const isDraggingRef = useRef(false);
  isDraggingRef.current = isDragging;

  const { handlers: longPressHandlers, longPressedRef } = useLongPress({
    onLongPress: (x, y) => {
      if (isDraggingRef.current) return; // Drag active → skip context menu
      cancelPendingDrag(); // Cancel ready-state sensor before opening menu
      onContextMenu(x, y, file);
    },
    stopPropagation: true,
  });

  // DnD: all items are droppable — folders accept into themselves,
  // files accept into their parent folder (so dropping onto a file
  // inside folder_A moves the dragged item into folder_A)
  const droppableId = file.is_dir ? `folder:${file.path}` : `filezone:${file.path}`;
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: droppableId,
    data: { file },
  });

  // Merge refs: every item is both draggable + droppable
  // MUST be useCallback — inline ref functions change identity every render,
  // causing @dnd-kit to re-register nodes → setState → re-render → infinite loop (React #185)
  const setRef = useCallback((el: HTMLElement | null) => {
    setDragRef(el);
    setDropRef(el);
  }, [setDragRef, setDropRef]);

  // Merge long-press + drag listeners
  const mergedHandlers = mergeEventHandlers(longPressHandlers, dragListeners);

  // Guard: prevent blur from re-submitting after Enter/Escape
  const renameSubmittedRef = useRef(false);

  // Mobile double-tap detection: two taps on same file within 5s
  const lastTapRef = useRef<{ path: string; time: number } | null>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(e.clientX, e.clientY, file);
  };

  const handleClick = (e?: React.MouseEvent) => {
    if (longPressedRef.current) { longPressedRef.current = false; return; }

    // Check for double-tap (mobile) — for files only
    if (!file.is_dir && onDoubleClick) {
      const now = Date.now();
      const last = lastTapRef.current;
      if (last && last.path === file.path && now - last.time < DOUBLE_TAP_MS) {
        lastTapRef.current = null;
        onDoubleClick();
        return;
      }
      lastTapRef.current = { path: file.path, time: now };
    }

    onClick(e);
  };

  return (
    <button
      ref={setRef}
      type="button"
      onClick={isRenaming ? undefined : (e) => handleClick(e)}
      onDoubleClick={isRenaming || file.is_dir ? undefined : () => onDoubleClick?.()}
      onContextMenu={handleContextMenu}
      {...mergedHandlers}
      className={`file-tree-item relative w-full flex items-center gap-1.5 py-1.5 text-sm text-left transition-all duration-150 select-none${isSelected ? ' selected' : ''}${isContextTarget ? ' context-target' : ''}${isOver ? ' drop-target' : ''}`}
      style={{
        paddingLeft: `${8 + depth * 16}px`,
        paddingRight: '8px',
        color: 'var(--text-primary)',
        WebkitTouchCallout: 'none',
        touchAction: 'none',
        opacity: isDragging ? 0.3 : 1,
      }}
    >
      {/* Indent guide lines — one per ancestor level */}
      {depth > 0 && Array.from({ length: depth }, (_, i) => (
        <span key={i} className="file-tree-indent-guide" style={{ left: `${8 + i * 16 + 11}px` }} />
      ))}
      {/* Chevron for directories / spacer for files */}
      {file.is_dir ? (
        <span
          className="w-4 h-4 flex items-center justify-center shrink-0 transition-transform duration-150"
          style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          {isLoading ? (
            <svg className="animate-spin" width="10" height="10" viewBox="0 0 24 24" fill="none"
              stroke="var(--accent)" strokeWidth="3" strokeLinecap="round">
              <path d="M12 2a10 10 0 0 1 10 10" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          )}
        </span>
      ) : (
        <span className="w-4 shrink-0" />
      )}

      {!file.is_dir && (
        <span
          className="w-5 text-[10px] font-mono text-center shrink-0 font-bold"
          style={{ color: getFileColor(file) }}
        >
          {getFileIcon(file)}
        </span>
      )}
      {isRenaming ? (
        <input
          className="flex-1 text-sm px-1 py-0 bg-transparent outline-none"
          style={{
            fontSize: '13px',
            borderRadius: '4px',
            minWidth: 0,
            border: '1px solid var(--glass-border)',
            color: 'var(--text-primary)',
            background: 'rgba(0,0,0,0.35)',
          }}
          defaultValue={file.name}
          placeholder="filename"
          title="Rename"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              renameSubmittedRef.current = true;
              onRenameSubmit?.(e.currentTarget.value.trim());
            }
            if (e.key === 'Escape') {
              renameSubmittedRef.current = true;
              onRenameCancel?.();
            }
          }}
          onBlur={(e) => {
            if (renameSubmittedRef.current) { renameSubmittedRef.current = false; return; }
            const val = e.currentTarget.value.trim();
            if (val && val !== file.name) onRenameSubmit?.(val);
            else onRenameCancel?.();
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="whitespace-nowrap flex-1">{file.name}</span>
      )}
      {!file.is_dir && !isRenaming && (
        <span className="text-xs shrink-0 font-mono" style={{ color: 'var(--text-tertiary)' }}>
          {formatSize(file.size)}
        </span>
      )}
    </button>
  );
}
