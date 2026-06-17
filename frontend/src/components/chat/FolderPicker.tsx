import { useState, useEffect, useCallback } from 'react';
import { listFiles } from '../../api/files';
import toast from 'react-hot-toast';

interface FolderPickerProps {
  /** Absolute path to start browsing from (user's workspace root). */
  startPath: string;
  /** Called with the chosen absolute folder path. */
  onSelect: (path: string) => void;
  onClose: () => void;
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
const baseName = (p: string) => norm(p).split('/').pop() || p;

/**
 * Lightweight folder browser modal — navigate the filesystem and pick any
 * directory (including empty ones). Only directories are listed. Hidden
 * folders the backend omits (e.g. .nebulide_chats) won't appear here.
 */
export default function FolderPicker({ startPath, onSelect, onClose }: FolderPickerProps) {
  const [path, setPath] = useState(startPath);
  const [folders, setFolders] = useState<{ name: string; path: string }[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    try {
      const { data } = await listFiles(p);
      setFolders(
        (data.files || [])
          .filter((f) => f.is_dir)
          .map((f) => ({ name: f.name, path: f.path }))
          .sort((a, b) => a.name.localeCompare(b.name))
      );
      setPath(data.path || p);
    } catch {
      toast.error('Не удалось открыть папку');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(startPath); }, [load, startPath]);

  // Parent dir — stop at the workspace root we started from.
  const canGoUp = norm(path) !== norm(startPath) && norm(path).startsWith(norm(startPath) + '/');
  const goUp = () => {
    const parts = norm(path).split('/');
    parts.pop();
    load(parts.join('/'));
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(3, 1, 8, 0.55)',
        backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(440px, 100%)', maxHeight: '70vh',
          display: 'flex', flexDirection: 'column',
          background: 'var(--glass-bg, rgba(20, 8, 36, 0.92))',
          border: '1px solid var(--glass-border)',
          borderRadius: 12,
          backdropFilter: 'blur(20px)',
          boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 8,
          borderBottom: '1px solid var(--glass-border)',
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
            Выбор папки
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 2 }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Current path */}
        <div style={{
          padding: '8px 16px', fontSize: 11, color: 'var(--text-muted)',
          fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left',
          borderBottom: '1px solid var(--glass-border)',
        }}>
          {norm(path)}
        </div>

        {/* Folder list */}
        <div style={{ flex: 1, overflow: 'auto', padding: '6px 0', minHeight: 120 }}>
          {canGoUp && (
            <button
              type="button"
              onClick={goUp}
              style={{
                width: '100%', textAlign: 'left', background: 'none', border: 'none',
                padding: '8px 16px', cursor: 'pointer', fontSize: 12,
                color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 10,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--glass-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
            >
              <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>..</span>
              наверх
            </button>
          )}
          {loading ? (
            <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>Загрузка…</div>
          ) : folders.length === 0 ? (
            <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>Нет вложенных папок</div>
          ) : (
            folders.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => load(f.path)}
                style={{
                  width: '100%', textAlign: 'left', background: 'none', border: 'none',
                  padding: '8px 16px', cursor: 'pointer', fontSize: 12,
                  color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 10,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--glass-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.8 }}>
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.name}
                </span>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8,
          borderTop: '1px solid var(--glass-border)',
        }}>
          <span style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {baseName(path)}
          </span>
          <button
            type="button"
            className="btn-glass"
            onClick={() => onSelect(norm(path))}
            style={{
              padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: 'pointer',
              background: 'rgba(var(--accent-rgb), 0.2)',
              border: '1px solid rgba(var(--accent-rgb), 0.4)',
              color: 'var(--accent-bright)',
            }}
          >
            Выбрать эту папку
          </button>
        </div>
      </div>
    </div>
  );
}
