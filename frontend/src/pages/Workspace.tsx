import { useCallback, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  useSensor,
  useSensors,
  pointerWithin,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  type Modifier,
  type CollisionDetection,
} from '@dnd-kit/core';
import { ScrollAwareTouchSensor } from '../utils/ScrollAwareTouchSensor';
import { useAuth } from '../hooks/useAuth';
import { renameFile, copyFile } from '../api/files';
import { getFileTreeSelectedPaths } from '../components/files/FileTree';
import { useAuthStore } from '../store/authStore';
import { useLayoutStore, type PanelId } from '../store/layoutStore';
import { findPanelNode, isDetachedEditor } from '../store/layoutUtils';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useWorkspaceSessionStore, isRestoringSnapshot, forceSaveSnapshot, markVisible } from '../store/workspaceSessionStore';
import { setReorderHover, clearReorderHover, getReorderHover } from '../hooks/useTabReorder';
import { useSyncWS } from '../hooks/useSyncWS';
import { syncThemeFromServer } from '../utils/theme';
import { useGlobalImagePaste } from '../hooks/useGlobalImagePaste';
import LavaLamp from '../components/LavaLamp';
import Sidebar from '../components/layout/Sidebar';
import LayoutRenderer from '../components/layout/LayoutRenderer';
import EdgeDropZone from '../components/layout/EdgeDropZone';
import { panelIcons, getPanelIcon, getPanelTitle } from '../components/layout/PanelContent';
import { useTerminalRegistryVersion } from '../utils/terminalRegistry';
import { log } from '../utils/logger';

// Custom collision detection: when dragging file tree items, prioritize
// file tree drop targets (folder:/filezone:) over large panel zones (merge-/split-).
// pointerWithin sorts by intersection ratio ascending — large panel zones have
// smaller ratios and win over small file tree items. We override this for file drags.
const fileTreeAwareCollision: CollisionDetection = (args) => {
  const collisions = pointerWithin(args);
  const dragId = args.active?.id ? String(args.active.id) : '';

  // Tab drags: prioritize tab-drop zones over large panel split/merge zones
  if (dragId.startsWith('editor-tab:') || (!dragId.startsWith('file:') && !dragId.startsWith('editor-tab:') && collisions.some(c => String(c.id).startsWith('tab-drop:')))) {
    const tabCollisions = collisions.filter(c => String(c.id).startsWith('tab-drop:'));
    if (tabCollisions.length > 0) return tabCollisions;
  }

  if (dragId.startsWith('file:')) {
    // Toolbar buttons (toolbar:) have priority over FileTree zones (folder:/filezone:)
    const toolbarCollisions = collisions.filter(c => String(c.id).startsWith('toolbar:'));
    if (toolbarCollisions.length > 0) return toolbarCollisions;
    const ftCollisions = collisions.filter(
      (c) => {
        const id = String(c.id);
        return id.startsWith('folder:') || id.startsWith('filezone:');
      },
    );
    if (ftCollisions.length > 0) return ftCollisions;
  }
  return collisions;
};

// On touch, snap overlay center to finger — prevents offset jump
const touchSnapCenter: Modifier = ({ activatorEvent, draggingNodeRect, overlayNodeRect, transform }) => {
  if (!activatorEvent || !draggingNodeRect) return transform;
  if (!('touches' in activatorEvent)) return transform;

  const touch = (activatorEvent as TouchEvent).touches[0];
  if (!touch) return transform;

  const grabOffsetX = touch.clientX - draggingNodeRect.left;
  const grabOffsetY = touch.clientY - draggingNodeRect.top;
  const rect = overlayNodeRect ?? draggingNodeRect;

  return {
    ...transform,
    x: transform.x + grabOffsetX - rect.width / 2,
    y: transform.y + grabOffsetY - rect.height / 2,
  };
};

