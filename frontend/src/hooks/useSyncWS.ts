import { useEffect, useRef } from 'react';
import { ensureFreshToken } from '../api/tokenRefresh';
import { useWorkspaceSessionStore } from '../store/workspaceSessionStore';
import { getWorkspaceSessions } from '../api/workspaceSessions';

export function useSyncWS() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let destroyed = false;

    async function connect() {
      if (destroyed) return;

      let token: string;
      try {
        token = await ensureFreshToken();
      } catch {
        // Retry after delay
        reconnectTimerRef.current = window.setTimeout(connect, 5000);
        return;
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/ws/sync?token=${token}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'workspace_session_changed') {
            // Refresh the sessions list
            getWorkspaceSessions().then(({ data }) => {
              useWorkspaceSessionStore.getState().updateSessionsList(data || []);
            }).catch(() => { /* ignore */ });
          }
        } catch { /* ignore non-JSON */ }
      };

      ws.onclose = () => {
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
    };
  }, []);
}
