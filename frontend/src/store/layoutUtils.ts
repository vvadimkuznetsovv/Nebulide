// Pure functions for layout tree manipulation

// Base panel types (one instance each)
export type BasePanelId = 'chat' | 'files' | 'editor' | 'preview' | 'terminal';
// Dynamic detached editors: 'editor:tab-123'
export type PanelId = BasePanelId | `editor:${string}`;

// --- Detached editor helpers ---
export function isDetachedEditor(panelId: string): panelId is `editor:${string}` {
  return panelId.startsWith('editor:');
}
export function getDetachedTabId(panelId: string): string | null {
  if (!isDetachedEditor(panelId)) return null;
  return panelId.slice('editor:'.length);
}
export function makeDetachedPanelId(tabId: string): PanelId {
  return `editor:${tabId}`;
}

// Insert a NEW panelId into the tree next to targetNodeId (without removing it from anywhere first).
// Used for detaching editor tabs which don't exist in the layout yet.
export function insertPanelAtNode(
  tree: LayoutNode,
  panelId: PanelId,
  targetNodeId: string,
  direction: 'top' | 'bottom' | 'left' | 'right',
): LayoutNode {
  const newPanel: PanelNode = {
    type: 'panel',
    id: generateNodeId('node'),
    panelIds: [panelId],
    activeIndex: 0,
  };
  const splitDirection: 'horizontal' | 'vertical' =
    direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
  const insertBefore = direction === 'left' || direction === 'top';
  return insertSplitAtNode(tree, targetNodeId, newPanel, splitDirection, insertBefore);
}

// Insert a NEW panelId at the edge of the tree (without removing from anywhere).
export function insertPanelAtEdge(
  tree: LayoutNode,
  panelId: PanelId,
  edge: 'left' | 'right' | 'top' | 'bottom',
): LayoutNode {
  const newPanel: PanelNode = {
    type: 'panel',
    id: generateNodeId('node'),
    panelIds: [panelId],
    activeIndex: 0,
  };

  if (edge === 'left' || edge === 'right') {
    if (tree.type === 'group' && tree.direction === 'horizontal') {
      const children = edge === 'left' ? [newPanel, ...tree.children] : [...tree.children, newPanel];
      const existingTotal = tree.sizes.reduce((a, b) => a + b, 0);
      const newSize = 25;
      const scale = (existingTotal - newSize) / existingTotal;
      const scaledSizes = tree.sizes.map((s) => Math.max(5, s * scale));
      const sizes = edge === 'left' ? [newSize, ...scaledSizes] : [...scaledSizes, newSize];
      return { ...tree, children, sizes };
    }
    const children = edge === 'left' ? [newPanel, tree] : [tree, newPanel];
    return { type: 'group', id: generateNodeId('group'), direction: 'horizontal', children, sizes: edge === 'left' ? [25, 75] : [75, 25] };
  }

  // top / bottom
  if (tree.type === 'group' && tree.direction === 'vertical') {
    const children = edge === 'top' ? [newPanel, ...tree.children] : [...tree.children, newPanel];
    const existingTotal = tree.sizes.reduce((a, b) => a + b, 0);
    const newSize = 25;
    const scale = (existingTotal - newSize) / existingTotal;
    const scaledSizes = tree.sizes.map((s) => Math.max(5, s * scale));
    const sizes = edge === 'top' ? [newSize, ...scaledSizes] : [...scaledSizes, newSize];
    return { ...tree, children, sizes };
  }
  const children = edge === 'top' ? [newPanel, tree] : [tree, newPanel];
  return { type: 'group', id: generateNodeId('group'), direction: 'vertical', children, sizes: edge === 'top' ? [25, 75] : [75, 25] };
}

// Insert a NEW panelId as a tab into an existing node (without removing from anywhere).
export function insertPanelIntoNode(
  tree: LayoutNode,
  panelId: PanelId,
  targetNodeId: string,
): LayoutNode {
  return addPanelToNodeById(tree, panelId, targetNodeId);
}

