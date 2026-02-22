import { create } from 'zustand';
import type { ChatSession } from '../api/sessions';

export interface EditorTab {
  id: string;
  filePath: string;
  modified: boolean;
}

export interface PreviewTab {
  id: string;
  filePath: string;
  type: 'pdf' | 'docx';
}

let tabCounter = 0;
function generateTabId(): string {
  return `tab-${++tabCounter}`;
}

const PREVIEW_EXTENSIONS = new Set(['.pdf', '.docx']);

export function isPreviewableFile(filePath: string): boolean {
  const ext = '.' + filePath.split('.').pop()?.toLowerCase();
  return PREVIEW_EXTENSIONS.has(ext);
}

function getDocumentType(filePath: string): 'pdf' | 'docx' | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  return null;
}

export interface DetachedEditorInfo {
  filePath: string;
  modified: boolean;
}

interface WorkspaceState {
  activeSession: ChatSession | null;

  // Tab system
  openTabs: EditorTab[];
  activeTabId: string | null;

  // Detached editors: tabId → file info (editors extracted from File Manager into layout)
  detachedEditors: Record<string, DetachedEditorInfo>;

  // FileTree sidebar visibility inside editor panel
  fileTreeVisible: boolean;

  // Preview panel
  previewUrl: string | null;
  previewFilePath: string | null;

  // Preview tab system (for documents)
  previewTabs: PreviewTab[];
  activePreviewTabId: string | null;

  // UI state
  sidebarOpen: boolean;
  toolbarOpen: boolean;

  // Session
  setActiveSession: (session: ChatSession | null) => void;

  // Tab actions
  openFile: (filePath: string, inNewTab?: boolean) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  setTabModified: (tabId: string, modified: boolean) => void;

  // Detached editor actions
  detachTab: (tabId: string) => string | null;
  reattachEditor: (tabId: string) => void;
  closeDetachedEditor: (tabId: string) => void;
  setDetachedModified: (tabId: string, modified: boolean) => void;

  // FileTree toggle
  toggleFileTree: () => void;
  setFileTreeVisible: (visible: boolean) => void;

  // Preview
  setPreviewUrl: (url: string | null) => void;
  setPreviewFile: (filePath: string | null) => void;

  // Preview tab actions
  openPreviewFile: (filePath: string) => void;
  closePreviewTab: (tabId: string) => void;
  setActivePreviewTab: (tabId: string | null) => void;

  // UI
  setSidebarOpen: (open: boolean) => void;
  setToolbarOpen: (open: boolean) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  activeSession: null,
  openTabs: [],
  activeTabId: null,
  detachedEditors: {},
  fileTreeVisible: true,
  previewUrl: null,
  previewFilePath: null,
  previewTabs: [],
  activePreviewTabId: null,
  sidebarOpen: false,
  toolbarOpen: false,

  setActiveSession: (session) => set({ activeSession: session }),

  openFile: (filePath, inNewTab = false) => {
    const { openTabs, activeTabId } = get();

    // Check if file is already open
    const existing = openTabs.find((t) => t.filePath === filePath);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }

