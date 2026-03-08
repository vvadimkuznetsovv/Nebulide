import { useCallback, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  pointerWithin,
  type DragStartEvent,
  type DragEndEvent,
  type Modifier,
  type CollisionDetection,
} from '@dnd-kit/core';
import { useAuth } from '../hooks/useAuth';
import { renameFile } from '../api/files';
import { useLayoutStore, type PanelId } from '../store/layoutStore';
import { findPanelNode, isDetachedEditor } from '../store/layoutUtils';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useWorkspaceSessionStore } from '../store/workspaceSessionStore';
import { useSyncWS } from '../hooks/useSyncWS';
import LavaLamp from '../components/LavaLamp';
import Sidebar from '../components/layout/Sidebar';
import LayoutRenderer from '../components/layout/LayoutRenderer';
import EdgeDropZone from '../components/layout/EdgeDropZone';
import { panelIcons, getPanelIcon, getPanelTitle } from '../components/layout/PanelContent';

// Custom collision detection: when dragging file tree items, prioritize
// file tree drop targets (folder:/filezone:) over large panel zones (merge-/split-).
// pointerWithin sorts by intersection ratio ascending — large panel zones have
// smaller ratios and win over small file tree items. We override this for file drags.
const fileTreeAwareCollision: CollisionDetection = (args) => {
  const collisions = pointerWithin(args);
  const dragId = args.active?.id ? String(args.active.id) : '';
  if (dragId.startsWith('file:')) {
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

  // Initialize workspace sessions on mount + auto-save periodically
  const initSession = useWorkspaceSessionStore((s) => s.initSession);
  const saveCurrentSession = useWorkspaceSessionStore((s) => s.saveCurrentSession);

  useEffect(() => {
    initSession();
  }, [initSession]);

  // Enhanced auto-save: debounced 2s on state changes + 30s safety + beforeunload
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    const debouncedSave = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        saveCurrentSession();
        debounceRef.current = null;
      }, 2000);
    };

    const unsubLayout = useLayoutStore.subscribe(debouncedSave);
    const unsubWorkspace = useWorkspaceStore.subscribe(debouncedSave);
    const safetyInterval = setInterval(saveCurrentSession, 30_000);

    const handleBeforeUnload = () => {
      // Use fetch with keepalive for reliability on tab close
      const activeId = useWorkspaceSessionStore.getState().activeSessionId;
      if (!activeId) return;
      const workspaceSnap = useWorkspaceStore.getState().getWorkspaceSnapshot();
      const layoutSnap = useLayoutStore.getState().getLayoutSnapshot();
      const token = localStorage.getItem('access_token');
      fetch(`/api/workspace-sessions/${activeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
        body: JSON.stringify({ snapshot: { workspace: workspaceSnap, layout: layoutSnap } }),
        keepalive: true,
      });
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      unsubLayout();
      unsubWorkspace();
      clearInterval(safetyInterval);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [saveCurrentSession]);

  // Global Ctrl+Shift+C copy (capture phase, respects Developer Mode)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.key !== 'C') return;
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

  const mouseSensor = useSensor(MouseSensor, { activationConstraint: { distance: 8 } });
  const touchSensor = useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } });
  const sensors = useSensors(mouseSensor, touchSensor);

  // DnD handlers
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const dragId = String(event.active.id);
    setActiveDragId(dragId);

    // File tree DnD — don't set panel dragging state
    if (dragId.startsWith('file:')) return;

    // Editor tab drag from File Manager
    if (dragId.startsWith('editor-tab:')) {
      setDraggingEditorTab(dragId.slice('editor-tab:'.length));
    } else {
      setDragging(dragId as PanelId);
    }
  }, [setDragging, setDraggingEditorTab]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const dragId = String(event.active.id);
    setActiveDragId(null);
    setDragging(null);

    const { over } = event;
    // Debug: log file tree drops to diagnose missing drop targets
    if (dragId.startsWith('file:')) {
      console.debug('[DnD drop]', { dragId, over: over ? String(over.id) : null });
    }
    if (!over) return;
    const targetId = String(over.id);

    // === File tree DnD: move file/folder into target folder ===
    if (dragId.startsWith('file:') && (targetId.startsWith('folder:') || targetId.startsWith('filezone:'))) {
      const srcPath = dragId.slice('file:'.length);
      // folder: → drop into that folder; filezone: → drop into file's parent folder
      let destFolder: string;
      if (targetId.startsWith('folder:')) {
        destFolder = targetId.slice('folder:'.length);
      } else {
        const filePath = targetId.slice('filezone:'.length);
        destFolder = filePath.split(/[/\\]/).slice(0, -1).join('/');
      }
      const fileName = srcPath.split(/[/\\]/).pop() || '';
      const destPath = destFolder.replace(/\\/g, '/') + '/' + fileName;
      const normSrc = srcPath.replace(/\\/g, '/');
      const srcParent = normSrc.split('/').slice(0, -1).join('/');
      // Don't move onto itself, into same parent, or into own subtree
      if (normSrc === destPath || srcParent === destFolder.replace(/\\/g, '/') || normSrc.startsWith(destFolder.replace(/\\/g, '/') + '/')) return;
      renameFile(srcPath, destPath)
        .then(() => {
          window.dispatchEvent(new CustomEvent('filetree-refresh'));
          import('react-hot-toast').then(m => m.default.success(`Moved ${fileName}`));
        })
        .catch(() => {
          import('react-hot-toast').then(m => m.default.error('Failed to move file'));
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
  }, [layout, mergePanels, splitPanel, movePanelToEdge, setDragging, detachEditorTabToSplit, detachEditorTabToEdge, detachEditorTabToMerge, reattachEditor]);

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
    setDragging(null);
  }, [setDragging]);

  // Get drag overlay content
  const getDragOverlayContent = () => {
    if (!activeDragId) return null;

    // File tree item
    if (activeDragId.startsWith('file:')) {
      const filePath = activeDragId.slice('file:'.length);
      const fileName = filePath.split(/[/\\]/).pop() || 'File';
      return (
        <div className="drag-overlay-panel">
          <div className="flex items-center gap-2 px-3 py-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span className="text-xs font-semibold" style={{ color: 'rgba(255,255,255,0.8)' }}>
              {fileName}
            </span>
          </div>
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
      <DndContext sensors={sensors} collisionDetection={fileTreeAwareCollision} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel}>
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

