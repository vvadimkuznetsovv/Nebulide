import { create } from 'zustand';
import {
  type PanelId,
  type LayoutNode,
  DEFAULT_LAYOUT,
  mergePanelIntoNode,
  setNodeActiveTab,
  splitPanelAtNode,
  addColumnAtEdge,
  addRowAtEdge,
  updateGroupSizes,
  cloneTree,
  isDetachedEditor,
  makeDetachedPanelId,
  isDetachedTerminal,
  getDetachedTerminalId,
  makeDetachedTerminalPanelId,
  findPanelNode,
  removePanelFromTree,
  insertPanelAtNode,
  insertPanelAtEdge,
  insertPanelIntoNode,
  getAllPanelIds,
  remapPanelIds,
  remapVisibility,
} from './layoutUtils';
import { useWorkspaceStore } from './workspaceStore';
import { destroyTerminalSession, getActiveTerminalInstanceIds } from '../components/terminal/Terminal';
import { registerTerminal, resetTerminalRegistry, getRegistrySnapshot, restoreRegistryFromSnapshot } from '../utils/terminalRegistry';

export type { PanelId };
export type { LayoutNode, PanelNode, GroupNode } from './layoutUtils';

interface PanelVisibility {
  [key: string]: boolean;
  chat: boolean;
  files: boolean;
  editor: boolean;
  preview: boolean;
  terminal: boolean;
  pet: boolean;
}

interface DndState {
  isDragging: boolean;
  draggedPanelId: PanelId | null;
  // For editor tab drag (from FM tabs, not yet a panel)
  draggedEditorTabId: string | null;
}

interface LayoutState {
  layout: LayoutNode;
  visibility: PanelVisibility;
  dnd: DndState;

  // Mobile
  mobilePanels: PanelId[];

  // Actions
  mergePanels: (panelId: PanelId, targetNodeId: string) => void;
  splitPanel: (panelId: PanelId, targetNodeId: string, direction: 'top' | 'bottom' | 'left' | 'right') => void;
  setNodeActiveTab: (nodeId: string, panelId: PanelId) => void;
  movePanelToEdge: (panelId: PanelId, edge: 'left' | 'right' | 'top' | 'bottom') => void;
  updateSizes: (groupId: string, sizes: number[]) => void;
  toggleVisibility: (panelId: PanelId) => void;
  showPanel: (panelId: PanelId) => void;
  resetLayout: () => void;

  // Detached editors
  detachEditorTab: (tabId: string) => void;
  detachEditorTabToSplit: (tabId: string, targetNodeId: string, direction: 'top' | 'bottom' | 'left' | 'right') => void;
  detachEditorTabToEdge: (tabId: string, edge: 'left' | 'right' | 'top' | 'bottom') => void;
  detachEditorTabToMerge: (tabId: string, targetNodeId: string) => void;
  reattachEditor: (panelId: PanelId) => void;
  removeDetachedPanel: (panelId: PanelId) => void;

  // Detached terminals
  openNewTerminal: () => void;
  openTerminalWithId: (instanceId: string) => void;

  // DnD
  setDragging: (panelId: PanelId | null) => void;
  setDraggingEditorTab: (tabId: string | null) => void;

  // Mobile
  setMobilePanels: (panels: PanelId[]) => void;
  openMobilePanel: (panel: PanelId, position: 'top' | 'bottom') => void;
  closeMobilePanel: (panel: PanelId) => void;

  // Workspace snapshot
  getLayoutSnapshot: () => LayoutSnapshot;
  restoreLayoutFromSnapshot: (snap: LayoutSnapshot, panelIdMapping?: Record<string, string>) => void;
}

export interface LayoutSnapshot {
  layout: LayoutNode;
  visibility: Record<string, boolean>;
  mobilePanels: PanelId[];
  /** Terminal instanceId → number mapping for persistent numbering across reloads. */
  terminalNumbers?: Record<string, number>;
}

const STORAGE_KEY = 'nebulide-layout-v7';

function loadFromStorage(): { layout?: LayoutNode; visibility?: PanelVisibility; mobilePanels?: PanelId[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      return {
        layout: data.layout,
        visibility: data.visibility,
        mobilePanels: data.mobilePanels,
      };
    }
  } catch { /* ignore */ }
  return {};
}

function saveToStorage(state: LayoutState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      layout: state.layout,
      visibility: state.visibility,
      mobilePanels: state.mobilePanels,
    }));
  } catch { /* ignore */ }
  // Debounced sync to server
  import('../utils/preferences').then(m => m.savePreferencesToServer()).catch(() => {});
}

