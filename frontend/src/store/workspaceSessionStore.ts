import { create } from 'zustand';
import {
  type WorkspaceSession,
  getWorkspaceSessions,
  getLatestWorkspaceSession,
  createWorkspaceSession,
  updateWorkspaceSession,
  deleteWorkspaceSession,
} from '../api/workspaceSessions';
import { useWorkspaceStore, type WorkspaceSnapshot } from './workspaceStore';
import { useLayoutStore, type LayoutSnapshot } from './layoutStore';
import { destroyAllTerminalSessions } from '../components/terminal/Terminal';
import toast from 'react-hot-toast';

const ACTIVE_WS_KEY = 'nebulide-active-workspace';

function detectDeviceTag(): string {
  const w = window.innerWidth;
  if (w <= 640) return 'Phone';
  if (w <= 1024) return 'Tablet';
  return 'Desktop';
}

interface FullSnapshot {
  workspace: WorkspaceSnapshot;
  layout: LayoutSnapshot;
}

interface WorkspaceSessionState {
  sessions: WorkspaceSession[];
  activeSessionId: string | null;
  loading: boolean;

  loadSessions: () => Promise<void>;
  initSession: () => Promise<void>;
  createSession: (name: string) => Promise<void>;
  switchSession: (id: string) => Promise<void>;
  saveCurrentSession: () => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  updateSessionsList: (sessions: WorkspaceSession[]) => void;
}

