import { useEffect, useRef } from 'react';
import { ensureFreshToken } from '../api/tokenRefresh';
import { useWorkspaceSessionStore, isRecentSelfSave } from '../store/workspaceSessionStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useLayoutStore } from '../store/layoutStore';
import { getWorkspaceSessions } from '../api/workspaceSessions';
import { getDeviceId, detectDeviceType } from '../utils/deviceId';
import { setSyncWs } from '../utils/syncBridge';
import { disconnectAllTerminalSessions, reconnectAllTerminalSessions } from '../components/terminal/Terminal';
import { emitActivity } from '../utils/activityBus';
import { usePetStore } from '../store/petStore';

// Re-export for backwards compat (store imports from syncBridge directly now)
export { sendSyncMessage } from '../utils/syncBridge';

export function useSyncWS() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);

  // Track active session — re-register device when workspace changes
  const activeSessionId = useWorkspaceSessionStore((s) => s.activeSessionId);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    if (wsRef.current?.readyState === WebSocket.OPEN && activeSessionId) {
      const reRegMsg = {
        type: 'device_register',
        device_id: getDeviceId(),
        device_type: detectDeviceType(),
        session_id: activeSessionId,
      };
      console.log('[SyncWS] re-register (session changed):', reRegMsg);
      wsRef.current.send(JSON.stringify(reRegMsg));
    }
  }, [activeSessionId]);

  useEffect(() => {
    let destroyed = false;

    async function connect() {
      if (destroyed) return;

      let token: string;
      try {
        token = await ensureFreshToken();
      } catch {
        reconnectTimerRef.current = window.setTimeout(connect, 5000);
        return;
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/ws/sync?token=${token}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      setSyncWs(ws);

      ws.onopen = () => {
        // Register device with current workspace
        const sessionId = activeSessionIdRef.current;
        const regMsg = {
          type: 'device_register',
          device_id: getDeviceId(),
          device_type: detectDeviceType(),
          session_id: sessionId || '',
        };
        console.log('[SyncWS] register sent:', regMsg);
        ws.send(JSON.stringify(regMsg));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          console.log('[SyncWS] received:', msg);
          const store = useWorkspaceSessionStore.getState();

          switch (msg.type) {
            case 'register_ok':
              if (msg.session_id) {
                store.setLockState(msg.session_id, 'owner');
                // Reload active session after registration.
                // On fresh page load, initSession() may have fetched stale data
                // (before force_disconnected made the other device save).
                // 1500ms delay lets the displaced device finish saving via keepalive fetch.
                setTimeout(() => {
                  store.reloadActiveSession().then(() => {
                    // Reconnect terminals — reloadActiveSession() disconnects all WS.
                    reconnectAllTerminalSessions();
                  });
                }, 1500);
              }
              // Create pets for active Claude terminals (cross-device sync)
              if (Array.isArray(msg.active_claude_terminals)) {
                for (const instanceId of msg.active_claude_terminals) {
                  emitActivity({ type: 'claude_launched', instanceId });
                }
              }
              break;

            case 'workspace_locked':
              if (msg.session_id && msg.locked_by) {
                if (msg.locked_by.device_id === getDeviceId()) {
                  store.setLockState(msg.session_id, 'owner');
                } else {
                  // Another device acquired the lock — disconnect terminals
                  disconnectAllTerminalSessions();
                  store.setLockState(msg.session_id, 'blocked', msg.locked_by);
                }
              }
              break;

            case 'workspace_unlocked':
              if (msg.session_id) {
                // Don't clear 'blocked' state — only owner losing lock → free.
                // 'blocked' is cleared by force_takeover → register_ok.
                const current = store.lockStatus[msg.session_id];
                if (current !== 'blocked') {
                  store.setLockState(msg.session_id, 'free');
                }
              }
              break;

            case 'force_disconnected':
              // Another device took over — only react if it's not us
              if (msg.locked_by?.device_id !== getDeviceId() && msg.session_id) {
                // Save current state immediately with keepalive fetch (reliable even if page is hiding)
                {
                  const activeId = store.activeSessionId;
                  if (activeId) {
                    const workspaceSnap = useWorkspaceStore.getState().getWorkspaceSnapshot();
                    const layoutSnap = useLayoutStore.getState().getLayoutSnapshot();
                    const authToken = localStorage.getItem('access_token');
                    fetch(`/api/workspace-sessions/${activeId}`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
                      body: JSON.stringify({ snapshot: { workspace: workspaceSnap, layout: layoutSnap } }),
                      keepalive: true,
                    });
                  }
                }
                // Disconnect terminal WebSockets (PTY stays alive for new device)
                disconnectAllTerminalSessions();
                store.setLockState(msg.session_id, 'blocked', msg.locked_by);
              }
              break;

            case 'claude_hook':
              // Forward Claude Code hook events to activityBus → petStore
              if (msg.event && msg.instance_id) {
                emitActivity({
                  type: 'claude_hook',
                  event: msg.event,
                  instanceId: msg.instance_id,
                  tool: msg.tool,
                  userPrompt: msg.user_prompt,
                  status: msg.status,
                });
              }
              break;

            case 'pet_event':
              // Cross-device pet sync — another device launched/disconnected Claude
              if (msg.device_id === getDeviceId()) break; // ignore own events (already handled locally)
              if (msg.pet_action === 'launched' && msg.instance_id) {
                emitActivity({ type: 'claude_launched', instanceId: msg.instance_id });
              } else if (msg.pet_action === 'disconnected' && msg.instance_id) {
                usePetStore.getState().processEvent({ type: 'terminal_disconnect', instanceId: msg.instance_id });
              }
              break;

            case 'workspace_session_changed':
              if (msg.action === 'updated' && msg.session_id === store.activeSessionId && !isRecentSelfSave()) {
                // Active session updated by another device — reload snapshot
                store.reloadActiveSession().then(() => {
                  reconnectAllTerminalSessions();
                });
              } else {
                getWorkspaceSessions().then(({ data }) => {
                  store.updateSessionsList(data || []);
                }).catch(() => { /* ignore */ });
              }
              break;
          }
        } catch { /* ignore non-JSON */ }
      };

      ws.onclose = () => {
        setSyncWs(null);
        if (!destroyed) {
          reconnectTimerRef.current = window.setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      destroyed = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setSyncWs(null);
    };
  }, []);
}
