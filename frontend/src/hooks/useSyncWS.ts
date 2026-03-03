import { useEffect, useRef } from 'react';
import { ensureFreshToken } from '../api/tokenRefresh';
import { useWorkspaceSessionStore } from '../store/workspaceSessionStore';
import { getWorkspaceSessions } from '../api/workspaceSessions';
import { getDeviceId, detectDeviceType } from '../utils/deviceId';
import { setSyncWs } from '../utils/syncBridge';

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
      wsRef.current.send(JSON.stringify({
        type: 'device_register',
        device_id: getDeviceId(),
        device_type: detectDeviceType(),
        session_id: activeSessionId,
      }));
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
        ws.send(JSON.stringify({
          type: 'device_register',
          device_id: getDeviceId(),
          device_type: detectDeviceType(),
          session_id: sessionId || '',
        }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          const store = useWorkspaceSessionStore.getState();

          switch (msg.type) {
            case 'register_ok':
              if (msg.session_id) {
                store.setLockState(msg.session_id, 'owner');
              }
              break;

            case 'workspace_locked':
              if (msg.session_id && msg.locked_by) {
                // Check if it's us (another tab) or a different device
                if (msg.locked_by.device_id === getDeviceId()) {
                  store.setLockState(msg.session_id, 'owner');
                } else {
                  store.setLockState(msg.session_id, 'blocked', msg.locked_by);
                }
              }
              break;

            case 'workspace_unlocked':
              if (msg.session_id) {
                store.setLockState(msg.session_id, 'free');
              }
              break;

            case 'force_disconnected':
              // Another device took over — only react if it's not us
              if (msg.locked_by?.device_id !== getDeviceId() && msg.session_id) {
                store.setLockState(msg.session_id, 'blocked', msg.locked_by);
              }
              break;

            case 'workspace_session_changed':
              // Existing behavior: refresh sessions list
              getWorkspaceSessions().then(({ data }) => {
                store.updateSessionsList(data || []);
              }).catch(() => { /* ignore */ });
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
