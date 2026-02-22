import React, { useState, useEffect, type ReactNode } from 'react';
import { listFiles, readFile, deleteFile, writeFile, mkdirFile, renameFile, type FileEntry } from '../../api/files';
import FileTreeItem from './FileTreeItem';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import { useLongPress } from '../../hooks/useLongPress';
import toast from 'react-hot-toast';

interface FileTreeProps {
  rootPath?: string;
  onFileSelect: (path: string) => void;
  onFileDoubleClick?: (path: string) => void;
  onFileOpenNewTab?: (path: string) => void;
}

// Feather-style SVG icons (14×14)
const iconMulti = (...paths: string[]): ReactNode => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {paths.map((d, i) => <path key={i} d={d} />)}
  </svg>
);

const ICONS = {
  filePlus: iconMulti('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M12 18v-6', 'M9 15h6'),
  folderPlus: iconMulti('M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z', 'M12 11v6', 'M9 14h6'),
  externalLink: iconMulti('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14L21 3'),
  edit: iconMulti('M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z'),
  trash: iconMulti('M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'),
};

function getMenuItems(target: FileEntry | null): ContextMenuItem[] {
  if (!target) {
    return [
      { label: 'New File', action: 'new-file', icon: ICONS.filePlus },
      { label: 'New Folder', action: 'new-folder', icon: ICONS.folderPlus },
    ];
  }
  if (target.is_dir) {
    return [
      { label: 'Open as Workspace', action: 'open-workspace', icon: ICONS.externalLink },
      { type: 'separator' },
      { label: 'New File Inside', action: 'new-file', icon: ICONS.filePlus },
      { label: 'New Folder Inside', action: 'new-folder', icon: ICONS.folderPlus },
      { type: 'separator' },
      { label: 'New File', action: 'new-file-parent', icon: ICONS.filePlus },
      { label: 'New Folder', action: 'new-folder-parent', icon: ICONS.folderPlus },
      { type: 'separator' },
      { label: 'Rename', action: 'rename', icon: ICONS.edit },
      { type: 'separator' },
      { label: 'Delete', action: 'delete', danger: true, icon: ICONS.trash },
    ];
  }
  return [
    { label: 'New File', action: 'new-file', icon: ICONS.filePlus },
    { label: 'New Folder', action: 'new-folder', icon: ICONS.folderPlus },
    { type: 'separator' },
    { label: 'Rename', action: 'rename', icon: ICONS.edit },
    { label: 'Open in New Tab', action: 'open-new-tab', icon: ICONS.externalLink },
    { type: 'separator' },
    { label: 'Delete', action: 'delete', danger: true, icon: ICONS.trash },
  ];
}

