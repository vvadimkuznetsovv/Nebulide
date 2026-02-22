import { useCallback, useState } from 'react';
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
} from '@dnd-kit/core';
import { useAuth } from '../hooks/useAuth';
import { useLayoutStore, type PanelId } from '../store/layoutStore';
import { findPanelNode, isDetachedEditor } from '../store/layoutUtils';
import { useWorkspaceStore } from '../store/workspaceStore';
import Sidebar from '../components/layout/Sidebar';
import LayoutRenderer from '../components/layout/LayoutRenderer';
import EdgeDropZone from '../components/layout/EdgeDropZone';
import { panelIcons, getPanelIcon, getPanelTitle } from '../components/layout/PanelContent';

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

  // Check if any panel is visible (to show fallback sidebar toggle)
  const anyPanelVisible = Object.entries(visibility).some(([, v]) => v);

  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  // DnD sensors — unified for all screen sizes
  const mouseSensor = useSensor(MouseSensor, { activationConstraint: { distance: 8 } });
  const touchSensor = useSensor(TouchSensor, { activationConstraint: { distance: 10 } });
  const sensors = useSensors(mouseSensor, touchSensor);

  // DnD handlers
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const dragId = String(event.active.id);
    setActiveDragId(dragId);

    // Editor tab drag from File Manager
    if (dragId.startsWith('editor-tab:')) {
      setDraggingEditorTab(dragId.slice('editor-tab:'.length));
    } else {
      setDragging(dragId as PanelId);
    }
  }, [setDragging, setDraggingEditorTab]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragId(null);
    setDragging(null);

    const { active, over } = event;
    if (!over) return;

    const dragId = String(active.id);
    const targetId = String(over.id);

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
      {/* === Lava lamp background === */}
      <svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style={{ position: 'absolute', overflow: 'hidden' }}>
        <defs>
          <filter id="glass-distortion" x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.006 0.006" numOctaves="3" seed="42" result="noise" />
            <feGaussianBlur in="noise" stdDeviation="2.5" result="blurred" />
            <feDisplacementMap in="SourceGraphic" in2="blurred" scale="120" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>

      <div className="lava-lamp">
        <div className="lava-blob lava-blob-1" />
        <div className="lava-blob lava-blob-2" />
        <div className="lava-blob lava-blob-3" />
        <div className="lava-blob lava-blob-4" />
        <div className="lava-blob lava-blob-5" />
        <div className="lava-blob lava-blob-6" />
        <div className="lava-blob lava-blob-7" />
        <div className="lava-blob lava-blob-8" />
        <div className="lava-glow" />
      </div>

      {/* === UNIFIED LAYOUT — same on mobile and desktop === */}
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel}>
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
    </div>
  );
}

