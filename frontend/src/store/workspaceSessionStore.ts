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
import { log, warn } from '../utils/logger';
import { getDeviceId, detectDeviceType } from '../utils/deviceId';
import { sendSyncMessage } from '../utils/syncBridge';
import { useWorkspaceStore, type WorkspaceSnapshot } from './workspaceStore';
import { useLayoutStore, type LayoutSnapshot } from './layoutStore';
import { destroyAllTerminalSessions, disconnectAllTerminalSessions } from '../components/terminal/Terminal';
import { clearClosedTerminals } from '../utils/terminalRegistry';
import { syncThemeFromServer } from '../utils/theme';
import toast from 'react-hot-toast';

const ACTIVE_WS_KEY = 'nebulide-active-workspace';

// Track own save timestamps to avoid self-reload loops via workspace_session_changed pub/sub
let lastSaveTs = 0;

/** Returns true if this device saved the active session within the last 3s. */
export function isRecentSelfSave(): boolean {
  return Date.now() - lastSaveTs < 3000;
}

/** True while restoreFromSnapshot is running — suppresses auto-save in Workspace.tsx subscribe. */
let _restoringSnapshot = false;
export function isRestoringSnapshot(): boolean { return _restoringSnapshot; }

/** Track when page was last visible — stale background tabs don't overwrite fresh data. */
let _lastVisibleAt = Date.now();
export function markVisible() { _lastVisibleAt = Date.now(); }

/** Synchronous keepalive save — works during beforeunload/pagehide/visibilitychange:hidden. */
export function forceSaveSnapshot() {
  const state = useWorkspaceSessionStore.getState();
  const activeId = state.activeSessionId;
  if (!activeId) return;
  // Don't save from stale background tab (hidden > 10s)
  if (Date.now() - _lastVisibleAt > 10_000) return;
  // Don't overwrite if another device owns the session
  if (state.lockStatus[activeId] === 'blocked') return;

  const workspaceSnap = useWorkspaceStore.getState().getWorkspaceSnapshot();
  const layoutSnap = useLayoutStore.getState().getLayoutSnapshot();
  const token = localStorage.getItem('access_token');
  lastSaveTs = Date.now();
  fetch(`/api/workspace-sessions/${activeId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ snapshot: { workspace: workspaceSnap, layout: layoutSnap } }),
    keepalive: true,
  });
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
  reloadActiveSession: (opts?: { soft?: boolean; skipSave?: boolean }) => Promise<void>;

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
    // Block saves while loading + restoring server snapshot.
    // Prevents Workspace.tsx subscribe callbacks from saving stale localStorage
    // data to server before server restore completes.
    _restoringSnapshot = true;

    const unblock = () => { _restoringSnapshot = false; };

    try {
      await state.loadSessions();
      const { sessions, activeSessionId } = get();

      // If we have a saved active session ID, check if it still exists
      if (activeSessionId) {
        const exists = sessions.find((s) => s.id === activeSessionId);
        if (exists) {
          // Always restore from server — it's the source of truth
          try {
            const snap = exists.snapshot as unknown as FullSnapshot;
            if (snap?.layout && snap?.workspace) {
              log('[WorkspaceSession] initSession: restoring from server');
              const panelIdMapping = useWorkspaceStore.getState().restoreFromSnapshot(snap.workspace);
              useLayoutStore.getState().restoreLayoutFromSnapshot(snap.layout, panelIdMapping);
              unblock();
            } else {
              _restoringSnapshot = false;
            }
          } catch {
            _restoringSnapshot = false;
            warn('[WorkspaceSession] Failed to restore snapshot');
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
          try {
            const snap = data.snapshot as unknown as FullSnapshot;
            if (snap?.layout && snap?.workspace) {
              log('[WorkspaceSession] initSession: restoring from latest server session');
              const panelIdMapping = useWorkspaceStore.getState().restoreFromSnapshot(snap.workspace);
              useLayoutStore.getState().restoreLayoutFromSnapshot(snap.layout, panelIdMapping);
              unblock();
            } else {
              _restoringSnapshot = false;
            }
          } catch {
            _restoringSnapshot = false;
            warn('[WorkspaceSession] Failed to restore snapshot, using default layout');
          }
          return;
        } catch {
          const first = sessions[0];
          localStorage.setItem(ACTIVE_WS_KEY, first.id);
          set({ activeSessionId: first.id, loading: false });
          _restoringSnapshot = false;
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
      _restoringSnapshot = false;
    } catch {
      _restoringSnapshot = false;
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
      clearClosedTerminals();

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
        warn('[WorkspaceSession] Failed to restore snapshot, resetting layout');
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

    log('[WorkspaceSession] saveCurrentSession EXECUTING', { activeSessionId, stack: new Error().stack?.split('\n').slice(1, 4).join(' ← ') });
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
    const { activeSessionId, lockStatus } = get();
    if (!activeSessionId) return;
    const soft = opts?.soft ?? false;

    // Don't restore layout on a blocked device — it would reconnect terminals
    // that belong to the active device. Only sync theme.
    if (soft && lockStatus[activeSessionId] === 'blocked') {
      syncThemeFromServer();
      return;
    }

    try {
      // Save current state before fetching — prevents stale snapshot from
      // overwriting recent changes (e.g. just-closed terminals).
      // skipSave: true when triggered by workspace_session_changed — prevents
      // ping-pong loop (reload→save→broadcast→other device reload→save→...)
      if (!opts?.skipSave) {
        try { await get().saveCurrentSession(); } catch { /* ignore */ }
      }

      const { data } = await getWorkspaceSessions();
      const fresh = data?.find((s) => s.id === activeSessionId);
      if (fresh?.snapshot) {
        const snap = fresh.snapshot as unknown as FullSnapshot;
        if (snap?.layout && snap?.workspace) {
          if (!soft) {
            // Full reload (Take Over): disconnect terminals, restore layout, then caller reconnects
            disconnectAllTerminalSessions();
          }
          _restoringSnapshot = true;
          try {
            const panelIdMapping = useWorkspaceStore.getState().restoreFromSnapshot(snap.workspace);
            useLayoutStore.getState().restoreLayoutFromSnapshot(snap.layout, panelIdMapping);
          } finally {
            _restoringSnapshot = false;
          }
        }
      }
      syncThemeFromServer();
      set({ sessions: data || [] });
    } catch {
      warn('[WorkspaceSession] Failed to reload active session');
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