export interface PanelNode {
  type: 'panel';
  id: string;
  panelIds: PanelId[];
  activeIndex: number;
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
  sizes: [25, 50, 25],
  children: [
    { type: 'panel', id: 'node-chat', panelIds: ['chat'], activeIndex: 0 },
    {
      type: 'group',
      id: 'group-center',
      direction: 'vertical',
      sizes: [65, 35],
      children: [
        { type: 'panel', id: 'node-files', panelIds: ['files'], activeIndex: 0 },
        { type: 'panel', id: 'node-terminal', panelIds: ['terminal'], activeIndex: 0 },
      ],
    },
    {
      type: 'group',
      id: 'group-right',
      direction: 'vertical',
      sizes: [50, 50],
      children: [
        { type: 'panel', id: 'node-editor', panelIds: ['editor'], activeIndex: 0 },
        { type: 'panel', id: 'node-preview', panelIds: ['preview'], activeIndex: 0 },
      ],
    },
  ],
};

// Deep clone a layout tree
export function cloneTree(node: LayoutNode): LayoutNode {
  if (node.type === 'panel') {
    return { ...node, panelIds: [...node.panelIds] };
  }
  return {
    ...node,
    children: node.children.map(cloneTree),
    sizes: [...node.sizes],
  };
}

// Find a panel node containing a specific panelId
export function findPanelNode(
  tree: LayoutNode,
  panelId: PanelId,
): PanelNode | null {
  if (tree.type === 'panel') {
    return tree.panelIds.includes(panelId) ? tree : null;
  }
  for (const child of tree.children) {
    const found = findPanelNode(child, panelId);
    if (found) return found;
  }
  return null;
}