export const useWorkspaceSessionStore = create<WorkspaceSessionState>((set, get) => ({
  sessions: [],
  activeSessionId: localStorage.getItem(ACTIVE_WS_KEY),
  loading: false,

  loadSessions: async () => {
    try {
      const { data } = await getWorkspaceSessions();
      set({ sessions: data || [] });
    } catch {
      // Ignore — user may not have any sessions yet
    }
  },

  initSession: async () => {
    const state = get();
    if (state.loading) return;
    set({ loading: true });

    try {
      await state.loadSessions();
      const { sessions, activeSessionId } = get();

      // If we have a saved active session ID, check if it still exists
      if (activeSessionId) {
        const exists = sessions.find((s) => s.id === activeSessionId);
        if (exists) {
          set({ loading: false });
          return; // Already on a valid session
        }
      }

      // Try to get the latest session
      if (sessions.length > 0) {
        try {
          const { data } = await getLatestWorkspaceSession();
          localStorage.setItem(ACTIVE_WS_KEY, data.id);
          set({ activeSessionId: data.id, loading: false });
          // Restore snapshot from latest (tolerate malformed snapshots)
          try {
            const snap = data.snapshot as unknown as FullSnapshot;
            if (snap?.layout && snap?.workspace) {
              const panelIdMapping = useWorkspaceStore.getState().restoreFromSnapshot(snap.workspace);
              useLayoutStore.getState().restoreLayoutFromSnapshot(snap.layout, panelIdMapping);
            }
          } catch {
            console.warn('[WorkspaceSession] Failed to restore snapshot, using default layout');
          }
          return;
        } catch {
          // Fallback: use first session
          const first = sessions[0];
          localStorage.setItem(ACTIVE_WS_KEY, first.id);
          set({ activeSessionId: first.id, loading: false });
          return;
        }
      }

      // No sessions exist — create default
      const deviceTag = detectDeviceTag();
      const { data } = await createWorkspaceSession(deviceTag, deviceTag, {});
      localStorage.setItem(ACTIVE_WS_KEY, data.id);
      set({
        sessions: [data],
        activeSessionId: data.id,
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  createSession: async (name) => {
    try {
      // Save current session before creating new one
      await get().saveCurrentSession();

      const deviceTag = detectDeviceTag();
      const { data } = await createWorkspaceSession(name, deviceTag, {});
      set((state) => ({
        sessions: [data, ...state.sessions],
        activeSessionId: data.id,
      }));
      localStorage.setItem(ACTIVE_WS_KEY, data.id);

      // Reset workspace to defaults for the new session
      destroyAllTerminalSessions();
      useWorkspaceStore.getState().restoreFromSnapshot({
        openTabs: [],
        activeTabIndex: null,
        tempTabIndex: null,
        detachedEditors: [],
        fileTreeVisible: true,
        sidebarOpen: false,
        toolbarOpen: false,
      });
      useLayoutStore.getState().resetLayout();

      toast.success(`Workspace "${name}" created`);
    } catch {
      toast.error('Failed to create workspace');
    }
  },

  switchSession: async (id) => {
    const { activeSessionId } = get();
    if (activeSessionId === id) return;

    try {
      // Save current session
      await get().saveCurrentSession();

      // Check for modified tabs
      const ws = useWorkspaceStore.getState();
      const hasModified = ws.openTabs.some((t) => t.modified) ||
        Object.values(ws.detachedEditors).some((e) => e.modified);
      if (hasModified) {
        const proceed = window.confirm(
          'You have unsaved changes. Switch workspace anyway?'
        );
        if (!proceed) return;
      }

      // Destroy all terminals
      destroyAllTerminalSessions();

      // Load target session
      const { sessions } = get();
      const target = sessions.find((s) => s.id === id);
      if (!target) return;

      try {
        const snap = target.snapshot as unknown as FullSnapshot;
        if (snap?.layout && snap?.workspace) {
          const panelIdMapping = useWorkspaceStore.getState().restoreFromSnapshot(snap.workspace);
          useLayoutStore.getState().restoreLayoutFromSnapshot(snap.layout, panelIdMapping);
        } else {
          // No snapshot — reset to defaults
          useWorkspaceStore.getState().restoreFromSnapshot({
            openTabs: [],
            activeTabIndex: null,
            tempTabIndex: null,
            detachedEditors: [],
            fileTreeVisible: true,
            sidebarOpen: false,
            toolbarOpen: false,
          });
          useLayoutStore.getState().resetLayout();
        }
      } catch {
        console.warn('[WorkspaceSession] Failed to restore snapshot, resetting layout');
        useWorkspaceStore.getState().restoreFromSnapshot({
          openTabs: [],
          activeTabIndex: null,
          tempTabIndex: null,
          detachedEditors: [],
          fileTreeVisible: true,
          sidebarOpen: false,
          toolbarOpen: false,
        });
        useLayoutStore.getState().resetLayout();
      }

      set({ activeSessionId: id });
      localStorage.setItem(ACTIVE_WS_KEY, id);
    } catch {
      toast.error('Failed to switch workspace');
    }
  },

  saveCurrentSession: async () => {
    const { activeSessionId } = get();
    if (!activeSessionId) return;

    try {
      const workspaceSnap = useWorkspaceStore.getState().getWorkspaceSnapshot();
      const layoutSnap = useLayoutStore.getState().getLayoutSnapshot();
      const fullSnapshot: FullSnapshot = {
        workspace: workspaceSnap,
        layout: layoutSnap,
      };
      await updateWorkspaceSession(activeSessionId, { snapshot: fullSnapshot as unknown as Record<string, unknown> });
    } catch {
      // Silent fail — background save
    }
  },

  renameSession: async (id, name) => {
    try {
      await updateWorkspaceSession(id, { name });
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === id ? { ...s, name } : s,
        ),
      }));
    } catch {
      toast.error('Failed to rename workspace');
    }
  },

  deleteSession: async (id) => {
    const { sessions, activeSessionId } = get();
    if (sessions.length <= 1) {
      toast.error('Cannot delete the last workspace');
      return;
    }

    try {
      await deleteWorkspaceSession(id);
      const remaining = sessions.filter((s) => s.id !== id);
      set({ sessions: remaining });

      // If we deleted the active session, switch to another
      if (activeSessionId === id && remaining.length > 0) {
        await get().switchSession(remaining[0].id);
      }
    } catch {
      toast.error('Failed to delete workspace');
    }
  },

  updateSessionsList: (sessions) => {
    set({ sessions });
  },
}));
