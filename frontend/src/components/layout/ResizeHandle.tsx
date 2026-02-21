import { Separator } from 'react-resizable-panels';

interface ResizeHandleProps {
  direction?: 'horizontal' | 'vertical';
}

export default function ResizeHandle({ direction = 'horizontal' }: ResizeHandleProps) {
  const isVertical = direction === 'vertical';

  return (
    <Separator
      className={`resize-handle ${isVertical ? 'resize-handle-vertical' : 'resize-handle-horizontal'}`}
    >
      <div className="resize-handle-line" />
    </Separator>
  );
}
