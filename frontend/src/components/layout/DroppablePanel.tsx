import { useDraggable, useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { PanelId } from '../../store/layoutStore';
import { useLayoutStore } from '../../store/layoutStore';
import PanelContent, { panelIcons, panelTitles } from './PanelContent';

interface DroppablePanelProps {
  panelId: PanelId;
}

export default function DroppablePanel({ panelId }: DroppablePanelProps) {
  const { dnd, visibility, toggleVisibility } = useLayoutStore();

  // Draggable on the header
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    transform,
    isDragging,
  } = useDraggable({ id: panelId });

  // Droppable on the whole panel body
  const { isOver, setNodeRef: setDropRef } = useDroppable({ id: `panel-${panelId}` });

  const isHidden = !visibility[panelId];

  const dragStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    opacity: isDragging ? 0.3 : 1,
    transition: isDragging ? 'none' : 'opacity 0.2s ease',
  };

  // Chat panel doesn't have the drag header — it has its own sub-header inside PanelContent
  const showDragHeader = panelId !== 'chat';

  return (
    <div
      ref={setDropRef}
      className="droppable-panel h-full"
      style={{ position: 'relative' }}
    >
      <div ref={setDragRef} style={dragStyle} className="workspace-glass-panel h-full">
        <div className="workspace-glass-panel-shimmer" />
        <div className="workspace-glass-panel-content flex flex-col h-full">
          {/* Drag handle header for non-chat panels */}
          {showDragHeader && (
            <div
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
              <span className="panel-drag-icon">{panelIcons[panelId]}</span>
              <span className="panel-drag-title">{panelTitles[panelId]}</span>
              <button
                type="button"
                className="panel-close-btn"
                onClick={(e) => { e.stopPropagation(); toggleVisibility(panelId); }}
                title={isHidden ? `Show ${panelTitles[panelId]}` : `Hide ${panelTitles[panelId]}`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )}

          {/* Chat panel: the drag handle is embedded in PanelContent's sub-header */}
          {panelId === 'chat' && (
            <div
              className="panel-drag-header"
              style={{ padding: 0, background: 'none', borderBottom: 'none' }}
              {...listeners}
              {...attributes}
            >
              <div className="drag-grip" style={{ position: 'absolute', left: '4px', top: '50%', transform: 'translateY(-50%)', zIndex: 10 }}>
                <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" opacity="0.3">
                  <circle cx="2" cy="2" r="1.2" />
                  <circle cx="8" cy="2" r="1.2" />
                  <circle cx="2" cy="8" r="1.2" />
                  <circle cx="8" cy="8" r="1.2" />
                  <circle cx="2" cy="14" r="1.2" />
                  <circle cx="8" cy="14" r="1.2" />
                </svg>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-hidden">
            <PanelContent panelId={panelId} />
          </div>
        </div>
      </div>

      {/* Drop highlight overlay */}
      {isOver && dnd.isDragging && dnd.draggedPanelId !== panelId && (
        <div className="drop-zone-highlight" />
      )}
    </div>
  );
}
