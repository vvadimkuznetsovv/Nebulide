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
    const isVisible = visibility[node.panelId];
    if (!isVisible) return null;
    return <DroppablePanel panelId={node.panelId} />;
  }

  // GroupNode — render Group with children
  const orientation = node.direction;

  // Filter out hidden panels and track which children are visible
  const visibleChildren: { child: LayoutNode; index: number }[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type === 'panel' && !visibility[child.panelId]) continue;
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

  // Build defaultLayout as { panelId: percentage } object
  const defaultLayout: Record<string, number> = {};
  for (let i = 0; i < visibleChildren.length; i++) {
    const child = visibleChildren[i].child;
    const panelKey = child.type === 'panel' ? child.panelId : child.id;
    defaultLayout[panelKey] = normalizedSizes[i];
  }

  const handleLayoutChanged = (layout: Record<string, number>) => {
    // Map the layout object back to sizes array for the full node
    const newSizes = [...node.sizes];
    for (let i = 0; i < visibleChildren.length; i++) {
      const child = visibleChildren[i].child;
      const panelKey = child.type === 'panel' ? child.panelId : child.id;
      if (panelKey in layout) {
        newSizes[visibleChildren[i].index] = layout[panelKey];
      }
    }
    updateSizes(node.id, newSizes);
  };

  return (
    <Group
      orientation={orientation}
      id={node.id}
      defaultLayout={defaultLayout}
      onLayoutChanged={handleLayoutChanged}
    >
      {visibleChildren.map((vc, idx) => (
        <PanelWithResize
          key={vc.child.type === 'panel' ? vc.child.panelId : vc.child.id}
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
  const panelId = child.type === 'panel' ? child.panelId : child.id;

  return (
    <>
      <Panel
        defaultSize={`${defaultSize}%`}
        minSize="5%"
        id={panelId}
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
  if (node.type === 'panel') return visibility[node.panelId] ?? true;
  return node.children.some((child) => hasVisiblePanel(child, visibility));
}
