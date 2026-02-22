import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { PanelId, PanelNode } from '../../store/layoutStore';
import { useLayoutStore } from '../../store/layoutStore';
import { isDetachedEditor } from '../../store/layoutUtils';
import PanelContent, { getPanelIcon, getPanelTitle } from './PanelContent';

interface DroppablePanelProps {
  node: PanelNode;
}

export default function DroppablePanel({ node }: DroppablePanelProps) {
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
            <TabBar node={node} visiblePanelIds={visiblePanelIds} />
          ) : (
            <DragHeader panelId={visiblePanelIds[0] || activePanelId} />
          )}

          <div className="flex-1 overflow-hidden">
            <PanelContent panelId={visiblePanelIds.includes(activePanelId) ? activePanelId : visiblePanelIds[0] || activePanelId} />
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

// --- Single panel: drag header (same for ALL panels including Chat) ---
function DragHeader({ panelId }: { panelId: PanelId }) {
  const { toggleVisibility, reattachEditor } = useLayoutStore();
  const { attributes, listeners, setNodeRef } = useDraggable({ id: panelId });

  const title = getPanelTitle(panelId);
  const handleClose = () => {
    if (isDetachedEditor(panelId)) {
      reattachEditor(panelId);
    } else {
      toggleVisibility(panelId);
    }
  };

  return (
    <div
      ref={setNodeRef}
      className="panel-drag-header"
      {...listeners}
      {...attributes}
    >
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
        title={isDetachedEditor(panelId) ? `Return ${title} to File Manager` : `Hide ${title}`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

// --- Multi panel: tab bar with draggable tabs ---
function TabBar({ node, visiblePanelIds }: { node: PanelNode; visiblePanelIds: PanelId[] }) {
  const { setNodeActiveTab } = useLayoutStore();

  return (
    <div className="panel-tab-bar">
      {visiblePanelIds.map((pid) => (
        <DraggableTab
          key={pid}
          panelId={pid}
          isActive={pid === node.panelIds[node.activeIndex]}
          onActivate={() => setNodeActiveTab(node.id, pid)}
        />
      ))}
    </div>
  );
}

function DraggableTab({
  panelId,
  isActive,
  onActivate,
}: {
  panelId: PanelId;
  isActive: boolean;
  onActivate: () => void;
}) {
  const { toggleVisibility, reattachEditor } = useLayoutStore();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: panelId });

  const title = getPanelTitle(panelId);
  const handleClose = () => {
    if (isDetachedEditor(panelId)) {
      reattachEditor(panelId);
    } else {
      toggleVisibility(panelId);
    }
  };

  return (
    <div
      ref={setNodeRef}
      className={`panel-tab ${isActive ? 'active' : ''}`}
      style={{ opacity: isDragging ? 0.3 : 1 }}
      onClick={onActivate}
      {...listeners}
      {...attributes}
    >
      <span className="panel-tab-icon">{getPanelIcon(panelId)}</span>
      <span className="panel-tab-title">{title}</span>
      <button
        type="button"
        className={`panel-tab-close${isActive ? '' : ' panel-tab-close-compact'}`}
        onClick={(e) => { e.stopPropagation(); handleClose(); }}
        title={isDetachedEditor(panelId) ? `Return ${title} to File Manager` : `Hide ${title}`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
