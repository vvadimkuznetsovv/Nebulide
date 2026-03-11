import React, { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef, type ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { listFiles, readFile, deleteFile, writeFile, mkdirFile, renameFile, sendToTelegram, extractArchive, copyFile, getDownloadUrl, type FileEntry } from '../../api/files';
import FileTreeItem from './FileTreeItem';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import { useLongPress } from '../../hooks/useLongPress';
import toast from 'react-hot-toast';
import { useAuthStore } from '../../store/authStore';
import { useWorkspaceStore } from '../../store/workspaceStore';

interface FileTreeProps {
  rootPath?: string;
  onFileSelect: (path: string) => void;
  onFileDoubleClick?: (path: string) => void;
  onFileOpenNewTab?: (path: string) => void;
  onPathChange?: (path: string) => void;
}

export interface FileTreeHandle {
  navigateTo: (path: string) => void;
  refresh: () => void;
  workspaceRoot: string;
  currentPath: string;
  selectedPaths: Set<string>;
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
  move: iconMulti('M4 4v7a4 4 0 0 0 4 4h12', 'M15 10l5 5-5 5'),
  trash: iconMulti('M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'),
  send: iconMulti('M22 2L11 13', 'M22 2l-7 20-4-9-9-4 20-7'),
  extract: iconMulti('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'),
  copy: iconMulti('M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'),
  paste: iconMulti('M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2', 'M15 2H9a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1z'),
  download: iconMulti('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'),
};

function getMenuItems(target: FileEntry | null, hasTelegram: boolean, multiCount: number, hasClipboard: boolean): ContextMenuItem[] {
  if (!target) {
    const items: ContextMenuItem[] = [
      { label: 'New File', action: 'new-file', icon: ICONS.filePlus },
      { label: 'New Folder', action: 'new-folder', icon: ICONS.folderPlus },
    ];
    if (hasClipboard) {
      items.push({ type: 'separator' });
      items.push({ label: 'Paste', action: 'paste', icon: ICONS.paste });
    }
    return items;
  }

  // Multi-select context menu
  if (multiCount > 1) {
    const items: ContextMenuItem[] = [
      { label: `Copy ${multiCount} items`, action: 'copy', icon: ICONS.copy },
    ];
    if (hasClipboard) {
      items.push({ label: 'Paste', action: 'paste', icon: ICONS.paste });
    }
    items.push({ type: 'separator' });
    items.push({ label: `Delete ${multiCount} items`, action: 'delete-multi', danger: true, icon: ICONS.trash });
    return items;
  }

  if (target.is_dir) {
    const items: ContextMenuItem[] = [
      { label: 'Open as Workspace', action: 'open-workspace', icon: ICONS.externalLink },
      { type: 'separator' },
      { label: 'New File Inside', action: 'new-file', icon: ICONS.filePlus },
      { label: 'New Folder Inside', action: 'new-folder', icon: ICONS.folderPlus },
      { type: 'separator' },
      { label: 'New File', action: 'new-file-parent', icon: ICONS.filePlus },
      { label: 'New Folder', action: 'new-folder-parent', icon: ICONS.folderPlus },
      { type: 'separator' },
      { label: 'Copy', action: 'copy', icon: ICONS.copy },
    ];
    if (hasClipboard) {
      items.push({ label: 'Paste', action: 'paste', icon: ICONS.paste });
    }
    items.push({ type: 'separator' });
    items.push({ label: 'Rename', action: 'rename', icon: ICONS.edit });
    items.push({ label: 'Move to...', action: 'move-to', icon: ICONS.move });
    items.push({ type: 'separator' });
    items.push({ label: 'Download as ZIP', action: 'download', icon: ICONS.download });
    if (hasTelegram) {
      items.push({ label: 'Send to Telegram', action: 'send-telegram', icon: ICONS.send });
    }
    items.push({ type: 'separator' });
    items.push({ label: 'Delete', action: 'delete', danger: true, icon: ICONS.trash });
    return items;
  }
  const isArchive = /\.(zip|rar)$/i.test(target.name);
  const items: ContextMenuItem[] = [
    { label: 'New File', action: 'new-file', icon: ICONS.filePlus },
    { label: 'New Folder', action: 'new-folder', icon: ICONS.folderPlus },
    { type: 'separator' },
    { label: 'Copy', action: 'copy', icon: ICONS.copy },
  ];
  if (hasClipboard) {
    items.push({ label: 'Paste', action: 'paste', icon: ICONS.paste });
  }
  items.push({ type: 'separator' });
  items.push({ label: 'Rename', action: 'rename', icon: ICONS.edit });
  items.push({ label: 'Move to...', action: 'move-to', icon: ICONS.move });
  items.push({ label: 'Open in New Tab', action: 'open-new-tab', icon: ICONS.externalLink });
  if (isArchive) {
    items.push({ type: 'separator' });
    items.push({ label: 'Extract Here', action: 'extract', icon: ICONS.extract });
  }
  items.push({ type: 'separator' });
  items.push({ label: 'Download', action: 'download', icon: ICONS.download });
  if (hasTelegram) {
    items.push({ label: 'Send to Telegram', action: 'send-telegram', icon: ICONS.send });
  }
  items.push({ type: 'separator' });
  items.push({ label: 'Delete', action: 'delete', danger: true, icon: ICONS.trash });
  return items;
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

const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(function FileTree({ rootPath, onFileSelect, onFileDoubleClick, onFileOpenNewTab, onPathChange }, ref) {
  const telegramId = useAuthStore(s => s.user?.telegram_id);
  const userWorkspaceDir = useAuthStore(s => s.user?.workspace_dir);
  const hasTelegram = !!telegramId;
  const { clipboardFiles, setClipboardFiles } = useWorkspaceStore();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState(rootPath || '');
  const [loading, setLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; target: FileEntry | null } | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const lastClickedPathRef = useRef<string | null>(null);
  const [creatingType, setCreatingType] = useState<'file' | 'folder' | null>(null);
  const [renamingFile, setRenamingFile] = useState<FileEntry | null>(null);

  // Tree state
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [childrenCache, setChildrenCache] = useState<Map<string, FileEntry[]>>(new Map());
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set());
  const [creatingInFolder, setCreatingInFolder] = useState<string | null>(null);
  const workspaceRoot = userWorkspaceDir || '';
  const [movingFile, setMovingFile] = useState<FileEntry | null>(null);
  const [moveFolders, setMoveFolders] = useState<FileEntry[]>([]);
  const [moveCurrentPath, setMoveCurrentPath] = useState<string>('');

  const loadFiles = async (path?: string) => {
    setLoading(true);
    try {
      const { data } = await listFiles(path);
      setFiles(data.files || []);
      setCurrentPath(data.path);
      saveCurrentPath(data.path);
      onPathChange?.(data.path);
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
        onPathChange?.(data.path);
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

  // Flatten visible tree for Shift+click range selection
  const getAllVisibleItems = useCallback((): FileEntry[] => {
    const result: FileEntry[] = [];
    const collect = (items: FileEntry[]) => {
      const sorted = [...items].sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const f of sorted) {
        result.push(f);
        if (f.is_dir && expandedFolders.has(f.path) && childrenCache.has(f.path)) {
          collect(childrenCache.get(f.path)!);
        }
      }
    };
    collect(files);
    return result;
  }, [files, expandedFolders, childrenCache]);

  const handleClick = (file: FileEntry, e?: React.MouseEvent) => {
    if (file.is_dir) {
      toggleFolder(file.path);
      // Ctrl+click: toggle folder in selection
      if (e && (e.ctrlKey || e.metaKey)) {
        setSelectedPaths(prev => {
          const next = new Set(prev);
          next.has(file.path) ? next.delete(file.path) : next.add(file.path);
          return next;
        });
      } else if (!e?.shiftKey) {
        setSelectedPaths(new Set([file.path]));
      }
      lastClickedPathRef.current = file.path;
      return;
    }

    if (e && (e.ctrlKey || e.metaKey)) {
      // Toggle individual selection
      setSelectedPaths(prev => {
        const next = new Set(prev);
        next.has(file.path) ? next.delete(file.path) : next.add(file.path);
        return next;
      });
      lastClickedPathRef.current = file.path;
    } else if (e?.shiftKey && lastClickedPathRef.current) {
      // Range selection
      const all = getAllVisibleItems();
      const lastIdx = all.findIndex(f => f.path === lastClickedPathRef.current);
      const curIdx = all.findIndex(f => f.path === file.path);
      if (lastIdx !== -1 && curIdx !== -1) {
        const [start, end] = lastIdx < curIdx ? [lastIdx, curIdx] : [curIdx, lastIdx];
        const range = new Set(all.slice(start, end + 1).map(f => f.path));
        setSelectedPaths(range);
      }
    } else {
      // Regular click: single selection + open file
      setSelectedPaths(new Set([file.path]));
      lastClickedPathRef.current = file.path;
      onFileSelect(file.path);
    }
  };

  const handleItemContextMenu = (x: number, y: number, file: FileEntry) => {
    // If right-clicking on an item NOT in current selection, select only that item
    if (!selectedPaths.has(file.path)) {
      setSelectedPaths(new Set([file.path]));
    }
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

  // Root folder droppable — drop onto empty space moves to current directory
  const { setNodeRef: setRootDropRef, isOver: isRootOver } = useDroppable({
    id: `folder:${currentPath}`,
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
      case 'move-to':
        if (target) {
          setMovingFile(target);
          setMoveCurrentPath(currentPath);
          // Load folders for the move dialog
          listFiles(currentPath).then(({ data }) => {
            setMoveFolders((data.files || []).filter(f => f.is_dir && f.path !== target.path));
          });
        }
        break;
      case 'extract':
        if (target && !target.is_dir) {
          const parentDir = target.path.split(/[/\\]/).slice(0, -1).join('/');
          toast.promise(
            extractArchive(target.path).then(() => refreshFolder(parentDir)),
            {
              loading: 'Extracting...',
              success: 'Extracted',
              error: (err) => err?.response?.data?.error || 'Failed to extract',
            }
          );
        }
        break;
      case 'send-telegram':
        if (target) {
          toast.promise(
            sendToTelegram(target.path),
            {
              loading: target.is_dir ? 'Archiving & sending...' : 'Sending...',
              success: 'Sent to Telegram',
              error: (err: { response?: { data?: { error?: string } } }) => err?.response?.data?.error || 'Failed to send',
            }
          );
        }
        break;
      case 'download':
        if (target) {
          const a = document.createElement('a');
          a.href = getDownloadUrl(target.path);
          a.download = '';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }
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
      case 'copy':
        if (target) {
          const paths = selectedPaths.has(target.path) && selectedPaths.size > 1
            ? [...selectedPaths] : [target.path];
          setClipboardFiles(paths);
          toast.success(`${paths.length} item(s) copied`);
        }
        break;
      case 'paste':
        if (clipboardFiles.length > 0) {
          const destFolder = target?.is_dir ? target.path : currentPath;
          pasteFiles(clipboardFiles, destFolder);
        }
        break;
      case 'delete-multi':
        if (selectedPaths.size > 1) {
          if (!window.confirm(`Delete ${selectedPaths.size} items?\nThis cannot be undone.`)) break;
          Promise.all([...selectedPaths].map(p => deleteFile(p)))
            .then(() => {
              toast.success(`${selectedPaths.size} items deleted`);
              setSelectedPaths(new Set());
              refreshFolder(currentPath);
            })
            .catch(() => toast.error('Failed to delete some items'));
        }
        break;
    }
  };

  const pasteFiles = async (sources: string[], destFolder: string) => {
    let count = 0;
    for (const src of sources) {
      const fileName = src.split(/[/\\]/).pop() || '';
      const baseName = fileName.replace(/\.[^.]+$/, '');
      const ext = fileName.includes('.') ? '.' + fileName.split('.').pop() : '';
      const destPath = destFolder + '/' + fileName;
      try {
        await copyFile(src, destPath);
        count++;
      } catch (err: unknown) {
        const axErr = err as { response?: { status?: number } };
        if (axErr.response?.status === 409) {
          // Name conflict — retry with suffix
          try {
            await copyFile(src, destFolder + '/' + baseName + ' (copy)' + ext);
            count++;
          } catch { toast.error(`Failed to paste ${fileName}`); }
        } else {
          toast.error(`Failed to paste ${fileName}`);
        }
      }
    }
    if (count > 0) {
      toast.success(`Pasted ${count} item(s)`);
      refreshFolder(destFolder);
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
    currentPath,
    selectedPaths,
  }));

  // Listen for external refresh events (e.g. after DnD file move in Workspace)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleRefreshStable = useCallback(handleRefresh, [currentPath, expandedFolders]);
  useEffect(() => {
    const handler = () => handleRefreshStable();
    window.addEventListener('filetree-refresh', handler);
    return () => window.removeEventListener('filetree-refresh', handler);
  }, [handleRefreshStable]);

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
          isSelected={selectedPaths.has(file.path)}
          isContextTarget={contextMenu?.target?.path === file.path}
          onClick={(e) => handleClick(file, e)}
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

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.code === 'KeyC') {
        if (selectedPaths.size > 0) {
          e.preventDefault();
          setClipboardFiles([...selectedPaths]);
          toast.success(`${selectedPaths.size} item(s) copied`);
        }
      } else if (e.code === 'KeyV') {
        if (clipboardFiles.length > 0) {
          e.preventDefault();
          pasteFiles(clipboardFiles, currentPath);
        }
      } else if (e.code === 'KeyA') {
        e.preventDefault();
        const all = getAllVisibleItems();
        setSelectedPaths(new Set(all.map(f => f.path)));
      }
    }
    if (e.key === 'Delete' && selectedPaths.size > 0) {
      e.preventDefault();
      if (selectedPaths.size === 1) {
        const path = [...selectedPaths][0];
        const target = getAllVisibleItems().find(f => f.path === path);
        if (target) {
          handleMenuAction('delete');
          // Re-open context with this target for the delete handler
        }
      } else {
        if (!window.confirm(`Delete ${selectedPaths.size} items?\nThis cannot be undone.`)) return;
        Promise.all([...selectedPaths].map(p => deleteFile(p)))
          .then(() => {
            toast.success(`${selectedPaths.size} items deleted`);
            setSelectedPaths(new Set());
            refreshFolder(currentPath);
          })
          .catch(() => toast.error('Failed to delete some items'));
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPaths, clipboardFiles, currentPath]);

  return (
    <div
      className="flex-1 min-h-0 flex flex-col"
      style={{ background: 'transparent' }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* File list — also root folder droppable */}
      <div
        ref={setRootDropRef}
        className="flex-1 overflow-y-auto py-1 select-none"
        style={{
          WebkitTouchCallout: 'none',
          ...(isRootOver ? { background: 'rgba(var(--accent-rgb), 0.08)', outline: '1px dashed rgba(var(--accent-rgb), 0.4)' } : {}),
        }}
        onContextMenu={handleEmptyContextMenu}
        {...emptyLongPressHandlers}
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
      </div>

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getMenuItems(
            contextMenu.target,
            hasTelegram,
            contextMenu.target && selectedPaths.has(contextMenu.target.path) ? selectedPaths.size : 0,
            clipboardFiles.length > 0,
          )}
          onAction={handleMenuAction}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Move to dialog */}
      {movingFile && (
        <div
          className="absolute inset-0 z-50 flex flex-col"
          style={{ background: 'rgba(3,1,8,0.85)', backdropFilter: 'blur(8px)' }}
        >
          <div className="flex items-center gap-2 px-3 py-2 shrink-0" style={{ borderBottom: '1px solid var(--glass-border)' }}>
            <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
              Move "{movingFile.name}" to:
            </span>
            <div className="flex-1" />
            <button
              type="button"
              className="text-xs px-2 py-0.5 rounded"
              style={{ color: 'var(--text-secondary)', border: '1px solid var(--glass-border)' }}
              onClick={() => setMovingFile(null)}
            >
              Cancel
            </button>
          </div>
          {/* Move here button */}
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left"
            style={{
              color: 'var(--accent-bright)',
              borderBottom: '1px solid var(--glass-border)',
              background: 'rgba(var(--accent-rgb),0.08)',
            }}
            onClick={() => {
              const fileName = movingFile.name;
              const destPath = moveCurrentPath.replace(/\\/g, '/') + '/' + fileName;
              const srcPath = movingFile.path;
              if (srcPath.replace(/\\/g, '/') === destPath) {
                toast.error('Already in this folder');
                return;
              }
              renameFile(srcPath, destPath)
                .then(() => {
                  toast.success(`Moved ${fileName}`);
                  setMovingFile(null);
                  handleRefresh();
                })
                .catch(() => toast.error('Failed to move'));
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            Move here ({moveCurrentPath.split(/[/\\]/).pop() || '/'})
          </button>
          {/* Go up */}
          {moveCurrentPath && moveCurrentPath !== (rootPath || '') && moveCurrentPath !== workspaceRoot && (
            <button
              type="button"
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left"
              style={{ color: 'var(--text-secondary)' }}
              onClick={() => {
                const parent = moveCurrentPath.split(/[/\\]/).slice(0, -1).join('/');
                setMoveCurrentPath(parent);
                listFiles(parent).then(({ data }) => {
                  setMoveFolders((data.files || []).filter(f => f.is_dir && f.path !== movingFile.path));
                });
              }}
            >
              ..
            </button>
          )}
          {/* Folder list */}
          <div className="flex-1 overflow-y-auto">
            {moveFolders.length === 0 ? (
              <div className="p-3 text-xs text-center" style={{ color: 'var(--text-muted)' }}>
                No subfolders
              </div>
            ) : (
              moveFolders.map(folder => (
                <button
                  key={folder.path}
                  type="button"
                  className="file-tree-item w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left"
                  style={{ color: 'var(--text-primary)' }}
                  onClick={() => {
                    setMoveCurrentPath(folder.path);
                    listFiles(folder.path).then(({ data }) => {
                      setMoveFolders((data.files || []).filter(f => f.is_dir && f.path !== movingFile.path));
                    });
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  {folder.name}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export default FileTree;

