import { create } from 'zustand';
import {
  type PanelId,
  type LayoutNode,
  DEFAULT_LAYOUT,
  swapPanelIds,
  addColumnAtEdge,
  updateGroupSizes,
  cloneTree,
} from './layoutUtils';

export type { PanelId };
export type { LayoutNode, PanelNode, GroupNode } from './layoutUtils';

interface PanelVisibility {
  chat: boolean;
  files: boolean;
  editor: boolean;
  terminal: boolean;
}

interface DndState {
  isDragging: boolean;
  draggedPanelId: PanelId | null;
}

interface LayoutState {
  layout: LayoutNode;
  visibility: PanelVisibility;
  dnd: DndState;

  // Mobile
  mobilePanels: PanelId[];

  // Actions
  swapPanels: (panelA: PanelId, panelB: PanelId) => void;
  movePanelToEdge: (panelId: PanelId, edge: 'left' | 'right') => void;
  updateSizes: (groupId: string, sizes: number[]) => void;
  toggleVisibility: (panelId: PanelId) => void;
  resetLayout: () => void;

  // DnD
  setDragging: (panelId: PanelId | null) => void;

  // Mobile
  setMobilePanels: (panels: PanelId[]) => void;
  openMobilePanel: (panel: PanelId, position: 'top' | 'bottom') => void;
  closeMobilePanel: (panel: PanelId) => void;
}

const STORAGE_KEY = 'clauder-layout-v2';

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
  editor: true,
  terminal: true,
};

const stored = loadFromStorage();

export const useLayoutStore = create<LayoutState>((set, get) => ({
  layout: stored.layout || cloneTree(DEFAULT_LAYOUT),
  visibility: stored.visibility || { ...defaultVisibility },
  dnd: { isDragging: false, draggedPanelId: null },
  mobilePanels: stored.mobilePanels || ['chat'] as PanelId[],

  swapPanels: (panelA, panelB) => {
    if (panelA === panelB) return;
    set((state) => {
      const newLayout = swapPanelIds(state.layout, panelA, panelB);
      const next = { ...state, layout: newLayout };
      saveToStorage(next);
      return { layout: newLayout };
    });
  },

  movePanelToEdge: (panelId, edge) => {
    set((state) => {
      const newLayout = addColumnAtEdge(state.layout, panelId, edge);
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
      const newVis = { ...state.visibility, [panelId]: !state.visibility[panelId] };
      const next = { ...state, visibility: newVis };
      saveToStorage(next);
      return { visibility: newVis };
    });
  },

  resetLayout: () => {
    set((state) => {
      const next = {
        ...state,
        layout: cloneTree(DEFAULT_LAYOUT),
        visibility: { ...defaultVisibility },
      };
      saveToStorage(next);
      return { layout: next.layout, visibility: next.visibility };
    });
  },

  setDragging: (panelId) => {
    set({ dnd: { isDragging: panelId !== null, draggedPanelId: panelId } });
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
      if (state.mobilePanels.length <= 1) return {};
      const newPanels = state.mobilePanels.filter((p) => p !== panel);
      const next = { ...state, mobilePanels: newPanels };
      saveToStorage(next);
      return { mobilePanels: newPanels };
    });
  },
}));
