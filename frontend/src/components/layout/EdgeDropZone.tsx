import { useDroppable } from '@dnd-kit/core';
import { useLayoutStore } from '../../store/layoutStore';

interface EdgeDropZoneProps {
  edge: 'left' | 'right';
}

export default function EdgeDropZone({ edge }: EdgeDropZoneProps) {
  const { dnd } = useLayoutStore();
  const { isOver, setNodeRef } = useDroppable({ id: `edge-${edge}` });

  if (!dnd.isDragging) return null;

  return (
    <div
      ref={setNodeRef}
      className={`edge-drop-zone edge-drop-zone-${edge} ${isOver ? 'active' : ''}`}
    />
  );
}
