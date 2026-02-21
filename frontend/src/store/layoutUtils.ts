// Pure functions for layout tree manipulation

export type PanelId = 'chat' | 'files' | 'editor' | 'terminal';

export interface PanelNode {
  type: 'panel';
  id: string;
  panelId: PanelId;
}

export interface GroupNode {
  type: 'group';
  id: string;
  direction: 'horizontal' | 'vertical';
  children: LayoutNode[];
  sizes: number[];
}

export type LayoutNode = PanelNode | GroupNode;

let nodeCounter = 0;
export function generateNodeId(prefix = 'node'): string {
  return `${prefix}-${++nodeCounter}-${Date.now().toString(36)}`;
}

export const DEFAULT_LAYOUT: LayoutNode = {
  type: 'group',
  id: 'root',
  direction: 'horizontal',
  sizes: [55, 45],
  children: [
    { type: 'panel', id: 'node-chat', panelId: 'chat' },
    {
      type: 'group',
      id: 'group-right',
      direction: 'vertical',
      sizes: [65, 35],
      children: [
        {
          type: 'group',
          id: 'group-right-top',
          direction: 'horizontal',
          sizes: [35, 65],
          children: [
            { type: 'panel', id: 'node-files', panelId: 'files' },
            { type: 'panel', id: 'node-editor', panelId: 'editor' },
          ],
        },
        { type: 'panel', id: 'node-terminal', panelId: 'terminal' },
      ],
    },
  ],
};

// Deep clone a layout tree
export function cloneTree(node: LayoutNode): LayoutNode {
  if (node.type === 'panel') {
    return { ...node };
  }
  return {
    ...node,
    children: node.children.map(cloneTree),
    sizes: [...node.sizes],
  };
}

// Find a panel node in the tree
export function findPanelNode(
  tree: LayoutNode,
  panelId: PanelId,
): PanelNode | null {
  if (tree.type === 'panel') {
    return tree.panelId === panelId ? tree : null;
  }
  for (const child of tree.children) {
    const found = findPanelNode(child, panelId);
    if (found) return found;
  }
  return null;
}

// Swap two panels' identities (structure stays the same)
export function swapPanelIds(tree: LayoutNode, panelA: PanelId, panelB: PanelId): LayoutNode {
  const result = cloneTree(tree);

  const nodeA = findPanelNode(result, panelA);
  const nodeB = findPanelNode(result, panelB);

  if (nodeA && nodeB) {
    nodeA.panelId = panelB;
    nodeB.panelId = panelA;
    // Swap ids too for consistency
    const tmpId = nodeA.id;
    nodeA.id = nodeB.id;
    nodeB.id = tmpId;
  }

  return result;
}

// Remove a panel from the tree, collapsing single-child groups
export function removePanelFromTree(tree: LayoutNode, panelId: PanelId): LayoutNode | null {
  if (tree.type === 'panel') {
    return tree.panelId === panelId ? null : tree;
  }

  const newChildren: LayoutNode[] = [];
  const newSizes: number[] = [];

  for (let i = 0; i < tree.children.length; i++) {
    const result = removePanelFromTree(tree.children[i], panelId);
    if (result) {
      newChildren.push(result);
      newSizes.push(tree.sizes[i]);
    }
  }

  if (newChildren.length === 0) return null;

  // Collapse single-child group
  if (newChildren.length === 1) {
    return newChildren[0];
  }

  // Redistribute sizes
  const total = newSizes.reduce((a, b) => a + b, 0);
  const normalizedSizes = newSizes.map((s) => (s / total) * 100);

  return {
    ...tree,
    children: newChildren,
    sizes: normalizedSizes,
  };
}

// Count top-level columns in the root horizontal group
export function countTopLevelColumns(tree: LayoutNode): number {
  if (tree.type === 'panel') return 1;
  if (tree.direction === 'horizontal') return tree.children.length;
  return 1;
}

// Add a column at the edge (left or right)
export function addColumnAtEdge(
  tree: LayoutNode,
  panelId: PanelId,
  edge: 'left' | 'right',
): LayoutNode | null {
  // Max 3 columns
  if (countTopLevelColumns(tree) >= 3) return null;

  // Remove the panel from its current position
  const treeWithout = removePanelFromTree(tree, panelId);
  if (!treeWithout) return null;

  const newPanel: PanelNode = {
    type: 'panel',
    id: generateNodeId('node'),
    panelId,
  };

  // If root is already a horizontal group, add to it
  if (treeWithout.type === 'group' && treeWithout.direction === 'horizontal') {
    const children = edge === 'left'
      ? [newPanel, ...treeWithout.children]
      : [...treeWithout.children, newPanel];

    // Redistribute sizes equally for the new column
    const existingTotal = treeWithout.sizes.reduce((a, b) => a + b, 0);
    const newColumnSize = 25; // 25% for new column
    const scale = (100 - newColumnSize) / existingTotal;
    const scaledSizes = treeWithout.sizes.map((s) => s * scale);
    const sizes = edge === 'left'
      ? [newColumnSize, ...scaledSizes]
      : [...scaledSizes, newColumnSize];

    return {
      ...treeWithout,
      children,
      sizes,
    };
  }

  // Wrap in a new horizontal group
  const children = edge === 'left'
    ? [newPanel, treeWithout]
    : [treeWithout, newPanel];

  return {
    type: 'group',
    id: generateNodeId('group'),
    direction: 'horizontal',
    children,
    sizes: edge === 'left' ? [25, 75] : [75, 25],
  };
}

// Get all panel IDs present in the tree
export function getAllPanelIds(tree: LayoutNode): PanelId[] {
  if (tree.type === 'panel') return [tree.panelId];
  return tree.children.flatMap(getAllPanelIds);
}

// Update sizes for a specific group node
export function updateGroupSizes(tree: LayoutNode, groupId: string, sizes: number[]): LayoutNode {
  if (tree.type === 'panel') return tree;

  if (tree.id === groupId) {
    return { ...tree, sizes };
  }

  return {
    ...tree,
    children: tree.children.map((child) => updateGroupSizes(child, groupId, sizes)),
  };
}
