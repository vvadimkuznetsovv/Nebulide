import React, { useState, useEffect, useRef, useImperativeHandle, forwardRef, type ReactNode } from 'react';
import { DndContext, DragOverlay, MouseSensor, useSensor, useSensors, useDroppable, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { listFiles, readFile, deleteFile, writeFile, mkdirFile, renameFile, type FileEntry } from '../../api/files';
import FileTreeItem, { getFileIcon, getFileColor } from './FileTreeItem';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import { useLongPress } from '../../hooks/useLongPress';
import toast from 'react-hot-toast';

interface FileTreeProps {
  rootPath?: string;
  onFileSelect: (path: string) => void;
  onFileDoubleClick?: (path: string) => void;
  onFileOpenNewTab?: (path: string) => void;
}

export interface FileTreeHandle {
  navigateTo: (path: string) => void;
  refresh: () => void;
  workspaceRoot: string;
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

const EXPANDED_KEY = 'nebulide-expanded-folders';
const CURRENT_PATH_KEY = 'nebulide-filetree-path';

function saveExpandedFolders(folders: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...folders]));
  } catch { /* quota exceeded — ignore */ }
}

function loadExpandedFolders(): Set<string> {
  try {
    const saved = localStorage.getItem(EXPANDED_KEY);
    return saved ? new Set(JSON.parse(saved) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveCurrentPath(path: string) {
  try { localStorage.setItem(CURRENT_PATH_KEY, path); } catch { /* ignore */ }
}

function loadCurrentPath(): string | null {
  try { return localStorage.getItem(CURRENT_PATH_KEY); } catch { return null; }
}

const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(function FileTree({ rootPath, onFileSelect, onFileDoubleClick, onFileOpenNewTab }, ref) {
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
  const [workspaceRoot, setWorkspaceRoot] = useState<string>('');

  // DnD state — mouse only (touch DnD disabled, use context menu to move files on mobile)
  const [draggedFile, setDraggedFile] = useState<FileEntry | null>(null);
  const mouseSensor = useSensor(MouseSensor, { activationConstraint: { distance: 8 } });
  const sensors = useSensors(mouseSensor);

  const loadFiles = async (path?: string) => {
    setLoading(true);
    try {
      const { data } = await listFiles(path);
      setFiles(data.files || []);
      setCurrentPath(data.path);
      saveCurrentPath(data.path);
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
        saveExpandedFolders(next);
        return next;
      });
    } else {
      setExpandedFolders(prev => {
        const next = new Set(prev).add(folderPath);
        saveExpandedFolders(next);
        return next;
      });
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
            saveExpandedFolders(next);
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

  // --- DnD handlers ---

  const handleDragStart = (event: DragStartEvent) => {
    const file = event.active.data.current?.file as FileEntry | undefined;
    if (file) setDraggedFile(file);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggedFile(null);
    const { active, over } = event;
    if (!over) return;

    const sourceFile = active.data.current?.file as FileEntry | undefined;
    if (!sourceFile) return;

    // over.id is `folder:PATH` for droppable folders, or `root-drop` for root area
    const overId = String(over.id);
    let targetDir: string;
    if (overId === 'root-drop') {
      targetDir = currentPath;
    } else if (overId.startsWith('folder:')) {
      targetDir = overId.slice('folder:'.length);
    } else {
      return;
    }

    const norm = (p: string) => p.replace(/\\/g, '/');
    const sourcePath = norm(sourceFile.path);
    const sourceDir = sourcePath.split('/').slice(0, -1).join('/');
    const fileName = sourcePath.split('/').pop() || '';

    // Don't move to the same directory
    if (norm(targetDir) === sourceDir) return;
    // Don't move a folder into itself or its children
    if (sourceFile.is_dir && (norm(targetDir) === sourcePath || norm(targetDir).startsWith(sourcePath + '/'))) {
      toast.error('Cannot move folder into itself');
      return;
    }

    const newPath = targetDir + '/' + fileName;
    renameFile(sourceFile.path, newPath)
      .then(() => {
        toast.success(`Moved "${fileName}"`);
        refreshFolder(sourceDir);
        refreshFolder(targetDir);
      })
      .catch(() => toast.error('Failed to move file'));
  };

  const handleDragCancel = () => setDraggedFile(null);

  useEffect(() => {
    setChildrenCache(new Map());
    setCreatingInFolder(null);

    // Restore expanded folders from localStorage
    const saved = loadExpandedFolders();
    setExpandedFolders(saved);

    // Restore last viewed path (if no explicit rootPath override)
    const initialPath = rootPath || loadCurrentPath() || undefined;

    // Load root files, then re-fetch children for all saved expanded folders
    setLoading(true);
    listFiles(initialPath)
      .then(({ data }) => {
        setFiles(data.files || []);
        setCurrentPath(data.path);
        saveCurrentPath(data.path);
        // Capture workspace root on first load (no explicit rootPath = workspace dir)
        if (!workspaceRoot) setWorkspaceRoot(data.path);
        // Fetch children for each expanded folder in parallel
        if (saved.size > 0) {
          const fetches = [...saved].map((fp) =>
            listFiles(fp)
              .then(({ data: d }) => [fp, d.files || []] as const)
              .catch(() => null),
          );
          Promise.all(fetches).then((results) => {
            const cache = new Map<string, FileEntry[]>();
            const validExpanded = new Set<string>();
            for (const r of results) {
              if (r) {
                cache.set(r[0], r[1]);
                validExpanded.add(r[0]);
              }
            }
            setChildrenCache(cache);
            // Remove folders that no longer exist
            if (validExpanded.size < saved.size) {
              setExpandedFolders(validExpanded);
              saveExpandedFolders(validExpanded);
            }
          });
        }
      })
      .catch((err) => console.error('Failed to list files:', err))
      .finally(() => setLoading(false));
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
    // Keep expanded folders — only re-fetch data
    setChildrenCache(new Map());
    setCreatingInFolder(null);
    setLoading(true);
    listFiles(currentPath)
      .then(({ data }) => {
        setFiles(data.files || []);
        setCurrentPath(data.path);
        // Re-fetch children for expanded folders
        if (expandedFolders.size > 0) {
          const fetches = [...expandedFolders].map((fp) =>
            listFiles(fp)
              .then(({ data: d }) => [fp, d.files || []] as const)
              .catch(() => null),
          );
          Promise.all(fetches).then((results) => {
            const cache = new Map<string, FileEntry[]>();
            for (const r of results) {
              if (r) cache.set(r[0], r[1]);
            }
            setChildrenCache(cache);
          });
        }
      })
      .catch((err) => console.error('Failed to refresh:', err))
      .finally(() => setLoading(false));
  };

  // Expose imperative handle for EditorPanel toolbar buttons
  useImperativeHandle(ref, () => ({
    navigateTo: (path: string) => {
      setExpandedFolders(new Set());
      setChildrenCache(new Map());
      setCreatingInFolder(null);
      loadFiles(path);
    },
    refresh: handleRefresh,
    workspaceRoot,
  }));

  const canGoUp = currentPath && currentPath !== (rootPath || '');

  // Guard: prevent blur from re-submitting after Enter/Escape in creation input
  const createSubmittedRef = useRef(false);

  // Inline creation input component
  const renderCreationInput = (depth: number) => (
    <div
      className="w-full flex items-center gap-1.5 py-1.5 text-sm"
      style={{ paddingLeft: `${8 + depth * 16 + 20}px`, paddingRight: '12px' }}
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
          if (e.key === 'Enter') {
            createSubmittedRef.current = true;
            handleCreate(e.currentTarget.value.trim());
          }
          if (e.key === 'Escape') {
            createSubmittedRef.current = true;
            setCreatingType(null); setCreatingInFolder(null);
          }
        }}
        onBlur={(e) => {
          if (createSubmittedRef.current) { createSubmittedRef.current = false; return; }
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
      {/* Path breadcrumb */}
      <div
        className="flex items-center gap-1 px-3 py-1.5 text-xs shrink-0"
        style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--glass-border)' }}
      >
        {canGoUp && (
          <button
            type="button"
            onClick={goUp}
            className="hover:opacity-70 transition-opacity px-1 shrink-0"
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
      </div>

      {/* File list with DnD */}
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <RootDropZone
          onContextMenu={handleEmptyContextMenu}
          longPressHandlers={emptyLongPressHandlers}
        >
          {loading ? (
            <div className="p-4 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
              <span className="glow-pulse inline-block">Loading...</span>
            </div>
          ) : (
            <>
              {/* Root-level inline creation input */}
              {creatingType && !creatingInFolder && renderCreationInput(0)}

              {files.length === 0 && !creatingType ? (
                <div className="p-4 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
                  Empty directory
                </div>
              ) : (
                renderItems(files, 0)
              )}
            </>
          )}
        </RootDropZone>

        {/* DragOverlay: visual ghost during drag */}
        <DragOverlay dropAnimation={null}>
          {draggedFile && (
            <div
              className="flex items-center gap-1.5 py-1 px-3 text-sm rounded"
              style={{
                background: 'rgba(127, 0, 255, 0.15)',
                border: '1px solid var(--accent)',
                color: 'var(--text-primary)',
                backdropFilter: 'blur(8px)',
                whiteSpace: 'nowrap',
              }}
            >
              {draggedFile.is_dir ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              ) : (
                <span className="w-4 text-[10px] font-mono text-center font-bold" style={{ color: getFileColor(draggedFile) }}>
                  {getFileIcon(draggedFile)}
                </span>
              )}
              {draggedFile.name}
            </div>
          )}
        </DragOverlay>
      </DndContext>

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
});

export default FileTree;

/** Root-level drop zone — accepts file drops into current directory */
function RootDropZone({
  children,
  onContextMenu,
  longPressHandlers,
}: {
  children: React.ReactNode;
  onContextMenu: (e: React.MouseEvent) => void;
  longPressHandlers: Record<string, unknown>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: 'root-drop' });
  return (
    <div
      ref={setNodeRef}
      className="flex-1 overflow-y-auto py-1 select-none"
      style={{
        WebkitTouchCallout: 'none',
        outline: isOver ? '2px dashed var(--accent)' : 'none',
        outlineOffset: '-2px',
      }}
      onContextMenu={onContextMenu}
      {...longPressHandlers}
    >
      {children}
    </div>
  );
}
