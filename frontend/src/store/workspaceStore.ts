import { create } from 'zustand';
import type { ChatSession } from '../api/sessions';

interface WorkspaceState {
  activeSession: ChatSession | null;
  editingFile: string | null;
  sidebarOpen: boolean;
  toolbarOpen: boolean;

  setActiveSession: (session: ChatSession | null) => void;
  setEditingFile: (path: string | null) => void;
  setSidebarOpen: (open: boolean) => void;
  setToolbarOpen: (open: boolean) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  activeSession: null,
  editingFile: null,
  sidebarOpen: false,
  toolbarOpen: false,

  setActiveSession: (session) => set({ activeSession: session }),
  setEditingFile: (path) => set({ editingFile: path }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setToolbarOpen: (open) => set({ toolbarOpen: open }),
}));
