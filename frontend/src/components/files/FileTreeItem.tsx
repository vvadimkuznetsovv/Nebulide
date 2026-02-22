import { useRef } from 'react';
import type { FileEntry } from '../../api/files';
import { useLongPress } from '../../hooks/useLongPress';

interface FileTreeItemProps {
  file: FileEntry;
  depth: number;
  isExpanded?: boolean;
  isLoading?: boolean;
  isSelected?: boolean;
  isContextTarget?: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  onContextMenu: (x: number, y: number, file: FileEntry) => void;
  isRenaming?: boolean;
  onRenameSubmit?: (newName: string) => void;
  onRenameCancel?: () => void;
}

const FILE_ICONS: Record<string, string> = {
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
};

const FILE_COLORS: Record<string, string> = {
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
};

function getIcon(file: FileEntry): string {
  if (file.is_dir) return '';
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();
  return FILE_ICONS[ext] || '--';
}

function getColor(file: FileEntry): string {
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
  const { handlers: longPressHandlers, longPressedRef } = useLongPress({
    onLongPress: (x, y) => onContextMenu(x, y, file),
    stopPropagation: true,
  });

  // Mobile double-tap detection: two taps on same file within 5s
  const lastTapRef = useRef<{ path: string; time: number } | null>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(e.clientX, e.clientY, file);
  };

  const handleClick = () => {
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

    onClick();
  };

  return (
    <button
      type="button"
      onClick={isRenaming ? undefined : handleClick}
      onDoubleClick={isRenaming || file.is_dir ? undefined : () => onDoubleClick?.()}
      onContextMenu={handleContextMenu}
      {...longPressHandlers}
      className={`file-tree-item relative w-full flex items-center gap-1.5 py-1.5 text-sm text-left transition-all duration-150 select-none${isSelected ? ' selected' : ''}${isContextTarget ? ' context-target' : ''}`}
      style={{
        paddingLeft: `${depth * 4}px`,
        paddingRight: '8px',
        color: 'var(--text-primary)',
        WebkitTouchCallout: 'none',
      }}
    >
      {/* Indent guide lines — one per ancestor level */}
      {depth > 0 && Array.from({ length: depth }, (_, i) => (
        <span key={i} className="file-tree-indent-guide" style={{ left: `${4 + i * 6 + 11}px` }} />
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
          style={{ color: getColor(file) }}
        >
          {getIcon(file)}
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
            if (e.key === 'Enter') onRenameSubmit?.(e.currentTarget.value.trim());
            if (e.key === 'Escape') onRenameCancel?.();
          }}
          onBlur={(e) => {
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
