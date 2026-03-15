import { useState, useCallback } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { PanelId, PanelNode } from '../../store/layoutStore';
import { useLayoutStore } from '../../store/layoutStore';
import { isDetachedEditor, getDetachedTabId, isDetachedTerminal, getDetachedTerminalId, findPanelNode } from '../../store/layoutUtils';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { useTerminalRegistryVersion, getTerminalCustomName, getTerminalLabel, setTerminalName } from '../../utils/terminalRegistry';
import { sendSyncMessage } from '../../utils/syncBridge';
import PanelContent, { getPanelIcon, getPanelTitle } from './PanelContent';
import { focusTerminal } from '../terminal/Terminal';
import ContextMenu from '../files/ContextMenu';
import { useLongPress, mergeEventHandlers } from '../../hooks/useLongPress';
import { useReorderHover, getTabShift } from '../../hooks/useTabReorder';

interface DroppablePanelProps {
  node: PanelNode;
  isFirst?: boolean;
}

// Feather-style SVG icons for context menu
const ICONS = {
  eyeOff: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ),
  cornerDownLeft: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </svg>
  ),
  splitPanel: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7" />
      <path d="M3 3h7v18H3a0 0 0 0 1 0 0V3z" />
    </svg>
  ),
  x: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  rotateCcw: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  ),
  edit2: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  ),
};

