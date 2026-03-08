import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useDraggable, useDroppable, useDndContext } from '@dnd-kit/core';
import { Panel, Group, Separator, usePanelRef, useGroupRef } from 'react-resizable-panels';
import { useWorkspaceStore, isPreviewableFile, type EditorTab } from '../../store/workspaceStore';
import { useLayoutStore } from '../../store/layoutStore';
import { useAuthStore } from '../../store/authStore';
import FileTree, { type FileTreeHandle } from '../files/FileTree';
import FileSearch from '../files/FileSearch';
import CodeEditor from './CodeEditor';
import ContextMenu from '../files/ContextMenu';
import { useLongPress, mergeEventHandlers } from '../../hooks/useLongPress';
import { getEditorSplit, setEditorSplit, savePreferencesToServer } from '../../utils/preferences';

function subscribeToMedia(cb: () => void) {
  const mql = window.matchMedia('(max-width: 640px)');
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
}
function getIsMobile() {
  return window.matchMedia('(max-width: 640px)').matches;
}

export default function EditorPanel() {
  const {
    openTabs,
    activeTabId,
    tempTabId,
    fileTreeVisible,
    activeSession,
    openFile,
    pinTab,
    openPreviewFile,
    closeTab,
    setActiveTab,
    setFileTreeVisible,
  } = useWorkspaceStore();
  const { showPanel } = useLayoutStore();

  const sharedDir = useAuthStore((s) => s.user?.shared_dir);
  const isMobile = useSyncExternalStore(subscribeToMedia, getIsMobile);
  const fileTreePanelRef = usePanelRef();
  const editorCodePanelRef = usePanelRef();
  const groupRef = useGroupRef();
  const fileTreeRef = useRef<FileTreeHandle>(null);
  const activeTab = openTabs.find((t) => t.id === activeTabId) || null;
  const [fileMode, setFileMode] = useState<'tree' | 'search'>('tree');
  const [rootPath, setRootPath] = useState('');
  const [currentTreePath, setCurrentTreePath] = useState('');
  const [savedSplit] = useState(getEditorSplit);
  const saveSplitTimer = useRef<number>(0);

  const activeFolder = useMemo(() => {
    const norm = (p: string) => p.replace(/\\/g, '/');
    const cp = norm(currentTreePath);
    const rp = norm(rootPath);
    if (!cp || !rp) return 'root' as const;
    if (sharedDir && cp.startsWith(norm(sharedDir))) return 'shared' as const;
    if (cp.startsWith(rp + '/uploads')) return 'uploads' as const;
    return 'root' as const;
  }, [currentTreePath, rootPath, sharedDir]);

  // Folder icon = droppable target for "move to workspace root"
  const { setNodeRef: setRootDropRef, isOver: isOverRoot } = useDroppable({
    id: rootPath ? `folder:${rootPath}` : 'folder:__root__',
    disabled: !rootPath,
  });

  // Capture workspace root from FileTree after first load
  useEffect(() => {
    const interval = setInterval(() => {
      const root = fileTreeRef.current?.workspaceRoot;
      if (root && root !== rootPath) {
        setRootPath(root);
        clearInterval(interval);
      }
    }, 500);
    return () => clearInterval(interval);
  }, [rootPath]);

  // Ref callback for path breadcrumb — scrolls to end to show filename
  const scrollEndRef = useCallback((el: HTMLDivElement | null) => {
    if (el) requestAnimationFrame(() => { el.scrollLeft = el.scrollWidth; });
  }, []);

  // When editor is collapsed and user selects a file or clicks a tab, restore 50/50
  const ensureEditorVisible = useCallback(() => {
    const editorPanel = editorCodePanelRef.current;
    if (editorPanel?.isCollapsed()) {
      groupRef.current?.setLayout({ 'editor-file-tree': 50, 'editor-code': 50 });
    }
  }, [editorCodePanelRef, groupRef]);

  const handleToggleFileTree = useCallback(() => {
    const panel = fileTreePanelRef.current;
    if (!panel) return;
    panel.isCollapsed() ? panel.expand() : panel.collapse();
  }, [fileTreePanelRef]);

  const handleFileTreeResize = useCallback(
    (size: { asPercentage: number; inPixels: number }) => {
      const isCollapsed = size.asPercentage === 0;
      const current = useWorkspaceStore.getState().fileTreeVisible;
      if (isCollapsed && current) setFileTreeVisible(false);
      else if (!isCollapsed && !current) setFileTreeVisible(true);
      // Debounced save split ratio
      if (!isCollapsed && size.asPercentage > 0) {
        clearTimeout(saveSplitTimer.current);
        saveSplitTimer.current = window.setTimeout(() => {
          setEditorSplit(`${size.asPercentage}%`);
          savePreferencesToServer();
        }, 300);
      }
    },
    [setFileTreeVisible],
  );

  // Sync imperative panel state when fileTreeVisible changes externally
  useEffect(() => {
    const panel = fileTreePanelRef.current;
    if (!panel) return;
    if (fileTreeVisible && panel.isCollapsed()) panel.expand();
    else if (!fileTreeVisible && !panel.isCollapsed()) panel.collapse();
  }, [fileTreeVisible, fileTreePanelRef]);

  // Detect when any file is being dragged (for folder icon glow)
  const { active } = useDndContext();
  const isDraggingFile = !!active && String(active.id).startsWith('file:');

  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <div className="editor-tab-bar">
        <button
          type="button"
          className={`editor-toggle-files ${fileTreeVisible ? 'active' : ''}`}
          onClick={handleToggleFileTree}
          title={fileTreeVisible ? 'Hide file manager' : 'Show file manager'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>

        <div className="editor-tabs-scroll">
          {openTabs.map((tab) => (
            <EditorTabButton
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              isTemp={tab.id === tempTabId}
              onSelect={() => { setActiveTab(tab.id); ensureEditorVisible(); }}
              onClose={() => closeTab(tab.id)}
              onPin={() => pinTab(tab.id)}
            />
          ))}
        </div>
      </div>

      {/* Main content: resizable file tree + editor */}
      <div className="flex-1 overflow-hidden">
        <Group orientation="horizontal" id="editor-inner" groupRef={groupRef}>
          <Panel
            id="editor-file-tree"
            panelRef={fileTreePanelRef}
            defaultSize={savedSplit}
            minSize={isMobile ? '80px' : '120px'}
            collapsible={true}
            collapsedSize="0px"
            onResize={handleFileTreeResize}
            className="editor-file-sidebar"
          >
            <div className="h-full flex flex-col">
              {/* Toolbar: mode toggle + nav buttons */}
              <div
                className="flex items-center gap-1 px-2 py-1 shrink-0 flex-wrap"
                style={{ borderBottom: '1px solid var(--glass-border)' }}
              >
                {/* Mode: tree / search */}
                <button
                  ref={setRootDropRef}
                  type="button"
                  className={`editor-toggle-files${fileMode === 'tree' && activeFolder === 'root' ? ' active' : ''}`}
                  onClick={() => {
                    if (fileMode === 'tree') {
                      const root = fileTreeRef.current?.workspaceRoot;
                      if (root) fileTreeRef.current?.navigateTo(root);
                    } else {
                      setFileMode('tree');
                    }
                  }}
                  title={fileMode === 'tree' ? 'Go to workspace root' : 'File tree'}
                  style={{
                    padding: '3px 6px',
                    transition: 'background 0.2s, box-shadow 0.2s, border-color 0.2s',
                    ...(isDraggingFile && isOverRoot ? {
                      background: 'rgba(var(--accent-rgb), 0.35)',
                      boxShadow: '0 0 12px 3px rgba(var(--accent-rgb), 0.5)',
                      borderColor: 'rgba(var(--accent-rgb), 0.8)',
                    } : isDraggingFile ? {
                      background: 'rgba(var(--accent-rgb), 0.12)',
                      boxShadow: '0 0 6px 1px rgba(var(--accent-rgb), 0.25)',
                      borderColor: 'rgba(var(--accent-rgb), 0.4)',
                    } : {}),
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    <polyline points="9 22 9 12 15 12 15 22" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`editor-toggle-files${fileMode === 'search' ? ' active' : ''}`}
                  onClick={() => { setFileMode('search'); }}
                  title="Search files"
                  style={{ padding: '3px 6px' }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </button>
                {/* Separator */}
                <div style={{ width: 1, height: 14, background: 'var(--glass-border)', margin: '0 2px' }} />
                {/* Uploads (Telegram) */}
                <button
                  type="button"
                  className={`editor-toggle-files${fileMode === 'tree' && activeFolder === 'uploads' ? ' active' : ''}`}
                  onClick={() => {
                    const root = fileTreeRef.current?.workspaceRoot;
                    if (root) { setFileMode('tree'); fileTreeRef.current?.navigateTo(root + '/uploads'); }
                  }}
                  title="Uploads (Telegram)"
                  style={{ padding: '3px 6px' }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </button>
                {/* Shared */}
                {sharedDir && (
                  <button
                    type="button"
                    className={`editor-toggle-files${fileMode === 'tree' && activeFolder === 'shared' ? ' active' : ''}`}
                    onClick={() => { setFileMode('tree'); fileTreeRef.current?.navigateTo(sharedDir); }}
                    title="Shared folder"
                    style={{ padding: '3px 6px' }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                  </button>
                )}
                <div className="flex-1" />
                {/* Refresh */}
                <button
                  type="button"
                  className="editor-toggle-files"
                  onClick={() => fileTreeRef.current?.refresh()}
                  title="Refresh"
                  style={{ padding: '3px 6px' }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                </button>
              </div>

              {/* Content: FileTree or FileSearch */}
              {fileMode === 'tree' ? (
                <FileTree
                  ref={fileTreeRef}
                  rootPath={activeSession?.working_directory}
                  onPathChange={setCurrentTreePath}
                  onFileSelect={(path) => {
                    if (!isPreviewableFile(path)) {
                      openFile(path, false);
                      ensureEditorVisible();
                    }
                  }}
                  onFileDoubleClick={(path) => {
                    if (isPreviewableFile(path)) {
                      openPreviewFile(path);
                      showPanel('preview');
                    } else {
                      openFile(path, true);
                      ensureEditorVisible();
                    }
                  }}
                  onFileOpenNewTab={(path) => {
                    if (isPreviewableFile(path)) {
                      openPreviewFile(path);
                      showPanel('preview');
                    } else {
                      openFile(path, true);
                      ensureEditorVisible();
                    }
                  }}
                />
              ) : (
                <FileSearch
                  onFileSelect={(path) => {
                    if (isPreviewableFile(path)) {
                      openPreviewFile(path);
                      showPanel('preview');
                    } else {
                      openFile(path, true);
                      ensureEditorVisible();
                    }
                  }}
                />
              )}
            </div>
          </Panel>
          <Separator className="resize-handle resize-handle-horizontal">
            <div className="resize-handle-line" />
          </Separator>
          <Panel id="editor-code" panelRef={editorCodePanelRef} minSize={isMobile ? '30%' : '20%'} collapsible={true} collapsedSize="0px">
            <div className="h-full flex flex-col">
              {activeTab && (
                <div
                  className="px-3 py-1 text-[11px] font-mono shrink-0 whitespace-nowrap"
                  ref={scrollEndRef}
                  style={{
                    color: 'var(--text-muted)',
                    borderBottom: '1px solid var(--glass-border)',
                    background: 'rgba(0,0,0,0.15)',
                    overflowX: 'auto',
                    scrollbarWidth: 'none',
                  }}
                  title={activeTab.filePath}
                >
                  {activeTab.filePath.replace(/\\/g, '/')}
                </div>
              )}
              <div className="flex-1 min-h-0">
                <CodeEditor
                  filePath={activeTab?.filePath || null}
                  tabId={activeTab?.id || null}
                />
              </div>
            </div>
          </Panel>
        </Group>
      </div>
    </div>
  );
}

function EditorTabButton({
  tab,
  isActive,
  isTemp,
  onSelect,
  onClose,
  onPin,
}: {
  tab: EditorTab;
  isActive: boolean;
  isTemp?: boolean;
  onSelect: () => void;
  onClose: () => void;
  onPin?: () => void;
}) {
  const { detachEditorTab } = useLayoutStore();
  const fileName = tab.filePath.split(/[/\\]/).pop() || tab.filePath;

  // Make tab draggable — dragging out of FM creates a detached panel
  // NOTE: we intentionally DON'T spread `attributes` — it applies CSS transform
  // to the original element, which gets clipped by overflow:auto parent
  // (.editor-tabs-scroll). DragOverlay in Workspace.tsx handles the visual ghost.
  const { listeners, setNodeRef, isDragging } = useDraggable({
    id: `editor-tab:${tab.id}`,
  });

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const { handlers: longPressHandlers, longPressedRef } = useLongPress({
    onLongPress: (x, y) => setCtxMenu({ x, y }),
  });

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  const handleCtxAction = useCallback((action: string) => {
    setCtxMenu(null);
    if (action === 'detach') {
      detachEditorTab(tab.id);
    } else if (action === 'close') {
      onClose();
    }
  }, [detachEditorTab, tab.id, onClose]);

  const ctxMenuItems = [
    {
      label: 'Open in Separate Panel',
      action: 'detach',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7" />
          <path d="M3 3h7v18H3a0 0 0 0 1 0 0V3z" />
        </svg>
      ),
    },
    { type: 'separator' as const },
    {
      label: 'Close Tab',
      action: 'close',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ),
    },
  ];

  return (
    <>
      <div
        ref={setNodeRef}
        className={`editor-tab ${isActive ? 'active' : ''}${isTemp ? ' preview' : ''}`}
        style={{ opacity: isDragging ? 0.3 : 1 }}
        onClick={() => {
          if (longPressedRef.current) { longPressedRef.current = false; return; }
          onSelect();
        }}
        onDoubleClick={() => { if (isTemp) onPin?.(); }}
        onMouseDown={(e) => {
          if (e.button === 1 && isActive) {
            e.preventDefault();
            onClose();
          }
        }}
        onContextMenu={handleContextMenu}
        {...mergeEventHandlers(longPressHandlers, listeners)}
        title={tab.filePath}
        role="tab"
        aria-selected={isActive}
      >
        <span className="truncate">{fileName}</span>
        {tab.modified && <span className="tab-modified-dot" />}
        {isActive && (
          <button
            type="button"
            className="tab-close-btn"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            title="Close tab"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenuItems}
          onAction={handleCtxAction}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </>
  );
}