const defaultVisibility: PanelVisibility = {
  chat: true,
  files: true,
  editor: false,
  preview: false,
  terminal: true,
  pet: false,
};

const stored = loadFromStorage();

export const useLayoutStore = create<LayoutState>((set, get) => ({
  layout: stored.layout || cloneTree(DEFAULT_LAYOUT),
  visibility: stored.visibility || { ...defaultVisibility },
  dnd: { isDragging: false, draggedPanelId: null, draggedEditorTabId: null },
  mobilePanels: stored.mobilePanels || ['chat'] as PanelId[],

  mergePanels: (panelId, targetNodeId) => {
    set((state) => {
      const newLayout = mergePanelIntoNode(state.layout, panelId, targetNodeId);
      if (!newLayout) return {};
      const next = { ...state, layout: newLayout };
      saveToStorage(next);
      return { layout: newLayout };
    });
  },

  splitPanel: (panelId, targetNodeId, direction) => {
    set((state) => {
      const newLayout = splitPanelAtNode(state.layout, panelId, targetNodeId, direction);
      if (!newLayout) return {};
      const next = { ...state, layout: newLayout };
      saveToStorage(next);
      return { layout: newLayout };
    });
  },

  setNodeActiveTab: (nodeId, panelId) => {
    set((state) => {
      const newLayout = setNodeActiveTab(state.layout, nodeId, panelId);
      const next = { ...state, layout: newLayout };
      saveToStorage(next);
      return { layout: newLayout };
    });
  },

  movePanelToEdge: (panelId, edge) => {
    set((state) => {
      const newLayout = (edge === 'top' || edge === 'bottom')
        ? addRowAtEdge(state.layout, panelId, edge)
        : addColumnAtEdge(state.layout, panelId, edge);
      if (!newLayout) return {};
      const next = { ...state, layout: newLayout };
      saveToStorage(next);
      return { layout: newLayout };
    });
  },

  updateSizes: (groupId, sizes) => {
    set((state) => {
      const newLayout = updateGroupSizes(state.layout, groupId, sizes);
      const next = { ...state, layout: newLayout };
      saveToStorage(next);
      return { layout: newLayout };
    });
  },

  toggleVisibility: (panelId) => {
    set((state) => {
      const wasVisible = state.visibility[panelId];
      const newVis = { ...state.visibility, [panelId]: !wasVisible };

      // For detached terminals: hiding = close (destroy session + remove from layout)
      if (wasVisible && isDetachedTerminal(panelId)) {
        const instanceId = getDetachedTerminalId(panelId);
        if (instanceId) destroyTerminalSession(instanceId);
        const newLayout = removePanelFromTree(state.layout, panelId) || state.layout;
        delete newVis[panelId];
        const next = { ...state, layout: newLayout, visibility: newVis };
        saveToStorage(next);
        return { layout: newLayout, visibility: newVis };
      }

      // For base terminal: hiding = kill PTY (fresh session on reopen)
      if (wasVisible && panelId === 'terminal') {
        destroyTerminalSession('default');
      }

      // For detached editors: hiding = close (remove from layout)
      if (wasVisible && isDetachedEditor(panelId)) {
        const tabId = panelId.slice('editor:'.length);
        useWorkspaceStore.getState().closeDetachedEditor(tabId);
        // Remove from layout tree
        const newLayout = removePanelFromTree(state.layout, panelId) || state.layout;
        // Clean up visibility key
        delete newVis[panelId];
        const next = { ...state, layout: newLayout, visibility: newVis };
        saveToStorage(next);
        return { layout: newLayout, visibility: newVis };
      }

      let newLayout = state.layout;

      // Auto-insert pet panel into layout if not present
      if (!wasVisible && panelId === 'pet' && !findPanelNode(state.layout, 'pet')) {
        const termNode = findPanelNode(state.layout, 'terminal');
        newLayout = termNode
          ? insertPanelIntoNode(state.layout, 'pet', termNode.id)
          : insertPanelAtEdge(state.layout, 'pet', 'bottom');
      }

      if (wasVisible) {
        // If hiding the currently active tab in a multi-tab node → switch to next visible tab
        const node = findPanelNode(state.layout, panelId);
        if (node && node.panelIds.length > 1 && node.panelIds[node.activeIndex] === panelId) {
          const idx = node.panelIds.indexOf(panelId);
          let nextActive: PanelId | null = null;
          // Prefer tab to the right, fallback to left
          for (let i = idx + 1; i < node.panelIds.length; i++) {
            if (newVis[node.panelIds[i]] !== false) { nextActive = node.panelIds[i]; break; }
          }
          if (!nextActive) {
            for (let i = idx - 1; i >= 0; i--) {
              if (newVis[node.panelIds[i]] !== false) { nextActive = node.panelIds[i]; break; }
            }
          }
          if (nextActive) {
            newLayout = setNodeActiveTab(state.layout, node.id, nextActive);
          }
        }
      } else {
        // If showing a panel → make it the active tab in its node
        const node = findPanelNode(state.layout, panelId);
        if (node && node.panelIds.length > 1) {
          newLayout = setNodeActiveTab(state.layout, node.id, panelId);
        }
      }

      const next = { ...state, layout: newLayout, visibility: newVis };
      saveToStorage(next);
      return { layout: newLayout, visibility: newVis };
    });
  },

  showPanel: (panelId) => {
    set((state) => {
      const newVis = { ...state.visibility, [panelId]: true };
      let newLayout = state.layout;

      // Always activate the panel in its node (make it the active tab)
      const node = findPanelNode(state.layout, panelId);
      if (node) {
        newLayout = setNodeActiveTab(state.layout, node.id, panelId);
      }

      const next = { ...state, layout: newLayout, visibility: newVis };
      saveToStorage(next);
      return { layout: newLayout, visibility: newVis };
    });
  },

  resetLayout: () => {
    set((state) => {
      // Destroy all detached terminals
      for (const panelId of getAllPanelIds(state.layout)) {
        if (isDetachedTerminal(panelId)) {
          const instanceId = getDetachedTerminalId(panelId);
          if (instanceId) destroyTerminalSession(instanceId);
        }
      }
      // Reattach all detached editors back to FM before reset
      const ws = useWorkspaceStore.getState();
      for (const tabId of Object.keys(ws.detachedEditors)) {
        ws.reattachEditor(tabId);
      }
      const next = {
        ...state,
        layout: cloneTree(DEFAULT_LAYOUT),
        visibility: { ...defaultVisibility },
      };
      saveToStorage(next);
      return { layout: next.layout, visibility: next.visibility };
    });
  },

  // Detach editor tab: place next to the 'files' node (right side)
  detachEditorTab: (tabId) => {
    const result = useWorkspaceStore.getState().detachTab(tabId);
    if (!result) return;

    const panelId = makeDetachedPanelId(tabId);

    set((state) => {
      // Find the 'files' panel node to place new editor next to it
      const filesNode = findPanelNode(state.layout, 'files');
      const targetNodeId = filesNode?.id || 'root';
      const newLayout = insertPanelAtNode(state.layout, panelId, targetNodeId, 'right');
      const newVis = { ...state.visibility, [panelId]: true };
      const next = { ...state, layout: newLayout, visibility: newVis };
      saveToStorage(next);
      return { layout: newLayout, visibility: newVis };
    });
  },

  // Detach editor tab to a specific split position
  detachEditorTabToSplit: (tabId, targetNodeId, direction) => {
    const result = useWorkspaceStore.getState().detachTab(tabId);
    if (!result) return;

    const panelId = makeDetachedPanelId(tabId);

    set((state) => {
      const newLayout = insertPanelAtNode(state.layout, panelId, targetNodeId, direction);
      const newVis = { ...state.visibility, [panelId]: true };
      const next = { ...state, layout: newLayout, visibility: newVis };
      saveToStorage(next);
      return { layout: newLayout, visibility: newVis };
    });
  },

  // Detach editor tab to an edge of the layout
  detachEditorTabToEdge: (tabId, edge) => {
    const result = useWorkspaceStore.getState().detachTab(tabId);
    if (!result) return;

    const panelId = makeDetachedPanelId(tabId);

    set((state) => {
      const newLayout = insertPanelAtEdge(state.layout, panelId, edge);
      const newVis = { ...state.visibility, [panelId]: true };
      const next = { ...state, layout: newLayout, visibility: newVis };
      saveToStorage(next);
      return { layout: newLayout, visibility: newVis };
    });
  },

  // Detach editor tab and merge into existing node as a tab
  detachEditorTabToMerge: (tabId, targetNodeId) => {
    const result = useWorkspaceStore.getState().detachTab(tabId);
    if (!result) return;

    const panelId = makeDetachedPanelId(tabId);

    set((state) => {
      const newLayout = insertPanelIntoNode(state.layout, panelId, targetNodeId);
      const newVis = { ...state.visibility, [panelId]: true };
      const next = { ...state, layout: newLayout, visibility: newVis };
      saveToStorage(next);
      return { layout: newLayout, visibility: newVis };
    });
  },

  // Reattach a detached editor back to FM
  reattachEditor: (panelId) => {
    if (!isDetachedEditor(panelId)) return;
    const tabId = panelId.slice('editor:'.length);
    useWorkspaceStore.getState().reattachEditor(tabId);

    set((state) => {
      const newLayout = removePanelFromTree(state.layout, panelId) || state.layout;
      const newVis = { ...state.visibility };
      delete newVis[panelId];
      const next = { ...state, layout: newLayout, visibility: newVis };
      saveToStorage(next);
      return { layout: newLayout, visibility: newVis };
    });
  },

  // Remove a detached panel from layout (without reattaching)
  removeDetachedPanel: (panelId) => {
    // Destroy terminal session if removing a detached terminal
    if (isDetachedTerminal(panelId)) {
      const instanceId = getDetachedTerminalId(panelId);
      if (instanceId) destroyTerminalSession(instanceId);
    }
    set((state) => {
      const newLayout = removePanelFromTree(state.layout, panelId) || state.layout;
      const newVis = { ...state.visibility };
      delete newVis[panelId];
      const next = { ...state, layout: newLayout, visibility: newVis };
      saveToStorage(next);
      return { layout: newLayout, visibility: newVis };
    });
  },

  // Open a new terminal instance as a separate panel
  openNewTerminal: () => {
    const instanceId = `term-${Date.now()}`;
    registerTerminal(instanceId);
    const panelId = makeDetachedTerminalPanelId(instanceId);
    set((state) => {
      // Place next to the existing terminal node if possible, otherwise at bottom edge
      const termNode = findPanelNode(state.layout, 'terminal');
      const newLayout = termNode
        ? insertPanelAtNode(state.layout, panelId, termNode.id, 'right')
        : insertPanelAtEdge(state.layout, panelId, 'bottom');
      const newVis = { ...state.visibility, [panelId]: true };
      const next = { ...state, layout: newLayout, visibility: newVis };
      saveToStorage(next);
      return { layout: newLayout, visibility: newVis };
    });
  },

  openTerminalWithId: (instanceId: string) => {
    registerTerminal(instanceId);
    const panelId = makeDetachedTerminalPanelId(instanceId);
    set((state) => {
      const termNode = findPanelNode(state.layout, 'terminal');
      const newLayout = termNode
        ? insertPanelAtNode(state.layout, panelId, termNode.id, 'right')
        : insertPanelAtEdge(state.layout, panelId, 'bottom');
      const newVis = { ...state.visibility, [panelId]: true };
      const next = { ...state, layout: newLayout, visibility: newVis };
      saveToStorage(next);
      return { layout: newLayout, visibility: newVis };
    });
  },

  setDragging: (panelId) => {
    set({ dnd: { isDragging: panelId !== null, draggedPanelId: panelId, draggedEditorTabId: null } });
  },

  setDraggingEditorTab: (tabId) => {
    set({ dnd: { isDragging: tabId !== null, draggedPanelId: null, draggedEditorTabId: tabId } });
  },

  setMobilePanels: (panels) => {
    set((state) => {
      const next = { ...state, mobilePanels: panels };
      saveToStorage(next);
      return { mobilePanels: panels };
    });
  },

  openMobilePanel: (panel, position) => {
    set((state) => {
      const current = [...state.mobilePanels];
      const existingIdx = current.indexOf(panel);
      if (existingIdx >= 0) {
        if (current.length === 2) {
          const swapped: PanelId[] = [current[1], current[0]];
          const next = { ...state, mobilePanels: swapped };
          saveToStorage(next);
          return { mobilePanels: swapped };
        }
        return {};
      }

      let newPanels: PanelId[];
      if (current.length < 2) {
        newPanels = position === 'top' ? [panel, ...current] : [...current, panel];
      } else {
        newPanels = [...current];
        newPanels[position === 'top' ? 0 : 1] = panel;
      }

      const next = { ...state, mobilePanels: newPanels };
      saveToStorage(next);
      return { mobilePanels: newPanels };
    });
  },

  closeMobilePanel: (panel) => {
    set((state) => {
      // For detached editors: reattach to FM
      if (isDetachedEditor(panel)) {
        const tabId = panel.slice('editor:'.length);
        useWorkspaceStore.getState().reattachEditor(tabId);
      }

      // For detached terminals: destroy session
      if (isDetachedTerminal(panel)) {
        const instanceId = getDetachedTerminalId(panel);
        if (instanceId) destroyTerminalSession(instanceId);
      }

      // Hide the panel from visibility so it disappears from tab bar
      const newVis = { ...state.visibility, [panel]: false };
      if (isDetachedEditor(panel) || isDetachedTerminal(panel)) delete newVis[panel];

      // Remove from mobilePanels
      let newPanels = state.mobilePanels.filter((p) => p !== panel);

      // If we closed the last panel, pick the first remaining visible panel
      if (newPanels.length === 0) {
        const allPanels: PanelId[] = ['chat', 'files', 'editor', 'preview', 'terminal', 'pet'];
        const firstVisible = allPanels.find((p) => newVis[p]);
        newPanels = firstVisible ? [firstVisible] : ['chat'];
        // Ensure at least chat is visible
        if (!firstVisible) newVis.chat = true;
      }

      let newLayout = state.layout;
      if (isDetachedEditor(panel) || isDetachedTerminal(panel)) {
        newLayout = removePanelFromTree(state.layout, panel) || state.layout;
      }

      const next = { ...state, layout: newLayout, visibility: newVis, mobilePanels: newPanels };
      saveToStorage(next);
      return { layout: newLayout, visibility: newVis, mobilePanels: newPanels };
    });
  },

  getLayoutSnapshot: (): LayoutSnapshot => {
    const state = get();
    return {
      layout: cloneTree(state.layout),
      visibility: { ...state.visibility },
      mobilePanels: [...state.mobilePanels],
      terminalNumbers: getRegistrySnapshot(),
    };
  },

  restoreLayoutFromSnapshot: (snap, panelIdMapping) => {
    // Determine which terminal instanceIds the new layout needs
    let preLayout = cloneTree(snap.layout);
    if (panelIdMapping && Object.keys(panelIdMapping).length > 0) {
      preLayout = remapPanelIds(preLayout, panelIdMapping);
    }
    const newPanelIds = getAllPanelIds(preLayout);
    const keepIds = new Set<string>();
    for (const pid of newPanelIds) {
      if (pid === 'terminal') keepIds.add('default');
      else if (isDetachedTerminal(pid)) {
        const id = getDetachedTerminalId(pid);
        if (id) keepIds.add(id);
      }
    }

    // Restore terminal numbering: use saved numbers from snapshot if available,
    // otherwise assign fresh 1, 2, 3... to keepIds.
    if (snap.terminalNumbers && Object.keys(snap.terminalNumbers).length > 0) {
      restoreRegistryFromSnapshot(snap.terminalNumbers, keepIds);
    } else {
      resetTerminalRegistry();
      for (const id of keepIds) registerTerminal(id);
    }

    // Destroy frontend+backend sessions that are NOT in the new layout
    for (const instanceId of getActiveTerminalInstanceIds()) {
      if (!keepIds.has(instanceId)) {
        destroyTerminalSession(instanceId);
      }
    }

    set((state) => {
      // Remap panel IDs if mapping provided (detached editors get new tab IDs)
      let layout = cloneTree(snap.layout);
      let visibility = { ...snap.visibility } as PanelVisibility;
      let mobilePanels = [...(snap.mobilePanels || [])];

      if (panelIdMapping && Object.keys(panelIdMapping).length > 0) {
        layout = remapPanelIds(layout, panelIdMapping);
        visibility = remapVisibility(visibility, panelIdMapping) as PanelVisibility;
        mobilePanels = mobilePanels.map((p) => (panelIdMapping[p] || p) as PanelId);
      }

      // Cross-device: if restoring on mobile from a desktop snapshot (or vice versa),
      // the mobilePanels may not reflect which panels are actually visible.
      // Derive mobilePanels from visibility so the user sees the same panels.
      const isMobile = window.innerWidth <= 640;
      if (isMobile) {
        // Priority order for mobile: show the most relevant visible panels (max 2)
        const mobileOrder: PanelId[] = ['terminal', 'chat', 'files', 'editor', 'pet', 'preview'];
        const visibleBase = mobileOrder.filter((p) => visibility[p]);
        if (visibleBase.length > 0 && (mobilePanels.length === 0 || !mobilePanels.some((p) => visibility[p]))) {
          mobilePanels = visibleBase.slice(0, 2);
        }
      }

      const next = { ...state, layout, visibility, mobilePanels };
      saveToStorage(next);
      return { layout, visibility, mobilePanels };
    });
  },
}));