export default function Workspace() {
  useAuth();
  useSyncWS();
  useGlobalImagePaste();
  useTerminalRegistryVersion(); // re-render DragOverlay when terminal numbering changes

  // Initialize workspace sessions on mount + auto-save periodically
  const initSession = useWorkspaceSessionStore((s) => s.initSession);
  const saveCurrentSession = useWorkspaceSessionStore((s) => s.saveCurrentSession);

  useEffect(() => {
    initSession();
  }, [initSession]);

  // Enhanced auto-save: debounced 2s on state changes + 30s safety + beforeunload
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    // Guard: don't save from background tab — prevents overwriting active device's snapshot
    const shouldSave = () => document.visibilityState === 'visible';

    const debouncedSave = () => {
      if (!shouldSave()) return;
      if (isRestoringSnapshot()) return;
      log('[Workspace] debouncedSave triggered (store changed)');
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        if (!shouldSave()) return;
        if (isRestoringSnapshot()) return;
        log('[Workspace] debouncedSave FIRING (500ms elapsed)');
        saveCurrentSession();
        debounceRef.current = null;
      }, 500);
    };

    const unsubLayout = useLayoutStore.subscribe((state, prev) => {
      if (!shouldSave()) return;
      if (isRestoringSnapshot()) return;
      const s = state as unknown as Record<string, unknown>;
      const p = prev as unknown as Record<string, unknown>;
      const changed = Object.keys(s).filter(k => s[k] !== p[k]);
      log('[Workspace] layoutStore changed:', changed);
      // Visibility/layout tree changed = panel opened/closed/moved — save immediately
      if (state.visibility !== prev.visibility || state.layout !== prev.layout) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        saveCurrentSession();
        return;
      }
      debouncedSave();
    });
    const unsubWorkspace = useWorkspaceStore.subscribe((state, prev) => {
      if (!shouldSave()) return;
      if (isRestoringSnapshot()) return;
      const s = state as unknown as Record<string, unknown>;
      const p = prev as unknown as Record<string, unknown>;
      const changed = Object.keys(s).filter(k => s[k] !== p[k]);
      log('[Workspace] workspaceStore changed:', changed);
      // Tab closed or detached editors changed — save immediately
      if (state.openTabs.length < prev.openTabs.length ||
          Object.keys(state.detachedEditors).length !== Object.keys(prev.detachedEditors).length) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        saveCurrentSession();
        return;
      }
      debouncedSave();
    });
    const safetyInterval = setInterval(() => {
      // Don't save from background tab — prevents overwriting active device's snapshot
      if (document.visibilityState === 'visible') saveCurrentSession();
    }, 30_000);

    const handleBeforeUnload = () => forceSaveSnapshot();
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      unsubLayout();
      unsubWorkspace();
      clearInterval(safetyInterval);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [saveCurrentSession]);

  // Cross-device sync: save snapshot when leaving, restore when returning
  const reloadActiveSession = useWorkspaceSessionStore((s) => s.reloadActiveSession);
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'hidden') {
        forceSaveSnapshot();
      } else if (document.visibilityState === 'visible') {
        markVisible();
        syncThemeFromServer();
        reloadActiveSession({ soft: true, skipSave: true });
      }
    };
    document.addEventListener('visibilitychange', handler);
    // pagehide is more reliable than beforeunload on mobile
    const handlePageHide = () => forceSaveSnapshot();
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      document.removeEventListener('visibilitychange', handler);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [saveCurrentSession, reloadActiveSession]);

  // Global Ctrl+Shift+C copy (capture phase, respects Developer Mode)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.code !== 'KeyC') return;
      if (useWorkspaceStore.getState().devMode) return; // Let DevTools open

      e.preventDefault();
      // Check text selection (works for Monaco, preview, etc.)
      const textSel = document.getSelection()?.toString();
      if (textSel) {
        navigator.clipboard.writeText(textSel).then(() => {
          import('react-hot-toast').then(m => m.default.success('Copied'));
        });
        return;
      }
      // Check terminal selection
      import('../components/terminal/Terminal').then(m => {
        const termSel = m.getAnyTerminalSelection?.();
        if (termSel) {
          navigator.clipboard.writeText(termSel).then(() => {
            import('react-hot-toast').then(t => t.default.success('Copied'));
          });
        }
      });
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  const {
    layout,
    visibility,
    mergePanels,
    splitPanel,
    movePanelToEdge,
    setDragging,
    setDraggingEditorTab,
    detachEditorTabToSplit,
    detachEditorTabToEdge,
    detachEditorTabToMerge,
    reattachEditor,
    reorderPanelTab,
    movePanelTabToNode,
  } = useLayoutStore();

  const {
    sidebarOpen,
    setSidebarOpen,
  } = useWorkspaceStore();

  // Lock state
  const showLockWarning = useWorkspaceSessionStore((s) => s.showLockWarning);
  const lockWarningSessionId = useWorkspaceSessionStore((s) => s.lockWarningSessionId);
  const lockInfoMap = useWorkspaceSessionStore((s) => s.lockInfo);
  const lockStatusMap = useWorkspaceSessionStore((s) => s.lockStatus);
  const activeSessionId = useWorkspaceSessionStore((s) => s.activeSessionId);
  const forceTakeover = useWorkspaceSessionStore((s) => s.forceTakeover);
  const dismissLockWarning = useWorkspaceSessionStore((s) => s.dismissLockWarning);
  const isBlocked = activeSessionId ? lockStatusMap[activeSessionId] === 'blocked' : false;
  const warningLockInfo = lockWarningSessionId ? lockInfoMap[lockWarningSessionId] : null;

  // Check if any panel is visible (to show fallback sidebar toggle)
  const anyPanelVisible = Object.entries(visibility).some(([, v]) => v);

  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [draggedFiles, setDraggedFiles] = useState<string[]>([]);
  const [pendingSharedDrop, setPendingSharedDrop] = useState<{
    files: Array<{ src: string; dest: string; name: string }>;
  } | null>(null);

  const mouseSensor = useSensor(MouseSensor, { activationConstraint: { distance: 8 } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const touchSensor = useSensor(ScrollAwareTouchSensor as any, { delay: 600, tolerance: 10 });
  const sensors = useSensors(mouseSensor, touchSensor);

  // DnD handlers
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const dragId = String(event.active.id);
    setActiveDragId(dragId);

    // File tree DnD — collect selected files for multi-select drag
    if (dragId.startsWith('file:')) {
      const srcPath = dragId.slice('file:'.length);
      const selected = getFileTreeSelectedPaths();
      if (selected.has(srcPath) && selected.size > 1) {
        setDraggedFiles([...selected]);
      } else {
        setDraggedFiles([srcPath]);
      }
      return;
    }

    // Editor tab drag from File Manager
    if (dragId.startsWith('editor-tab:')) {
      setDraggingEditorTab(dragId.slice('editor-tab:'.length));
    } else {
      setDragging(dragId as PanelId);
    }
  }, [setDragging, setDraggingEditorTab]);

  // Track tab reorder hover for animated gap
  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over, active } = event;
    if (!over || !active) { clearReorderHover(); return; }

    const overId = String(over.id);
    if (!overId.startsWith('tab-drop:')) { clearReorderHover(); return; }

    // Parse over data
    const data = over.data?.current as { type?: string; index?: number; containerId?: string } | undefined;
    if (!data?.containerId || data.index == null) { clearReorderHover(); return; }

    // Compute left/right edge: pointer position vs over element center
    const overRect = over.rect;
    // @dnd-kit provides active.rect.current.translated with pointer position
    const translated = active.rect.current.translated;
    if (!overRect || !translated) { clearReorderHover(); return; }

    const pointerX = translated.left + translated.width / 2;
    const midX = overRect.left + overRect.width / 2;
    const insertBefore = pointerX < midX;

    // Get dragged tab width for gap sizing
    const draggedWidth = active.rect.current.initial?.width ?? 100;

    const insertIndex = insertBefore ? data.index : data.index + 1;

    setReorderHover({
      containerId: data.containerId,
      insertIndex,
      draggedWidth,
      draggedId: String(active.id),
    });
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const dragId = String(event.active.id);
    setActiveDragId(null);
    setDragging(null);
    const currentDraggedFiles = draggedFiles;
    setDraggedFiles([]);

    // Clear reorder hover state
    const reorderInfo = getReorderHover();
    clearReorderHover();

    const { over } = event;
    if (!over) return;
    const targetId = String(over.id);

    // === Tab reorder/move ===
    if (targetId.startsWith('tab-drop:') && reorderInfo) {
      const { containerId, insertIndex } = reorderInfo;

      // Editor tab reorder
      if (dragId.startsWith('editor-tab:')) {
        const tabId = dragId.slice('editor-tab:'.length);
        if (containerId === 'editor-main') {
          useWorkspaceStore.getState().reorderTab(tabId, insertIndex);
        }
        setDraggingEditorTab(null);
        return;
      }

      // Panel tab reorder/move
      const panelId = dragId as PanelId;
      const sourceNode = findPanelNode(layout, panelId);
      if (sourceNode) {
        if (sourceNode.id === containerId) {
          // Same node — reorder
          reorderPanelTab(containerId, panelId, insertIndex);
        } else {
          // Different node — move
          movePanelTabToNode(panelId, containerId, insertIndex);
        }
      }
      return;
    }

    // === File tree DnD: move file/folder into target folder ===
    // toolbar: = EditorPanel toolbar buttons, folder: = FileTree folders, filezone: = file's parent
    if (dragId.startsWith('file:') && (targetId.startsWith('folder:') || targetId.startsWith('filezone:') || targetId.startsWith('toolbar:'))) {
      let destFolder: string;
      if (targetId.startsWith('toolbar:')) {
        destFolder = targetId.slice('toolbar:'.length);
      } else if (targetId.startsWith('folder:')) {
        destFolder = targetId.slice('folder:'.length);
      } else {
        const filePath = targetId.slice('filezone:'.length);
        destFolder = filePath.split(/[/\\]/).slice(0, -1).join('/');
      }
      const normDest = destFolder.replace(/\\/g, '/');

      // Build moves list from all dragged files
      const filesToMove = currentDraggedFiles.length > 0 ? currentDraggedFiles : [dragId.slice('file:'.length)];
      const moves = filesToMove.map(src => {
        const name = src.split(/[/\\]/).pop() || '';
        const dest = normDest + '/' + name;
        const normSrc = src.replace(/\\/g, '/');
        const srcParent = normSrc.split('/').slice(0, -1).join('/');
        // Guards: same path, already in folder, folder onto itself, or dest inside source (cycle)
        if (normSrc === dest || srcParent === normDest || normDest === normSrc || normDest.startsWith(normSrc + '/')) return null;
        return { src, dest, name };
      }).filter((m): m is { src: string; dest: string; name: string } => m !== null);

      if (moves.length === 0) return;

      // Dropping into Shared folder → show Copy/Move modal
      const sharedDir = useAuthStore.getState().user?.shared_dir;
      if (sharedDir && normDest.startsWith(sharedDir.replace(/\\/g, '/'))) {
        setPendingSharedDrop({ files: moves });
        return;
      }

      Promise.all(moves.map(m => renameFile(m.src, m.dest)))
        .then(() => {
          window.dispatchEvent(new CustomEvent('filetree-refresh'));
          const msg = moves.length === 1 ? `Moved ${moves[0].name}` : `Moved ${moves.length} files`;
          import('react-hot-toast').then(mod => mod.default.success(msg));
        })
        .catch(() => {
          import('react-hot-toast').then(mod => mod.default.error('Failed to move files'));
        });
      return;
    }

    // === Editor tab dragged from File Manager ===
    if (dragId.startsWith('editor-tab:')) {
      const tabId = dragId.slice('editor-tab:'.length);

      // Edge drop
      const edgeMatch = targetId.match(/^edge-(left|right|top|bottom)$/);
      if (edgeMatch) {
        detachEditorTabToEdge(tabId, edgeMatch[1] as 'left' | 'right' | 'top' | 'bottom');
        return;
      }

      // Directional split
      const splitMatch = targetId.match(/^split-(top|bottom|left|right)-(.+)$/);
      if (splitMatch) {
        const [, direction, nodeId] = splitMatch;
        detachEditorTabToSplit(tabId, nodeId, direction as 'top' | 'bottom' | 'left' | 'right');
        return;
      }

      // Center merge
      if (targetId.startsWith('merge-')) {
        const nodeId = targetId.replace('merge-', '');
        detachEditorTabToMerge(tabId, nodeId);
      }
      return;
    }

    // === Regular panel drag ===
    const draggedPanelId = dragId as PanelId;

    // Check if a detached editor is being dropped onto the files node → reattach
    if (isDetachedEditor(draggedPanelId) && targetId.startsWith('merge-')) {
      const nodeId = targetId.replace('merge-', '');
      const filesNode = findPanelNode(layout, 'files');
      if (filesNode && filesNode.id === nodeId) {
        reattachEditor(draggedPanelId);
        useLayoutStore.getState().setNodeActiveTab(nodeId, 'files');
        return;
      }
    }

    // Edge drop — create new column or row
    const edgeMatch = targetId.match(/^edge-(left|right|top|bottom)$/);
    if (edgeMatch) {
      movePanelToEdge(draggedPanelId, edgeMatch[1] as 'left' | 'right' | 'top' | 'bottom');
      return;
    }

    // Directional split — drop on top/bottom/left/right zone
    const splitMatch = targetId.match(/^split-(top|bottom|left|right)-(.+)$/);
    if (splitMatch) {
      const [, direction, nodeId] = splitMatch;
      splitPanel(draggedPanelId, nodeId, direction as 'top' | 'bottom' | 'left' | 'right');
      return;
    }

    // Center drop — merge into target node's tabs
    if (targetId.startsWith('merge-')) {
      const nodeId = targetId.replace('merge-', '');
      const sourceNode = findPanelNode(layout, draggedPanelId);
      if (sourceNode && sourceNode.id === nodeId) return;
      mergePanels(draggedPanelId, nodeId);
    }
  }, [layout, mergePanels, splitPanel, movePanelToEdge, setDragging, setDraggingEditorTab, detachEditorTabToSplit, detachEditorTabToEdge, detachEditorTabToMerge, reattachEditor, reorderPanelTab, movePanelTabToNode, draggedFiles]);

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
    setDraggedFiles([]);
    setDragging(null);
    clearReorderHover();
  }, [setDragging]);

  // Get drag overlay content
  const getDragOverlayContent = () => {
    if (!activeDragId) return null;

    // File tree item (single or multi-select)
    if (activeDragId.startsWith('file:')) {
      const filePath = activeDragId.slice('file:'.length);
      const fileName = filePath.split(/[/\\]/).pop() || 'File';
      const count = draggedFiles.length;
      return (
        <div className="drag-overlay-panel" style={{ position: 'relative' }}>
          <div className="flex items-center gap-2 px-3 py-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span className="text-xs font-semibold" style={{ color: 'rgba(255,255,255,0.8)' }}>
              {count > 1 ? `${count} files` : fileName}
            </span>
          </div>
          {count > 1 && (
            <span style={{
              position: 'absolute', top: -6, right: -6,
              background: 'var(--accent)', color: '#fff',
              borderRadius: '50%', width: 18, height: 18,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, fontWeight: 700,
            }}>{count}</span>
          )}
        </div>
      );
    }

    // Editor tab from FM
    if (activeDragId.startsWith('editor-tab:')) {
      const tabId = activeDragId.slice('editor-tab:'.length);
      const tab = useWorkspaceStore.getState().openTabs.find((t) => t.id === tabId);
      const fileName = tab ? tab.filePath.split(/[/\\]/).pop() : 'File';
      return (
        <div className="drag-overlay-panel">
          <div className="flex items-center gap-2 px-3 py-2">
            {panelIcons.editor}
            <span className="text-xs font-semibold" style={{ color: 'rgba(255,255,255,0.8)' }}>
              {fileName}
            </span>
          </div>
        </div>
      );
    }

    // Regular panel or detached editor
    const panelId = activeDragId as PanelId;
    return (
      <div className="drag-overlay-panel">
        <div className="flex items-center gap-2 px-3 py-2">
          {getPanelIcon(panelId)}
          <span className="text-xs font-semibold" style={{ color: 'rgba(255,255,255,0.8)' }}>
            {getPanelTitle(panelId)}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="h-full relative overflow-hidden">
      <LavaLamp />

      {/* === UNIFIED LAYOUT — same on mobile and desktop === */}
      <DndContext sensors={sensors} collisionDetection={fileTreeAwareCollision} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel}>
        <div className="flex flex-col h-full relative z-10 p-2 lg:p-4">
          {/* Edge drop zone — top */}
          <EdgeDropZone edge="top" />

          <div className="flex flex-1 min-h-0 gap-0">
            {/* Edge drop zone — left */}
            <EdgeDropZone edge="left" />

            {/* Sidebar — static on desktop only */}
            <div
              className="hidden lg:block"
              style={{
                width: sidebarOpen ? '260px' : '0px',
                opacity: sidebarOpen ? 1 : 0,
                overflow: 'hidden',
                transition: 'width 0.3s cubic-bezier(0.4,0,0.2,1), opacity 0.2s ease',
                flexShrink: 0,
                marginRight: sidebarOpen ? '12px' : '0px',
              }}
            >
              <div className="workspace-glass-panel h-full" style={{ width: '260px' }}>
                <div className="workspace-glass-panel-shimmer" />
                <div className="workspace-glass-panel-content">
                  <Sidebar
                    isOpen={true}
                    onClose={() => setSidebarOpen(false)}
                  />
                </div>
              </div>
            </div>

            {/* Main layout area — recursive renderer */}
            <div className="flex-1 min-w-0 h-full">
              <LayoutRenderer node={layout} isFirst={true} />

              {/* Fallback: sidebar toggle when all panels are hidden */}
              {!anyPanelVisible && (
                <div className="absolute top-2 left-2 z-20">
                  <button
                    type="button"
                    className="global-panel-bar-sidebar-btn"
                    onClick={() => setSidebarOpen(true)}
                    title="Show sidebar"
                    style={{ width: 48, height: 48 }}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <line x1="3" y1="6" x2="21" y2="6" />
                      <line x1="3" y1="12" x2="21" y2="12" />
                      <line x1="3" y1="18" x2="21" y2="18" />
                    </svg>
                  </button>
                </div>
              )}
            </div>

            {/* Edge drop zone — right */}
            <EdgeDropZone edge="right" />
          </div>

          {/* Edge drop zone — bottom */}
          <EdgeDropZone edge="bottom" />
        </div>

        {/* Mobile sidebar overlay — hidden on desktop where static sidebar is used */}
        <div className="lg:hidden">
          <Sidebar
            isOpen={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
          />
        </div>

        {/* DragOverlay */}
        <DragOverlay modifiers={[touchSnapCenter]}>
          {getDragOverlayContent()}
        </DragOverlay>
      </DndContext>

      {/* Persistent banner when workspace is blocked by another device */}
      {isBlocked && activeSessionId && (
        <div
          className="absolute top-0 left-0 right-0 z-50 flex items-center justify-center py-1.5 px-4"
          style={{
            background: 'rgba(251, 191, 36, 0.08)',
            borderBottom: '1px solid rgba(251, 191, 36, 0.2)',
            backdropFilter: 'blur(10px)',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgb(251, 191, 36)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-2 flex-shrink-0">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span className="text-xs" style={{ color: 'rgb(251, 191, 36)' }}>
            Workspace locked by another device
          </span>
          <button
            type="button"
            onClick={() => forceTakeover(activeSessionId)}
            className="ml-3 text-xs font-semibold underline"
            style={{ color: 'rgb(251, 191, 36)' }}
          >
            Take over
          </button>
        </div>
      )}

      {/* Shared folder Copy/Move modal */}
      {pendingSharedDrop && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          style={{ background: 'rgba(0, 0, 0, 0.5)', backdropFilter: 'blur(6px)' }}
          onClick={() => setPendingSharedDrop(null)}
          onKeyDown={(e) => { if (e.key === 'Escape') setPendingSharedDrop(null); }}
        >
          <div
            className="w-full max-w-xs rounded-2xl p-5"
            style={{
              background: 'rgba(20, 10, 30, 0.85)',
              border: '1px solid var(--glass-border)',
              backdropFilter: 'blur(20px)',
              boxShadow: '0 0 30px rgba(var(--accent-rgb), 0.15)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
              Shared
            </div>
            <div style={{
              fontSize: 12, color: 'var(--text-muted)', marginBottom: 16,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {pendingSharedDrop.files.length === 1 ? pendingSharedDrop.files[0].name : `${pendingSharedDrop.files.length} files`}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  const { files } = pendingSharedDrop;
                  setPendingSharedDrop(null);
                  Promise.all(files.map(f => copyFile(f.src, f.dest)))
                    .then(() => {
                      window.dispatchEvent(new CustomEvent('filetree-refresh'));
                      const msg = files.length === 1 ? `Copied ${files[0].name}` : `Copied ${files.length} files`;
                      import('react-hot-toast').then(m => m.default.success(msg));
                    })
                    .catch(() => {
                      import('react-hot-toast').then(m => m.default.error('Failed to copy'));
                    });
                }}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 10, fontSize: 13, fontWeight: 600,
                  cursor: 'pointer', transition: 'all 0.15s',
                  background: 'rgba(var(--accent-rgb), 0.12)',
                  border: '1px solid rgba(var(--accent-rgb), 0.3)',
                  color: 'var(--accent)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                Copy
              </button>
              <button
                type="button"
                onClick={() => {
                  const { files } = pendingSharedDrop;
                  setPendingSharedDrop(null);
                  Promise.all(files.map(f => renameFile(f.src, f.dest)))
                    .then(() => {
                      window.dispatchEvent(new CustomEvent('filetree-refresh'));
                      const msg = files.length === 1 ? `Moved ${files[0].name}` : `Moved ${files.length} files`;
                      import('react-hot-toast').then(m => m.default.success(msg));
                    })
                    .catch(() => {
                      import('react-hot-toast').then(m => m.default.error('Failed to move'));
                    });
                }}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 10, fontSize: 13, fontWeight: 600,
                  cursor: 'pointer', transition: 'all 0.15s',
                  background: 'rgba(255, 255, 255, 0.06)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: 'var(--text-secondary)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14" /><path d="M12 5l7 7-7 7" />
                </svg>
                Move
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Lock warning modal */}
      {showLockWarning && lockWarningSessionId && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          style={{ background: 'rgba(0, 0, 0, 0.7)', backdropFilter: 'blur(8px)' }}
          onClick={dismissLockWarning}
        >
          <div
            className="w-full max-w-sm rounded-3xl p-8"
            style={{
              background: 'rgba(10, 5, 20, 0.85)',
              border: '1px solid rgba(251, 191, 36, 0.2)',
              backdropFilter: 'blur(20px)',
              boxShadow: '0 0 40px rgba(251, 191, 36, 0.1)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-center mb-4">
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center"
                style={{ background: 'rgba(251, 191, 36, 0.1)', border: '1px solid rgba(251, 191, 36, 0.3)' }}
              >
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgb(251, 191, 36)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
            </div>

            <h2 className="text-lg font-bold mb-2 text-center" style={{ color: 'var(--text-primary)' }}>
              Workspace In Use
            </h2>
            <p className="text-sm mb-1 text-center" style={{ color: 'var(--text-secondary)' }}>
              This workspace is currently active on another device
            </p>
            {warningLockInfo && (
              <p className="text-xs mb-6 text-center" style={{ color: 'var(--text-muted)' }}>
                {warningLockInfo.device_type === 'phone' ? '\uD83D\uDCF1' : warningLockInfo.device_type === 'tablet' ? '\uD83D\uDCF1' : '\uD83D\uDCBB'}
                {' '}{warningLockInfo.device_type}
                {' \u2014 connected '}
                {new Date(warningLockInfo.connected_at).toLocaleTimeString()}
              </p>
            )}

            <div className="space-y-2">
              <button
                type="button"
                onClick={() => forceTakeover(lockWarningSessionId)}
                className="w-full py-3 rounded-xl text-sm font-bold transition-all"
                style={{
                  background: 'rgba(251, 191, 36, 0.15)',
                  border: '1px solid rgba(251, 191, 36, 0.3)',
                  color: 'rgb(251, 191, 36)',
                }}
              >
                Take Over Session
              </button>
              <button
                type="button"
                onClick={dismissLockWarning}
                className="w-full py-2.5 rounded-xl text-sm font-medium transition-all"
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  color: 'var(--text-secondary)',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