// --- Sidebar toggle button — shown in the first panel's tab bar ---
function SidebarToggleBtn() {
  const { sidebarOpen, setSidebarOpen } = useWorkspaceStore();
  return (
    <button
      type="button"
      className="global-panel-bar-sidebar-btn"
      onClick={() => setSidebarOpen(!sidebarOpen)}
      title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
      style={{
        color: sidebarOpen ? 'var(--accent-bright)' : undefined,
        background: sidebarOpen ? 'rgba(var(--accent-rgb), 0.15)' : undefined,
        flexShrink: 0,
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        {sidebarOpen ? (
          <>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </>
        ) : (
          <>
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </>
        )}
      </svg>
    </button>
  );
}

export default function DroppablePanel({ node, isFirst = false }: DroppablePanelProps) {
  const { dnd, visibility } = useLayoutStore();

  const activePanelId = node.panelIds[node.activeIndex];
  const visiblePanelIds = node.panelIds.filter((id) => visibility[id]);
  const isMultiTab = visiblePanelIds.length > 1;

  // Check if any tab in this node is currently being dragged
  const isAnyTabDragging = dnd.isDragging && dnd.draggedPanelId !== null && node.panelIds.includes(dnd.draggedPanelId);

  // Show directional drop zones when dragging:
  // - a panel from another node, OR
  // - a tab from THIS node (if node has multiple tabs — to split it out)
  // - an editor tab from FM (draggedEditorTabId)
  const isDraggingFromSelf = dnd.draggedPanelId !== null && node.panelIds.includes(dnd.draggedPanelId);
  const showDropZones = dnd.isDragging && (
    (dnd.draggedPanelId !== null && (!isDraggingFromSelf || node.panelIds.length > 1)) ||
    dnd.draggedEditorTabId !== null
  );

  return (
    <div
      className="droppable-panel h-full"
      style={{ position: 'relative' }}
    >
      <div
        className="workspace-glass-panel h-full"
        style={{
          opacity: isAnyTabDragging ? 0.3 : 1,
          transition: 'opacity 0.2s ease',
        }}
      >
        <div className="workspace-glass-panel-shimmer" />
        <div className="workspace-glass-panel-content flex flex-col h-full">
          {isMultiTab ? (
            <TabBar node={node} visiblePanelIds={visiblePanelIds} showSidebarBtn={isFirst} />
          ) : (
            <DragHeader panelId={visiblePanelIds[0] || activePanelId} nodeId={node.id} showSidebarBtn={isFirst} />
          )}

          {/* Render all visible tabs but hide inactive ones — keeps iframes (chat/preview)
              alive in the DOM so they don't reload on tab switch. */}
          <div className="flex-1 overflow-hidden" style={{ position: 'relative' }}>
            {visiblePanelIds.map((id) => {
              const isActive = id === (visiblePanelIds.includes(activePanelId) ? activePanelId : visiblePanelIds[0] || activePanelId);
              return (
                <div
                  key={id}
                  style={{
                    display: isActive ? 'flex' : 'none',
                    flexDirection: 'column',
                    width: '100%',
                    height: '100%',
                  }}
                >
                  <PanelContent panelId={id} />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* VS Code-style directional drop zones — appear only during drag */}
      {showDropZones && (
        <PanelDropZones nodeId={node.id} hideMerge={isDraggingFromSelf} />
      )}
    </div>
  );
}

// --- Context menu items builder ---
function getPanelMenuItems(panelId: PanelId, isMultiTab: boolean) {
  const isDetachedEd = isDetachedEditor(panelId);
  const isDetachedTerm = isDetachedTerminal(panelId);
  const title = getPanelTitle(panelId);

  if (isDetachedEd) {
    return [
      { label: 'Return to File Manager', action: 'reattach', icon: ICONS.cornerDownLeft },
      { type: 'separator' as const },
      { label: 'Close Tab', action: 'close-detached', icon: ICONS.x },
      { type: 'separator' as const },
      { label: 'Reset Layout', action: 'reset-layout', icon: ICONS.rotateCcw },
    ];
  }

  if (isDetachedTerm) {
    return [
      { label: 'Rename', action: 'rename-terminal', icon: ICONS.edit2 },
      { type: 'separator' as const },
      { label: 'Close Terminal', action: 'close-detached', icon: ICONS.x },
      { type: 'separator' as const },
      { label: 'Reset Layout', action: 'reset-layout', icon: ICONS.rotateCcw },
    ];
  }

  const items: { label?: string; action?: string; icon?: React.ReactNode; type?: 'separator' }[] = [];

  // "Open in Separate Panel" — only when this panel shares a tab group with others
  if (isMultiTab) {
    items.push({ label: 'Open in Separate Panel', action: 'split-out', icon: ICONS.splitPanel });
    items.push({ type: 'separator' as const });
  }

  // Rename for terminal panels
  if (panelId === 'terminal') {
    items.push({ label: 'Rename', action: 'rename-terminal', icon: ICONS.edit2 });
    items.push({ type: 'separator' as const });
  }

  items.push({ label: `Hide ${title}`, action: 'hide', icon: ICONS.eyeOff });
  items.push({ type: 'separator' as const });
  items.push({ label: 'Reset Layout', action: 'reset-layout', icon: ICONS.rotateCcw });

  return items;
}

function handlePanelMenuAction(
  action: string,
  panelId: PanelId,
  nodeId: string,
  fns: {
    toggleVisibility: (id: PanelId) => void;
    removeDetachedPanel: (id: PanelId) => void;
    reattachEditor: (id: PanelId) => void;
    splitPanel: (panelId: PanelId, targetNodeId: string, direction: 'top' | 'bottom' | 'left' | 'right') => void;
    resetLayout: () => void;
  },
) {
  switch (action) {
    case 'hide':
      fns.toggleVisibility(panelId);
      break;
    case 'split-out':
      fns.splitPanel(panelId, nodeId, 'right');
      break;
    case 'reattach':
      fns.reattachEditor(panelId);
      break;
    case 'close-detached': {
      const tabId = getDetachedTabId(panelId);
      if (tabId) {
        const info = useWorkspaceStore.getState().detachedEditors[tabId];
        if (info?.modified && !window.confirm('File has unsaved changes. Close anyway?')) return;
        useWorkspaceStore.getState().closeDetachedEditor(tabId);
      }
      fns.removeDetachedPanel(panelId);
      break;
    }
    case 'rename-terminal': {
      const instId = isDetachedTerminal(panelId)
        ? getDetachedTerminalId(panelId)
        : 'default';
      if (!instId) break;
      const currentName = getTerminalCustomName(instId) || getTerminalLabel(instId);
      const newName = window.prompt('Terminal name:', currentName);
      if (newName !== null) {
        setTerminalName(instId, newName);
        sendSyncMessage({ type: 'terminal_rename', instance_id: instId, name: newName.trim() });
      }
      break;
    }
    case 'reset-layout':
      fns.resetLayout();
      break;
  }
}

// --- 5 directional drop zones (top/bottom/left/right/center) ---
function PanelDropZones({ nodeId, hideMerge }: { nodeId: string; hideMerge?: boolean }) {
  return (
    <div className="panel-drop-overlay">
      <DropZone id={`split-top-${nodeId}`} position="top" />
      <DropZone id={`split-bottom-${nodeId}`} position="bottom" />
      <DropZone id={`split-left-${nodeId}`} position="left" />
      <DropZone id={`split-right-${nodeId}`} position="right" />
      {!hideMerge && <DropZone id={`merge-${nodeId}`} position="center" />}
    </div>
  );
}

function DropZone({ id, position }: { id: string; position: string }) {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`panel-drop-zone panel-drop-zone-${position} ${isOver ? 'active' : ''}`}
    />
  );
}

// --- Single panel: drag header ---
function DragHeader({ panelId, nodeId, showSidebarBtn }: { panelId: PanelId; nodeId: string; showSidebarBtn?: boolean }) {
  const { toggleVisibility, removeDetachedPanel, reattachEditor, splitPanel, resetLayout } = useLayoutStore();
  const { attributes, listeners, setNodeRef } = useDraggable({ id: panelId });
  useTerminalRegistryVersion(); // re-render when terminal numbering changes

  const title = getPanelTitle(panelId);
  const handleClose = () => {
    if (isDetachedEditor(panelId)) {
      const tabId = getDetachedTabId(panelId);
      if (tabId) {
        const info = useWorkspaceStore.getState().detachedEditors[tabId];
        if (info?.modified && !window.confirm('File has unsaved changes. Close anyway?')) return;
        useWorkspaceStore.getState().closeDetachedEditor(tabId);
      }
      removeDetachedPanel(panelId);
    } else {
      toggleVisibility(panelId);
    }
  };

  // Context menu
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
    handlePanelMenuAction(action, panelId, nodeId, { toggleVisibility, removeDetachedPanel, reattachEditor, splitPanel, resetLayout });
  }, [panelId, nodeId, toggleVisibility, removeDetachedPanel, reattachEditor, splitPanel, resetLayout]);

  // Merge touch handlers: long-press fires first, then dnd-kit listeners
  const mergedHandlers = mergeEventHandlers(longPressHandlers, listeners);

  return (
    <>
      <div
        ref={setNodeRef}
        className="panel-drag-header"
        onContextMenu={handleContextMenu}
        {...mergedHandlers}
        {...attributes}
        onClick={() => {
          if (longPressedRef.current) { longPressedRef.current = false; return; }
          // Focus terminal xterm when its header is clicked
          if (panelId === 'terminal') {
            setTimeout(() => focusTerminal('default'), 50);
          } else if (isDetachedTerminal(panelId)) {
            const instId = getDetachedTerminalId(panelId);
            if (instId) setTimeout(() => focusTerminal(instId), 50);
          }
        }}
      >
        {showSidebarBtn && <SidebarToggleBtn />}
        <div className="drag-grip">
          <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" opacity="0.3">
            <circle cx="2" cy="2" r="1.2" />
            <circle cx="8" cy="2" r="1.2" />
            <circle cx="2" cy="8" r="1.2" />
            <circle cx="8" cy="8" r="1.2" />
            <circle cx="2" cy="14" r="1.2" />
            <circle cx="8" cy="14" r="1.2" />
          </svg>
        </div>
        <span className="panel-drag-icon">{getPanelIcon(panelId)}</span>
        <span className="panel-drag-title">{title}</span>
        <button
          type="button"
          className="panel-close-btn"
          onClick={(e) => { e.stopPropagation(); handleClose(); }}
          title={(isDetachedEditor(panelId) || isDetachedTerminal(panelId)) ? `Close ${title}` : `Hide ${title}`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={getPanelMenuItems(panelId, false)}
          onAction={handleCtxAction}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </>
  );
}

// --- Multi panel: tab bar with draggable tabs ---
function TabBar({ node, visiblePanelIds, showSidebarBtn }: { node: PanelNode; visiblePanelIds: PanelId[]; showSidebarBtn?: boolean }) {
  const { setNodeActiveTab } = useLayoutStore();

  return (
    <div className="panel-tab-bar">
      {showSidebarBtn && <SidebarToggleBtn />}
      {visiblePanelIds.map((pid, index) => (
        <DraggableTab
          key={pid}
          panelId={pid}
          tabIndex={index}
          isActive={pid === node.panelIds[node.activeIndex]}
          onActivate={() => setNodeActiveTab(node.id, pid)}
          nodeId={node.id}
        />
      ))}
      <PanelTabEndZone nodeId={node.id} tabCount={visiblePanelIds.length} />
    </div>
  );
}

function DraggableTab({
  panelId,
  tabIndex,
  isActive,
  onActivate,
  nodeId,
}: {
  panelId: PanelId;
  tabIndex: number;
  isActive: boolean;
  onActivate: () => void;
  nodeId: string;
}) {
  const { toggleVisibility, removeDetachedPanel, reattachEditor, splitPanel, resetLayout } = useLayoutStore();
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({ id: panelId });

  // Make tab a drop target for reorder
  const { setNodeRef: setDropRef } = useDroppable({
    id: `tab-drop:panel:${nodeId}:${tabIndex}`,
    data: { type: 'panel-tab-slot', index: tabIndex, containerId: nodeId },
  });

  // Merge drag + drop refs
  const setNodeRef = useCallback((el: HTMLElement | null) => {
    setDragRef(el);
    setDropRef(el);
  }, [setDragRef, setDropRef]);

  // Animated gap shift
  const hover = useReorderHover();
  const layout = useLayoutStore.getState().layout;
  const panelNode = findPanelNode(layout, panelId);
  const draggedIndex = hover?.draggedId && panelNode
    ? panelNode.panelIds.indexOf(hover.draggedId as PanelId)
    : -1;
  const shift = getTabShift(hover, nodeId, tabIndex, draggedIndex);
  useTerminalRegistryVersion(); // re-render when terminal numbering changes

  const title = getPanelTitle(panelId);
  const handleClose = () => {
    if (isDetachedEditor(panelId)) {
      const tabId = getDetachedTabId(panelId);
      if (tabId) {
        const info = useWorkspaceStore.getState().detachedEditors[tabId];
        if (info?.modified && !window.confirm('File has unsaved changes. Close anyway?')) return;
        useWorkspaceStore.getState().closeDetachedEditor(tabId);
      }
      removeDetachedPanel(panelId);
    } else {
      toggleVisibility(panelId);
    }
  };

  // Context menu
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
    handlePanelMenuAction(action, panelId, nodeId, { toggleVisibility, removeDetachedPanel, reattachEditor, splitPanel, resetLayout });
  }, [panelId, nodeId, toggleVisibility, removeDetachedPanel, reattachEditor, splitPanel, resetLayout]);

  // Merge touch handlers: long-press fires first, then dnd-kit listeners
  const mergedHandlers = mergeEventHandlers(longPressHandlers, listeners);

  return (
    <>
      <div
        ref={setNodeRef}
        className={`panel-tab ${isActive ? 'active' : ''}${isDragging ? ' drag-source' : ''}`}
        style={{
          opacity: isDragging ? 0.3 : 1,
          transform: shift ? `translateX(${shift}px)` : undefined,
          transition: 'transform 200ms cubic-bezier(0.2, 0, 0, 1)',
        }}
        onClick={() => {
          if (longPressedRef.current) { longPressedRef.current = false; return; }
          onActivate();
          // Focus terminal xterm when its tab is clicked
          if (panelId === 'terminal') {
            setTimeout(() => focusTerminal('default'), 50);
          } else if (isDetachedTerminal(panelId)) {
            const instId = getDetachedTerminalId(panelId);
            if (instId) setTimeout(() => focusTerminal(instId), 50);
          }
        }}
        onContextMenu={handleContextMenu}
        {...mergedHandlers}
        {...attributes}
      >
        <span className="panel-tab-icon">{getPanelIcon(panelId)}</span>
        <span className="panel-tab-title">{title}</span>
        <button
          type="button"
          className={`panel-tab-close${isActive ? '' : ' panel-tab-close-compact'}`}
          onClick={(e) => { e.stopPropagation(); handleClose(); }}
          title={(isDetachedEditor(panelId) || isDetachedTerminal(panelId)) ? `Close ${title}` : `Hide ${title}`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={getPanelMenuItems(panelId, true)}
          onAction={handleCtxAction}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </>
  );
}

/** Drop zone after the last panel tab — for appending */
function PanelTabEndZone({ nodeId, tabCount }: { nodeId: string; tabCount: number }) {
  const { setNodeRef } = useDroppable({
    id: `tab-drop:panel:${nodeId}:${tabCount}`,
    data: { type: 'panel-tab-slot', index: tabCount, containerId: nodeId },
  });
  return <div ref={setNodeRef} style={{ flex: '1 1 0', minWidth: 20, minHeight: '100%' }} />;
}
