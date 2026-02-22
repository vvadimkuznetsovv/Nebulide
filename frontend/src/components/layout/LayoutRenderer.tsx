import { Panel, Group } from 'react-resizable-panels';
import type { LayoutNode } from '../../store/layoutUtils';
import { useLayoutStore } from '../../store/layoutStore';
import DroppablePanel from './DroppablePanel';
import ResizeHandle from './ResizeHandle';

interface LayoutRendererProps {
  node: LayoutNode;
}

export default function LayoutRenderer({ node }: LayoutRendererProps) {
  const { visibility, updateSizes } = useLayoutStore();

  if (node.type === 'panel') {
    // Check if any panelId in this node is visible
    const hasVisible = node.panelIds.some((id) => visibility[id]);
    if (!hasVisible) return null;
    return <DroppablePanel node={node} />;
  }

  // GroupNode — render Group with children
  const orientation = node.direction;

  // Filter out hidden panels and track which children are visible
  const visibleChildren: { child: LayoutNode; index: number }[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type === 'panel' && !child.panelIds.some((id) => visibility[id])) continue;
    // For groups, check if any descendant panel is visible
    if (child.type === 'group' && !hasVisiblePanel(child, visibility)) continue;
    visibleChildren.push({ child, index: i });
  }

  if (visibleChildren.length === 0) return null;

  // If only one visible child, render it directly without Group wrapper
  if (visibleChildren.length === 1) {
    return <LayoutRenderer node={visibleChildren[0].child} />;
  }

  // Calculate default sizes for visible children (redistribute proportionally)
  const visibleSizes = visibleChildren.map((vc) => node.sizes[vc.index]);
  const total = visibleSizes.reduce((a, b) => a + b, 0);
  const normalizedSizes = visibleSizes.map((s) => (s / total) * 100);

  // Build defaultLayout as { id: percentage } object
  const defaultLayout: Record<string, number> = {};
  for (let i = 0; i < visibleChildren.length; i++) {
    const child = visibleChildren[i].child;
    defaultLayout[child.id] = normalizedSizes[i];
  }

  const handleLayoutChanged = (layout: Record<string, number>) => {
    const newSizes = [...node.sizes];
    for (let i = 0; i < visibleChildren.length; i++) {
      const child = visibleChildren[i].child;
      if (child.id in layout) {
        newSizes[visibleChildren[i].index] = layout[child.id];
      }
    }
    updateSizes(node.id, newSizes);
  };

  return (
    <Group
      key={visibleChildren.map((vc) => vc.child.id).join(',')}
      orientation={orientation}
      id={node.id}
      defaultLayout={defaultLayout}
      onLayoutChanged={handleLayoutChanged}
    >
      {visibleChildren.map((vc, idx) => (
        <PanelWithResize
          key={vc.child.id}
          child={vc.child}
          defaultSize={normalizedSizes[idx]}
          direction={orientation}
          isLast={idx === visibleChildren.length - 1}
        />
      ))}
    </Group>
  );
}

// Helper to render a Panel + optional Separator after it
function PanelWithResize({
  child,
  defaultSize,
  direction,
  isLast,
}: {
  child: LayoutNode;
  defaultSize: number;
  direction: 'horizontal' | 'vertical';
  isLast: boolean;
}) {
  return (
    <>
      <Panel
        defaultSize={`${defaultSize}%`}
        minSize="5%"
        id={child.id}
      >
        <LayoutRenderer node={child} />
      </Panel>
      {!isLast && (
        <ResizeHandle direction={direction} />
      )}
    </>
  );
}

// Check if a group has any visible descendant panel
function hasVisiblePanel(
  node: LayoutNode,
  visibility: Record<string, boolean>,
): boolean {
  if (node.type === 'panel') return node.panelIds.some((id) => visibility[id] ?? true);
  return node.children.some((child) => hasVisiblePanel(child, visibility));
}
