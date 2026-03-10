import { create } from 'zustand';
import {
  type WorkspaceSession,
  type LockInfo,
  getWorkspaceSessions,
  getLatestWorkspaceSession,
  createWorkspaceSession,
  updateWorkspaceSession,
  deleteWorkspaceSession,
} from '../api/workspaceSessions';
import { getDeviceId, detectDeviceType } from '../utils/deviceId';
import { sendSyncMessage } from '../utils/syncBridge';
import { useWorkspaceStore, type WorkspaceSnapshot } from './workspaceStore';
import { useLayoutStore, type LayoutSnapshot } from './layoutStore';
import { destroyAllTerminalSessions, disconnectAllTerminalSessions } from '../components/terminal/Terminal';
import { syncThemeFromServer } from '../utils/theme';
import toast from 'react-hot-toast';

const ACTIVE_WS_KEY = 'nebulide-active-workspace';

// Track own save timestamps to avoid self-reload loops via workspace_session_changed pub/sub
let lastSaveTs = 0;

/** Returns true if this device saved the active session within the last 3s. */
export function isRecentSelfSave(): boolean {
  return Date.now() - lastSaveTs < 3000;
}

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

type LockStatus = 'free' | 'owner' | 'blocked';

interface WorkspaceSessionState {
  sessions: WorkspaceSession[];
  activeSessionId: string | null;
  loading: boolean;

  // Lock state per workspace
  lockStatus: Record<string, LockStatus>;
  lockInfo: Record<string, LockInfo>;
  showLockWarning: boolean;
  lockWarningSessionId: string | null;

  loadSessions: () => Promise<void>;
  initSession: () => Promise<void>;
  createSession: (name: string) => Promise<void>;
  switchSession: (id: string) => Promise<void>;
  saveCurrentSession: () => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  updateSessionsList: (sessions: WorkspaceSession[]) => void;

  // Sync actions
  reloadActiveSession: (opts?: { soft?: boolean }) => Promise<void>;

  // Lock actions
  setLockState: (sessionId: string, status: LockStatus, info?: LockInfo) => void;
  forceTakeover: (sessionId: string) => void;
  dismissLockWarning: () => void;
}

export const useWorkspaceSessionStore = create<WorkspaceSessionState>((set, get) => ({
  sessions: [],
  activeSessionId: localStorage.getItem(ACTIVE_WS_KEY),
  loading: false,
  lockStatus: {},
  lockInfo: {},
  showLockWarning: false,
  lockWarningSessionId: null,

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
          // Restore server snapshot for cross-device layout sync
          try {
            const snap = exists.snapshot as unknown as FullSnapshot;
            if (snap?.layout && snap?.workspace) {
              const panelIdMapping = useWorkspaceStore.getState().restoreFromSnapshot(snap.workspace);
              useLayoutStore.getState().restoreLayoutFromSnapshot(snap.layout, panelIdMapping);
            }
          } catch {
            console.warn('[WorkspaceSession] Failed to restore snapshot');
          }
          syncThemeFromServer();
          set({ loading: false });
          return;
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
    const { activeSessionId, lockStatus: ls } = get();
    if (activeSessionId === id) return;

    // If target workspace is locked by another device, show warning instead
    if (ls[id] === 'blocked') {
      set({ showLockWarning: true, lockWarningSessionId: id });
      return;
    }

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

      // Sync theme/blobs from server (cross-device sync)
      syncThemeFromServer();
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
      lastSaveTs = Date.now();
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

  // --- Sync: reload active session snapshot from server ---

  reloadActiveSession: async (opts) => {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    const soft = opts?.soft ?? false;
    try {
      const { data } = await getWorkspaceSessions();
      const fresh = data?.find((s) => s.id === activeSessionId);
      if (fresh?.snapshot) {
        const snap = fresh.snapshot as unknown as FullSnapshot;
        if (snap?.layout && snap?.workspace) {
          if (!soft) {
            // Full reload (Take Over): disconnect terminals, restore layout, then caller reconnects
            disconnectAllTerminalSessions();
          }
          const panelIdMapping = useWorkspaceStore.getState().restoreFromSnapshot(snap.workspace);
          useLayoutStore.getState().restoreLayoutFromSnapshot(snap.layout, panelIdMapping);
        }
      }
      syncThemeFromServer();
      set({ sessions: data || [] });
    } catch {
      console.warn('[WorkspaceSession] Failed to reload active session');
    }
  },

  // --- Lock actions ---

  setLockState: (sessionId, status, info) => {
    set((state) => {
      const newLockStatus = { ...state.lockStatus, [sessionId]: status };
      const newLockInfo = { ...state.lockInfo };

      if (info) {
        newLockInfo[sessionId] = info;
      } else if (status === 'free') {
        delete newLockInfo[sessionId];
      }

      // Show warning modal if the ACTIVE session is blocked
      const isActiveBlocked = status === 'blocked' && sessionId === state.activeSessionId;

      return {
        lockStatus: newLockStatus,
        lockInfo: newLockInfo,
        showLockWarning: isActiveBlocked || state.showLockWarning,
        lockWarningSessionId: isActiveBlocked ? sessionId : state.lockWarningSessionId,
      };
    });
  },

  forceTakeover: (sessionId) => {
    sendSyncMessage({
      type: 'force_takeover',
      device_id: getDeviceId(),
      device_type: detectDeviceType(),
      session_id: sessionId,
    });
    set({ showLockWarning: false, lockWarningSessionId: null });
  },

  dismissLockWarning: () => {
    set({ showLockWarning: false, lockWarningSessionId: null });
  },
}));