export default function FileTree({ rootPath, onFileSelect, onFileDoubleClick, onFileOpenNewTab }: FileTreeProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState(rootPath || '');
  const [loading, setLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; target: FileEntry | null } | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [creatingType, setCreatingType] = useState<'file' | 'folder' | null>(null);
  const [renamingFile, setRenamingFile] = useState<FileEntry | null>(null);

  // Tree state
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [childrenCache, setChildrenCache] = useState<Map<string, FileEntry[]>>(new Map());
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set());
  const [creatingInFolder, setCreatingInFolder] = useState<string | null>(null);

  const loadFiles = async (path?: string) => {
    setLoading(true);
    try {
      const { data } = await listFiles(path);
      setFiles(data.files || []);
      setCurrentPath(data.path);
    } catch (err) {
      console.error('Failed to list files:', err);
    } finally {
      setLoading(false);
    }
  };

  const refreshFolder = async (folderPath: string) => {
    try {
      const { data } = await listFiles(folderPath);
      // Normalize slashes for comparison (backend may return backslashes on Windows)
      const norm = (p: string) => p.replace(/\\/g, '/');
      if (norm(folderPath) === norm(currentPath)) {
        setFiles(data.files || []);
      } else {
        setChildrenCache(prev => new Map(prev).set(folderPath, data.files || []));
      }
    } catch (err) {
      console.error('Failed to refresh folder:', err);
    }
  };

  const toggleFolder = async (folderPath: string) => {
    if (expandedFolders.has(folderPath)) {
      setExpandedFolders(prev => {
        const next = new Set(prev);
        next.delete(folderPath);
        return next;
      });
    } else {
      setExpandedFolders(prev => new Set(prev).add(folderPath));
      if (!childrenCache.has(folderPath)) {
        setLoadingFolders(prev => new Set(prev).add(folderPath));
        try {
          const { data } = await listFiles(folderPath);
          setChildrenCache(prev => new Map(prev).set(folderPath, data.files || []));
        } catch (err) {
          console.error('Failed to load folder:', err);
          setExpandedFolders(prev => {
            const next = new Set(prev);
            next.delete(folderPath);
            return next;
          });
        } finally {
          setLoadingFolders(prev => {
            const next = new Set(prev);
            next.delete(folderPath);
            return next;
          });
        }
      }
    }
  };

  useEffect(() => {
    setExpandedFolders(new Set());
    setChildrenCache(new Map());
    setCreatingInFolder(null);
    loadFiles(rootPath);
  }, [rootPath]);

  const handleClick = (file: FileEntry) => {
    setSelectedPath(file.path);
    if (file.is_dir) {
      toggleFolder(file.path);
    } else {
      onFileSelect(file.path);
    }
  };

  const handleItemContextMenu = (x: number, y: number, file: FileEntry) => {
    setContextMenu({ x, y, target: file });
  };

  const handleEmptyContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, target: null });
  };

  // Long-press for mobile on empty space
  const { handlers: emptyLongPressHandlers } = useLongPress({
    onLongPress: (x, y) => setContextMenu({ x, y, target: null }),
  });

  const handleMenuAction = (action: string) => {
    const target = contextMenu?.target;
    setContextMenu(null);

    switch (action) {
      case 'open-workspace':
        if (target?.is_dir) {
          setExpandedFolders(new Set());
          setChildrenCache(new Map());
          setCreatingInFolder(null);
          loadFiles(target.path);
        }
        break;
      case 'new-file':
      case 'new-folder':
        setCreatingType(action === 'new-file' ? 'file' : 'folder');
        if (target?.is_dir) {
          setCreatingInFolder(target.path);
          if (!expandedFolders.has(target.path)) {
            toggleFolder(target.path);
          }
        } else {
          setCreatingInFolder(null);
        }
        break;
      case 'new-file-parent':
      case 'new-folder-parent':
        setCreatingType(action.startsWith('new-file') ? 'file' : 'folder');
        setCreatingInFolder(null);
        break;
      case 'rename':
        if (target) setRenamingFile(target);
        break;
      case 'open-new-tab':
        if (target && !target.is_dir) onFileOpenNewTab?.(target.path);
        break;
      case 'delete':
        if (target) {
          const parentDir = target.path.split(/[/\\]/).slice(0, -1).join('/');

          if (target.is_dir) {
            // Folders are permanently deleted — ask for confirmation
            const folderName = target.path.split(/[/\\]/).pop() ?? target.path;
            if (!window.confirm(`Delete folder "${folderName}" and all its contents?\nThis cannot be undone.`)) break;

            deleteFile(target.path)
              .then(() => {
                toast.success('Folder deleted');
                setExpandedFolders(prev => {
                  const next = new Set(prev);
                  for (const key of next) {
                    if (key === target.path || key.startsWith(target.path + '/')) next.delete(key);
                  }
                  return next;
                });
                setChildrenCache(prev => {
                  const next = new Map(prev);
                  for (const key of next.keys()) {
                    if (key === target.path || key.startsWith(target.path + '/')) next.delete(key);
                  }
                  return next;
                });
                refreshFolder(parentDir);
              })
              .catch(() => toast.error('Failed to delete folder'));

          } else {
            // Files: read content first for undo support
            const filePath = target.path;
            readFile(filePath)
              .then(({ data }) => {
                const savedContent = data.content;
                return deleteFile(filePath).then(() => {
                  refreshFolder(parentDir);
                  toast(
                    (t) => (
                      <div className="file-delete-undo-toast">
                        <span>File deleted</span>
                        <button
                          type="button"
                          onClick={async () => {
                            toast.dismiss(t.id);
                            try {
                              await writeFile(filePath, savedContent);
                              refreshFolder(parentDir);
                              toast.success('File restored');
                            } catch {
                              toast.error('Failed to restore file');
                            }
                          }}
                          className="file-delete-undo-btn"
                        >
                          Undo
                        </button>
                      </div>
                    ),
                    { duration: 7000 },
                  );
                });
              })
              .catch(() => {
                // Binary or too large — cannot undo, ask for confirmation instead
                const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
                if (!window.confirm(`Delete "${fileName}"?\nThis file cannot be undone (binary or too large).`)) return;
                deleteFile(filePath)
                  .then(() => { toast.success('File deleted'); refreshFolder(parentDir); })
                  .catch(() => toast.error('Failed to delete file'));
              });
          }
        }
        break;
    }
  };

  const handleCreate = (name: string) => {
    if (!name) { setCreatingType(null); setCreatingInFolder(null); return; }

    const parentPath = creatingInFolder || currentPath;
    const newPath = parentPath + '/' + name;

    if (creatingType === 'folder') {
      mkdirFile(newPath)
        .then(() => { toast.success('Folder created'); refreshFolder(parentPath); })
        .catch(() => toast.error('Failed to create folder'));
    } else {
      writeFile(newPath, '')
        .then(() => {
          toast.success('File created');
          refreshFolder(parentPath);
          onFileSelect(newPath);
        })
        .catch(() => toast.error('Failed to create file'));
    }
    setCreatingType(null);
    setCreatingInFolder(null);
  };

  const handleRename = (file: FileEntry, newName: string) => {
    setRenamingFile(null);
    if (!newName || newName === file.name) return;

    const parentDir = file.path.split(/[/\\]/).slice(0, -1).join('/');
    const newPath = parentDir + '/' + newName;

    renameFile(file.path, newPath)
      .then(() => {
        toast.success('Renamed');
        if (file.is_dir) {
          setExpandedFolders(prev => {
            const next = new Set<string>();
            for (const key of prev) {
              if (key === file.path) {
                next.add(newPath);
              } else if (key.startsWith(file.path + '/')) {
                next.add(newPath + key.slice(file.path.length));
              } else {
                next.add(key);
              }
            }
            return next;
          });
          setChildrenCache(prev => {
            const next = new Map<string, FileEntry[]>();
            for (const [key, val] of prev) {
              if (key === file.path) {
                next.set(newPath, val);
              } else if (key.startsWith(file.path + '/')) {
                next.set(newPath + key.slice(file.path.length), val);
              } else {
                next.set(key, val);
              }
            }
            return next;
          });
        }
        refreshFolder(parentDir);
      })
      .catch(() => toast.error('Failed to rename'));
  };

  const goUp = () => {
    const root = rootPath || '';
    if (!currentPath || currentPath === root) return;
    const parent = currentPath.split('/').slice(0, -1).join('/');
    if (parent.length >= root.length) {
      setExpandedFolders(new Set());
      setChildrenCache(new Map());
      setCreatingInFolder(null);
      loadFiles(parent);
    }
  };

  const handleRefresh = () => {
    setExpandedFolders(new Set());
    setChildrenCache(new Map());
    setCreatingInFolder(null);
    loadFiles(currentPath);
  };

  const canGoUp = currentPath && currentPath !== (rootPath || '');

  // Inline creation input component
  const renderCreationInput = (depth: number) => (
    <div
      className="w-full flex items-center gap-1.5 py-1.5 text-sm"
      style={{ paddingLeft: `${12 + depth * 16 + 16}px`, paddingRight: '12px' }}
    >
      <span
        className="w-5 text-[10px] font-mono text-center shrink-0 font-bold"
        style={{ color: creatingType === 'folder' ? 'var(--accent)' : 'var(--text-secondary)' }}
      >
        {creatingType === 'folder' ? '/' : '--'}
      </span>
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
        placeholder={creatingType === 'folder' ? 'folder name' : 'filename.ext'}
        title={creatingType === 'folder' ? 'New folder name' : 'New file name'}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleCreate(e.currentTarget.value.trim());
          if (e.key === 'Escape') { setCreatingType(null); setCreatingInFolder(null); }
        }}
        onBlur={(e) => {
          const val = e.currentTarget.value.trim();
          if (val) handleCreate(val);
          else { setCreatingType(null); setCreatingInFolder(null); }
        }}
      />
    </div>
  );

  // Recursive tree renderer
  const renderItems = (items: FileEntry[], depth: number): React.ReactNode => {
    const sorted = [...items].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return sorted.map(file => (
      <React.Fragment key={file.path}>
        <FileTreeItem
          file={file}
          depth={depth}
          isExpanded={expandedFolders.has(file.path)}
          isLoading={loadingFolders.has(file.path)}
          isSelected={selectedPath === file.path}
          isContextTarget={contextMenu?.target?.path === file.path}
          onClick={() => handleClick(file)}
          onDoubleClick={!file.is_dir && onFileDoubleClick ? () => onFileDoubleClick(file.path) : undefined}
          onContextMenu={handleItemContextMenu}
          isRenaming={renamingFile?.path === file.path}
          onRenameSubmit={(newName) => handleRename(file, newName)}
          onRenameCancel={() => setRenamingFile(null)}
        />
        {/* Inline creation inside this expanded folder */}
        {file.is_dir && expandedFolders.has(file.path) && creatingType && creatingInFolder === file.path && (
          renderCreationInput(depth + 1)
        )}
        {/* Recursively render children */}
        {file.is_dir && expandedFolders.has(file.path) && childrenCache.has(file.path) && (
          renderItems(childrenCache.get(file.path)!, depth + 1)
        )}
      </React.Fragment>
    ));
  };

  return (
    <div
      className="h-full flex flex-col"
      style={{ background: 'transparent' }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 text-xs"
        style={{
          borderBottom: '1px solid var(--glass-border)',
          color: 'var(--text-secondary)',
        }}
      >
        {canGoUp && (
          <button
            type="button"
            onClick={goUp}
            className="hover:opacity-70 transition-opacity px-1"
            title="Go up"
          >
            ..
          </button>
        )}
        <span
          className="flex-1 font-mono whitespace-nowrap"
          ref={(el) => { if (el) requestAnimationFrame(() => { el.scrollLeft = el.scrollWidth; }); }}
          style={{ overflowX: 'auto', scrollbarWidth: 'none' }}
          title={currentPath}
        >
          {currentPath.replace(/\\/g, '/')}
        </span>
        <button
          type="button"
          onClick={handleRefresh}
          className="hover:opacity-70 transition-opacity px-1"
          title="Refresh"
        >
          R
        </button>
      </div>

      {/* File list */}
      <div
        className="flex-1 overflow-y-auto overflow-x-auto py-1 select-none"
        style={{ WebkitTouchCallout: 'none' }}
        onContextMenu={handleEmptyContextMenu}
        {...emptyLongPressHandlers}
      >
        {loading ? (
          <div className="p-4 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
            <span className="glow-pulse inline-block">Loading...</span>
          </div>
        ) : (
          <div className="inline-block min-w-full">
            {/* Root-level inline creation input */}
            {creatingType && !creatingInFolder && renderCreationInput(0)}

            {files.length === 0 && !creatingType ? (
              <div className="p-4 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
                Empty directory
              </div>
            ) : (
              renderItems(files, 0)
            )}
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getMenuItems(contextMenu.target)}
          onAction={handleMenuAction}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
