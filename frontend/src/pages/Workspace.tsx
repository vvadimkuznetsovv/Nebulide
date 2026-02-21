import { useCallback, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { useAuth } from '../hooks/useAuth';
import { useLayoutStore, type PanelId } from '../store/layoutStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import Sidebar from '../components/layout/Sidebar';
import LayoutRenderer from '../components/layout/LayoutRenderer';
import EdgeDropZone from '../components/layout/EdgeDropZone';
import PanelContent, { panelIcons, panelTitles } from '../components/layout/PanelContent';
import type { ChatSession } from '../api/sessions';

export default function Workspace() {
  useAuth();

  const {
    layout,
    visibility,
    dnd,
    mobilePanels,
    swapPanels,
    movePanelToEdge,
    setDragging,
    openMobilePanel,
    closeMobilePanel,
  } = useLayoutStore();

  const {
    activeSession,
    sidebarOpen,
    setActiveSession,
    setSidebarOpen,
  } = useWorkspaceStore();

  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  // DnD sensors — pointer with 8px activation distance, touch with 250ms delay
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 8 } });
  const touchSensor = useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } });
  const sensors = useSensors(pointerSensor, touchSensor);

  // Desktop DnD handlers
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const panelId = String(event.active.id) as PanelId;
    setActiveDragId(panelId);
    setDragging(panelId);
  }, [setDragging]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragId(null);
    setDragging(null);

    const { active, over } = event;
    if (!over) return;

    const draggedPanelId = String(active.id) as PanelId;
    const targetId = String(over.id);

    // Edge drop — create new column
    if (targetId === 'edge-left') {
      movePanelToEdge(draggedPanelId, 'left');
      return;
    }
    if (targetId === 'edge-right') {
      movePanelToEdge(draggedPanelId, 'right');
      return;
    }

    // Panel drop — swap panels
    if (targetId.startsWith('panel-')) {
      const targetPanelId = targetId.replace('panel-', '') as PanelId;
      if (targetPanelId !== draggedPanelId) {
        swapPanels(draggedPanelId, targetPanelId);
      }
    }
  }, [swapPanels, movePanelToEdge, setDragging]);

  // Mobile DnD handlers
  const handleMobileDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  }, []);

  const handleMobileDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;

    const panelId = String(active.id).replace('mobile-tab-', '') as PanelId;
    const dropZone = String(over.id);

    if (dropZone === 'mobile-drop-top') {
      openMobilePanel(panelId, 'top');
    } else if (dropZone === 'mobile-drop-bottom') {
      openMobilePanel(panelId, 'bottom');
    }
  }, [openMobilePanel]);

  // Which panels are not currently in mobilePanels (available as tabs)
  const allPanels: PanelId[] = ['chat', 'files', 'editor', 'terminal'];
  const mobileTabs = allPanels.filter((p) => !mobilePanels.includes(p));

  return (
    <div className="h-dvh relative overflow-hidden">
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

      {/* === DESKTOP LAYOUT === */}
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="hidden lg:flex h-full relative z-10 p-4 gap-0">
          {/* Edge drop zone — left */}
          <EdgeDropZone edge="left" />

          {/* Sidebar */}
          <div
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
                  activeSessionId={activeSession?.id || null}
                  onSelectSession={setActiveSession as (s: ChatSession | null) => void}
                  isOpen={true}
                  onClose={() => setSidebarOpen(false)}
                />
              </div>
            </div>
          </div>

          {/* Main layout area — recursive renderer */}
          <div className="flex-1 min-w-0 h-full">
            <LayoutRenderer node={layout} />
          </div>

          {/* Edge drop zone — right */}
          <EdgeDropZone edge="right" />
        </div>

        {/* Desktop DragOverlay */}
        <DragOverlay>
          {activeDragId && !activeDragId.startsWith('mobile-tab-') && (
            <div className="drag-overlay-panel">
              <div className="flex items-center gap-2 px-3 py-2">
                {panelIcons[activeDragId as PanelId]}
                <span className="text-xs font-semibold" style={{ color: 'rgba(255,255,255,0.8)' }}>
                  {panelTitles[activeDragId as PanelId]}
                </span>
              </div>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {/* === MOBILE LAYOUT === */}
      <DndContext sensors={sensors} onDragStart={handleMobileDragStart} onDragEnd={handleMobileDragEnd}>
        <div className="flex lg:hidden flex-col h-full relative z-10">
          {/* Panels area */}
          <div className="flex-1 overflow-hidden p-2 flex flex-col gap-2">
            {/* Drop zone: top (visible only when dragging) */}
            {activeDragId?.startsWith('mobile-tab-') && (
              <MobileDropZone id="mobile-drop-top" label="Drop here — top" />
            )}

            {/* Render open panels */}
            {mobilePanels.map((panelId) => (
              <div
                key={panelId}
                className="workspace-glass-panel overflow-hidden"
                style={{ flex: '1 1 0%', minHeight: 0 }}
              >
                <div className="workspace-glass-panel-shimmer" />
                <div className="workspace-glass-panel-content flex flex-col h-full">
                  {/* Panel header with close button (if more than 1 panel) */}
                  <div className="mobile-panel-header">
                    <span className="flex items-center gap-2">
                      {panelIcons[panelId]}
                      <span className="text-xs font-semibold" style={{ color: 'rgba(255,255,255,0.7)' }}>
                        {panelTitles[panelId]}
                      </span>
                    </span>
                    <div className="flex items-center gap-1">
                      {panelId === 'chat' && (
                        <button
                          type="button"
                          onClick={() => setSidebarOpen(true)}
                          className="mobile-panel-header-btn"
                          title="Sessions"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <line x1="3" y1="6" x2="21" y2="6" />
                            <line x1="3" y1="12" x2="21" y2="12" />
                            <line x1="3" y1="18" x2="21" y2="18" />
                          </svg>
                        </button>
                      )}
                      {mobilePanels.length > 1 && (
                        <button
                          type="button"
                          onClick={() => closeMobilePanel(panelId)}
                          className="mobile-panel-header-btn"
                          title="Close panel"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <PanelContent panelId={panelId} />
                  </div>
                </div>
              </div>
            ))}

            {/* Drop zone: bottom (visible only when dragging) */}
            {activeDragId?.startsWith('mobile-tab-') && (
              <MobileDropZone id="mobile-drop-bottom" label="Drop here — bottom" />
            )}
          </div>

          {/* Mobile tab bar — draggable tabs for panels not currently open */}
          {mobileTabs.length > 0 && (
            <div className="mobile-tab-bar">
              {mobileTabs.map((panelId) => (
                <MobileDraggableTab
                  key={panelId}
                  panelId={panelId}
                  icon={panelIcons[panelId]}
                  title={panelTitles[panelId]}
                  onTap={() => openMobilePanel(panelId, 'bottom')}
                />
              ))}
            </div>
          )}

          {/* Mobile sidebar overlay */}
          <Sidebar
            activeSessionId={activeSession?.id || null}
            onSelectSession={setActiveSession as (s: ChatSession | null) => void}
            isOpen={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
          />
        </div>

        {/* Mobile DragOverlay */}
        <DragOverlay>
          {activeDragId?.startsWith('mobile-tab-') && (
            <div className="mobile-tab-overlay">
              {panelIcons[activeDragId.replace('mobile-tab-', '') as PanelId]}
              <span>{panelTitles[activeDragId.replace('mobile-tab-', '') as PanelId]}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

// === Mobile helper components ===

function MobileDropZone({ id, label }: { id: string; label: string }) {
  const { isOver, setNodeRef } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={`mobile-drop-zone ${isOver ? 'active' : ''}`}
    >
      <span>{label}</span>
    </div>
  );
}

function MobileDraggableTab({
  panelId,
  icon,
  title,
  onTap,
}: {
  panelId: PanelId;
  icon: React.ReactNode;
  title: string;
  onTap: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `mobile-tab-${panelId}`,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <button
      ref={setNodeRef}
      type="button"
      className="mobile-tab-pill"
      style={style}
      onClick={() => {
        if (!isDragging) onTap();
      }}
      {...listeners}
      {...attributes}
    >
      {icon}
      <span>{title}</span>
    </button>
  );
}
