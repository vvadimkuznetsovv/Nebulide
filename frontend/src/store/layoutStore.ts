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
  findPanelNode,
  removePanelFromTree,
  insertPanelAtNode,
  insertPanelAtEdge,
  insertPanelIntoNode,
} from './layoutUtils';
import { useWorkspaceStore } from './workspaceStore';

export type { PanelId };
export type { LayoutNode, PanelNode, GroupNode } from './layoutUtils';

interface PanelVisibility {
  [key: string]: boolean;
  chat: boolean;
  files: boolean;
  editor: boolean;
  preview: boolean;
  terminal: boolean;
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
  resetLayout: () => void;

  // Detached editors
  detachEditorTab: (tabId: string) => void;
  detachEditorTabToSplit: (tabId: string, targetNodeId: string, direction: 'top' | 'bottom' | 'left' | 'right') => void;
  detachEditorTabToEdge: (tabId: string, edge: 'left' | 'right' | 'top' | 'bottom') => void;
  detachEditorTabToMerge: (tabId: string, targetNodeId: string) => void;
  reattachEditor: (panelId: PanelId) => void;
  removeDetachedPanel: (panelId: PanelId) => void;

  // DnD
  setDragging: (panelId: PanelId | null) => void;
  setDraggingEditorTab: (tabId: string | null) => void;

  // Mobile
  setMobilePanels: (panels: PanelId[]) => void;
  openMobilePanel: (panel: PanelId, position: 'top' | 'bottom') => void;
  closeMobilePanel: (panel: PanelId) => void;
}

const STORAGE_KEY = 'clauder-layout-v6';

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
}

const defaultVisibility: PanelVisibility = {
  chat: true,
  files: true,
  editor: false,
  preview: false,
  terminal: true,
};

const stored = loadFromStorage();

export const useLayoutStore = create<LayoutState>((set) => ({
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

      // For detached editors: hiding = close + reattach to FM
      if (wasVisible && isDetachedEditor(panelId)) {
        const tabId = panelId.slice('editor:'.length);
        useWorkspaceStore.getState().reattachEditor(tabId);
        // Remove from layout tree
        const newLayout = removePanelFromTree(state.layout, panelId) || state.layout;
        // Clean up visibility key
        delete newVis[panelId];
        const next = { ...state, layout: newLayout, visibility: newVis };
        saveToStorage(next);
        return { layout: newLayout, visibility: newVis };
      }

      const next = { ...state, visibility: newVis };
      saveToStorage(next);
      return { visibility: newVis };
    });
  },

  resetLayout: () => {
    set((state) => {
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
    set((state) => {
      const newLayout = removePanelFromTree(state.layout, panelId) || state.layout;
      const newVis = { ...state.visibility };
      delete newVis[panelId];
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

      // Hide the panel from visibility so it disappears from tab bar
      const newVis = { ...state.visibility, [panel]: false };
      if (isDetachedEditor(panel)) delete newVis[panel];

      // Remove from mobilePanels
      let newPanels = state.mobilePanels.filter((p) => p !== panel);

      // If we closed the last panel, pick the first remaining visible panel
      if (newPanels.length === 0) {
        const allPanels: PanelId[] = ['chat', 'files', 'editor', 'preview', 'terminal'];
        const firstVisible = allPanels.find((p) => newVis[p]);
        newPanels = firstVisible ? [firstVisible] : ['chat'];
        // Ensure at least chat is visible
        if (!firstVisible) newVis.chat = true;
      }

      let newLayout = state.layout;
      if (isDetachedEditor(panel)) {
        newLayout = removePanelFromTree(state.layout, panel) || state.layout;
      }

      const next = { ...state, layout: newLayout, visibility: newVis, mobilePanels: newPanels };
      saveToStorage(next);
      return { layout: newLayout, visibility: newVis, mobilePanels: newPanels };
    });
  },
}));