// Remove a single panelId from the tree.
// If the node has multiple panelIds, just removes from the array.
// If the node has only one panelId, removes the entire node (collapsing parents).
export function removePanelFromTree(tree: LayoutNode, panelId: PanelId): LayoutNode | null {
  if (tree.type === 'panel') {
    if (!tree.panelIds.includes(panelId)) return tree;
    if (tree.panelIds.length === 1) return null; // remove entire node
    // Remove from array, keep node
    const newPanelIds = tree.panelIds.filter((id) => id !== panelId);
    return {
      ...tree,
      panelIds: newPanelIds,
      activeIndex: Math.min(tree.activeIndex, newPanelIds.length - 1),
    };
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

// Merge panelId into the node with the given targetNodeId
export function mergePanelIntoNode(
  tree: LayoutNode,
  panelId: PanelId,
  targetNodeId: string,
): LayoutNode | null {
  // Remove panelId from its current location
  const treeWithout = removePanelFromTree(tree, panelId);
  if (!treeWithout) return null;

  // Add panelId to the target node
  return addPanelToNodeById(treeWithout, panelId, targetNodeId);
}

function addPanelToNodeById(
  tree: LayoutNode,
  panelId: PanelId,
  targetNodeId: string,
): LayoutNode {
  if (tree.type === 'panel') {
    if (tree.id === targetNodeId) {
      return {
        ...tree,
        panelIds: [...tree.panelIds, panelId],
        activeIndex: tree.panelIds.length, // new tab becomes active
      };
    }
    return tree;
  }
  return {
    ...tree,
    children: tree.children.map((child) =>
      addPanelToNodeById(child, panelId, targetNodeId),
    ),
  };
}

// Set active tab in a panel node by nodeId and panelId
export function setNodeActiveTab(
  tree: LayoutNode,
  nodeId: string,
  panelId: PanelId,
): LayoutNode {
  if (tree.type === 'panel') {
    if (tree.id === nodeId) {
      const idx = tree.panelIds.indexOf(panelId);
      if (idx >= 0) return { ...tree, activeIndex: idx };
    }
    return tree;
  }
  return {
    ...tree,
    children: tree.children.map((child) =>
      setNodeActiveTab(child, nodeId, panelId),
    ),
  };
}

// Split a panel node by placing the dragged panel next to the target node.
// direction: 'top'/'bottom' → vertical split, 'left'/'right' → horizontal split.
// 'center' → merge into tabs (use mergePanelIntoNode instead).
export function splitPanelAtNode(
  tree: LayoutNode,
  panelId: PanelId,
  targetNodeId: string,
  direction: 'top' | 'bottom' | 'left' | 'right',
): LayoutNode | null {
  // Remove panelId from current position
  const treeWithout = removePanelFromTree(tree, panelId);
  if (!treeWithout) return null;

  const newPanel: PanelNode = {
    type: 'panel',
    id: generateNodeId('node'),
    panelIds: [panelId],
    activeIndex: 0,
  };

  const splitDirection: 'horizontal' | 'vertical' =
    direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
  const insertBefore = direction === 'left' || direction === 'top';

  return insertSplitAtNode(treeWithout, targetNodeId, newPanel, splitDirection, insertBefore);
}

// Recursively find the target node and wrap it in a new group with the new panel
function insertSplitAtNode(
  tree: LayoutNode,
  targetNodeId: string,
  newPanel: PanelNode,
  direction: 'horizontal' | 'vertical',
  insertBefore: boolean,
): LayoutNode {
  if (tree.type === 'panel') {
    if (tree.id === targetNodeId) {
      const children = insertBefore ? [newPanel, tree] : [tree, newPanel];
      return {
        type: 'group',
        id: generateNodeId('group'),
        direction,
        children,
        sizes: [50, 50],
      };
    }
    return tree;
  }

  // Check if target is a direct child of this group with matching direction
  // In that case, insert alongside instead of creating a nested group
  const targetIdx = tree.children.findIndex((c) => c.id === targetNodeId);
  if (targetIdx >= 0 && tree.direction === direction) {
    const newChildren = [...tree.children];
    const newSizes = [...tree.sizes];
    const insertIdx = insertBefore ? targetIdx : targetIdx + 1;
    newChildren.splice(insertIdx, 0, newPanel);
    // Give new panel 25% and scale existing
    const existingTotal = newSizes.reduce((a, b) => a + b, 0);
    const newSize = 25;
    const scale = (existingTotal - newSize) / existingTotal;
    const scaledSizes = newSizes.map((s) => Math.max(5, s * scale));
    scaledSizes.splice(insertIdx, 0, newSize);
    return { ...tree, children: newChildren, sizes: scaledSizes };
  }

  // Recurse into children
  return {
    ...tree,
    children: tree.children.map((child) =>
      insertSplitAtNode(child, targetNodeId, newPanel, direction, insertBefore),
    ),
  };
}

// Add a column at the outermost edge (left or right)
export function addColumnAtEdge(
  tree: LayoutNode,
  panelId: PanelId,
  edge: 'left' | 'right',
): LayoutNode | null {
  // Remove the panel from its current position
  const treeWithout = removePanelFromTree(tree, panelId);
  if (!treeWithout) return null;

  const newPanel: PanelNode = {
    type: 'panel',
    id: generateNodeId('node'),
    panelIds: [panelId],
    activeIndex: 0,
  };

  // If root is already a horizontal group, add to it
  if (treeWithout.type === 'group' && treeWithout.direction === 'horizontal') {
    const children = edge === 'left'
      ? [newPanel, ...treeWithout.children]
      : [...treeWithout.children, newPanel];

    // Redistribute sizes for the new column
    const existingTotal = treeWithout.sizes.reduce((a, b) => a + b, 0);
    const newColumnSize = 25;
    const scale = (existingTotal - newColumnSize) / existingTotal;
    const scaledSizes = treeWithout.sizes.map((s) => Math.max(5, s * scale));
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

// Add a row at the outermost edge (top or bottom)
export function addRowAtEdge(
  tree: LayoutNode,
  panelId: PanelId,
  edge: 'top' | 'bottom',
): LayoutNode | null {
  const treeWithout = removePanelFromTree(tree, panelId);
  if (!treeWithout) return null;

  const newPanel: PanelNode = {
    type: 'panel',
    id: generateNodeId('node'),
    panelIds: [panelId],
    activeIndex: 0,
  };

  // If root is already a vertical group, add to it
  if (treeWithout.type === 'group' && treeWithout.direction === 'vertical') {
    const children = edge === 'top'
      ? [newPanel, ...treeWithout.children]
      : [...treeWithout.children, newPanel];

    const existingTotal = treeWithout.sizes.reduce((a, b) => a + b, 0);
    const newRowSize = 25;
    const scale = (existingTotal - newRowSize) / existingTotal;
    const scaledSizes = treeWithout.sizes.map((s) => Math.max(5, s * scale));
    const sizes = edge === 'top'
      ? [newRowSize, ...scaledSizes]
      : [...scaledSizes, newRowSize];

    return {
      ...treeWithout,
      children,
      sizes,
    };
  }

  // Wrap in a new vertical group
  const children = edge === 'top'
    ? [newPanel, treeWithout]
    : [treeWithout, newPanel];

  return {
    type: 'group',
    id: generateNodeId('group'),
    direction: 'vertical',
    children,
    sizes: edge === 'top' ? [25, 75] : [75, 25],
  };
}

// Get all panel IDs present in the tree
export function getAllPanelIds(tree: LayoutNode): PanelId[] {
  if (tree.type === 'panel') return [...tree.panelIds];
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