    if (inNewTab || openTabs.length === 0) {
      // Open in new tab
      const newTab: EditorTab = { id: generateTabId(), filePath, modified: false };
      set({
        openTabs: [...openTabs, newTab],
        activeTabId: newTab.id,
      });
    } else {
      // Replace active tab (if not modified), otherwise open new tab
      const activeTab = openTabs.find((t) => t.id === activeTabId);
      if (activeTab && !activeTab.modified) {
        set({
          openTabs: openTabs.map((t) =>
            t.id === activeTabId ? { ...t, filePath, modified: false } : t,
          ),
        });
      } else {
        const newTab: EditorTab = { id: generateTabId(), filePath, modified: false };
        set({
          openTabs: [...openTabs, newTab],
          activeTabId: newTab.id,
        });
      }
    }
  },

  closeTab: (tabId) => {
    const { openTabs, activeTabId } = get();
    const idx = openTabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;

    const newTabs = openTabs.filter((t) => t.id !== tabId);
    let newActiveId = activeTabId;

    if (activeTabId === tabId) {
      if (newTabs.length === 0) {
        newActiveId = null;
      } else if (idx >= newTabs.length) {
        newActiveId = newTabs[newTabs.length - 1].id;
      } else {
        newActiveId = newTabs[idx].id;
      }
    }

    set({ openTabs: newTabs, activeTabId: newActiveId });
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  setTabModified: (tabId, modified) => {
    set((state) => {
      // Check if it's a detached editor
      if (state.detachedEditors[tabId]) {
        return {
          detachedEditors: {
            ...state.detachedEditors,
            [tabId]: { ...state.detachedEditors[tabId], modified },
          },
        };
      }
      return {
        openTabs: state.openTabs.map((t) =>
          t.id === tabId ? { ...t, modified } : t,
        ),
      };
    });
  },

  // Detach a tab from File Manager → becomes a standalone panel
  // Returns the tabId for creating the panel, or null if tab not found
  detachTab: (tabId) => {
    const { openTabs, activeTabId } = get();
    const tab = openTabs.find((t) => t.id === tabId);
    if (!tab) return null;

    // Remove from openTabs
    const newTabs = openTabs.filter((t) => t.id !== tabId);
    let newActiveId = activeTabId;
    if (activeTabId === tabId) {
      const idx = openTabs.findIndex((t) => t.id === tabId);
      if (newTabs.length === 0) newActiveId = null;
      else if (idx >= newTabs.length) newActiveId = newTabs[newTabs.length - 1].id;
      else newActiveId = newTabs[idx].id;
    }

    // Add to detachedEditors
    set({
      openTabs: newTabs,
      activeTabId: newActiveId,
      detachedEditors: {
        ...get().detachedEditors,
        [tabId]: { filePath: tab.filePath, modified: tab.modified },
      },
    });
    return tabId;
  },

  // Return a detached editor back to File Manager tabs
  reattachEditor: (tabId) => {
    const { detachedEditors, openTabs } = get();
    const info = detachedEditors[tabId];
    if (!info) return;

    // Check if file is already open in FM
    const existing = openTabs.find((t) => t.filePath === info.filePath);
    if (existing) {
      // Just remove from detached, activate existing
      const { [tabId]: _, ...rest } = detachedEditors;
      set({ detachedEditors: rest, activeTabId: existing.id });
      return;
    }

    // Create new tab with same tabId to preserve CodeEditor cache
    const newTab: EditorTab = { id: tabId, filePath: info.filePath, modified: info.modified };
    const { [tabId]: _, ...rest } = detachedEditors;
    set({
      openTabs: [...openTabs, newTab],
      activeTabId: tabId,
      detachedEditors: rest,
    });
  },

  // Close a detached editor without returning to FM
  closeDetachedEditor: (tabId) => {
    const { detachedEditors } = get();
    const { [tabId]: _, ...rest } = detachedEditors;
    set({ detachedEditors: rest });
  },

  setDetachedModified: (tabId, modified) => {
    set((state) => {
      if (!state.detachedEditors[tabId]) return {};
      return {
        detachedEditors: {
          ...state.detachedEditors,
          [tabId]: { ...state.detachedEditors[tabId], modified },
        },
      };
    });
  },

  toggleFileTree: () => set((state) => ({ fileTreeVisible: !state.fileTreeVisible })),
  setFileTreeVisible: (visible) => set({ fileTreeVisible: visible }),

  setPreviewUrl: (url) => set({ previewUrl: url, previewFilePath: null }),
  setPreviewFile: (filePath) => set({ previewFilePath: filePath, previewUrl: null }),

  openPreviewFile: (filePath) => {
    const { previewTabs } = get();
    const docType = getDocumentType(filePath);
    if (!docType) return;

    // Check if already open
    const existing = previewTabs.find((t) => t.filePath === filePath);
    if (existing) {
      set({ activePreviewTabId: existing.id, previewUrl: null });
      return;
    }

    const newTab: PreviewTab = {
      id: generateTabId(),
      filePath,
      type: docType,
    };
    set({
      previewTabs: [...previewTabs, newTab],
      activePreviewTabId: newTab.id,
      previewUrl: null,
    });
  },

  closePreviewTab: (tabId) => {
    const { previewTabs, activePreviewTabId } = get();
    const idx = previewTabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;

    const newTabs = previewTabs.filter((t) => t.id !== tabId);
    let newActiveId = activePreviewTabId;

    if (activePreviewTabId === tabId) {
      if (newTabs.length === 0) {
        newActiveId = null;
      } else if (idx >= newTabs.length) {
        newActiveId = newTabs[newTabs.length - 1].id;
      } else {
        newActiveId = newTabs[idx].id;
      }
    }

    set({ previewTabs: newTabs, activePreviewTabId: newActiveId });
  },

  setActivePreviewTab: (tabId) => set({ activePreviewTabId: tabId }),

  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setToolbarOpen: (open) => set({ toolbarOpen: open }),
}));
