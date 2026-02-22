import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { Panel, Group, Separator, usePanelRef, useGroupRef } from 'react-resizable-panels';
import { useWorkspaceStore, isPreviewableFile, type EditorTab } from '../../store/workspaceStore';
import { useLayoutStore } from '../../store/layoutStore';
import FileTree from '../files/FileTree';
import CodeEditor from './CodeEditor';
import ContextMenu from '../files/ContextMenu';
import { useLongPress } from '../../hooks/useLongPress';

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
    fileTreeVisible,
    activeSession,
    openFile,
    openPreviewFile,
    closeTab,
    setActiveTab,
    setFileTreeVisible,
  } = useWorkspaceStore();
  const { visibility, toggleVisibility } = useLayoutStore();

  const isMobile = useSyncExternalStore(subscribeToMedia, getIsMobile);
  const fileTreePanelRef = usePanelRef();
  const editorCodePanelRef = usePanelRef();
  const groupRef = useGroupRef();
  const activeTab = openTabs.find((t) => t.id === activeTabId) || null;

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
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </button>

        <div className="editor-tabs-scroll">
          {openTabs.map((tab) => (
            <EditorTabButton
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              onSelect={() => { setActiveTab(tab.id); ensureEditorVisible(); }}
              onClose={() => closeTab(tab.id)}
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
            defaultSize="20%"
            minSize={isMobile ? '80px' : '120px'}
            collapsible={true}
            collapsedSize="0px"
            onResize={handleFileTreeResize}
            className="editor-file-sidebar"
          >
            {/* Stop native touchmove from reaching Monaco's document-level touch tracker
               (prevents "UNKNOWN touch" console spam when scrolling file tree on mobile) */}
            <div
              className="h-full"
              onTouchMoveCapture={(e) => e.nativeEvent.stopImmediatePropagation()}
            >
            <FileTree
              rootPath={activeSession?.working_directory}
              onFileSelect={(path) => {
                if (isPreviewableFile(path)) {
                  openPreviewFile(path);
                  if (!visibility.preview) toggleVisibility('preview');
                } else {
                  openFile(path, false);
                  ensureEditorVisible();
                }
              }}
              onFileOpenNewTab={(path) => {
                if (isPreviewableFile(path)) {
                  openPreviewFile(path);
                  if (!visibility.preview) toggleVisibility('preview');
                } else {
                  openFile(path, true);
                  ensureEditorVisible();
                }
              }}
            />
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
                  ref={(el) => { if (el) requestAnimationFrame(() => { el.scrollLeft = el.scrollWidth; }); }}
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
  onSelect,
  onClose,
}: {
  tab: EditorTab;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
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
        className={`editor-tab ${isActive ? 'active' : ''}`}
        style={{ opacity: isDragging ? 0.3 : 1 }}
        onClick={() => {
          if (longPressedRef.current) { longPressedRef.current = false; return; }
          onSelect();
        }}
        onMouseDown={(e) => {
          if (e.button === 1 && isActive) {
            e.preventDefault();
            onClose();
          }
        }}
        onContextMenu={handleContextMenu}
        {...longPressHandlers}
        title={tab.filePath}
        role="tab"
        aria-selected={isActive}
        {...listeners}
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
