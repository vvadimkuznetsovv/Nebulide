import { useEffect, useRef } from 'react';
import { ensureFreshToken } from '../api/tokenRefresh';
import { useWorkspaceSessionStore, isRecentSelfSave } from '../store/workspaceSessionStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useLayoutStore } from '../store/layoutStore';
import { getWorkspaceSessions } from '../api/workspaceSessions';
import { getDeviceId, detectDeviceType } from '../utils/deviceId';
import { setSyncWs } from '../utils/syncBridge';
import { disconnectAllTerminalSessions, reconnectAllTerminalSessions, getActiveTerminalInstanceIds } from '../components/terminal/Terminal';
import { emitActivity } from '../utils/activityBus';
import { usePetStore } from '../store/petStore';
import { setTerminalName } from '../utils/terminalRegistry';
import { log } from '../utils/logger';

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
      log('[SyncWS] re-register (session changed):', reRegMsg);
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
        log('[SyncWS] token refresh failed, retrying in 5s');
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
        log('[SyncWS] register sent:', regMsg);
        ws.send(JSON.stringify(regMsg));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          log('[SyncWS] received:', msg);
          const store = useWorkspaceSessionStore.getState();

          switch (msg.type) {
            case 'register_ok':
              log('[SyncWS] register_ok', { session_id: msg.session_id, active_claude_terminals: msg.active_claude_terminals, activeTerminals: getActiveTerminalInstanceIds() });
              if (msg.session_id) {
                store.setLockState(msg.session_id, 'owner');
                // Reconnect terminals that were disconnected by workspace_locked/force_disconnected.
                // Soft reload — don't disconnect terminals again (they're already dead).
                log('[SyncWS] calling reconnectAllTerminalSessions from register_ok');
                reconnectAllTerminalSessions();
                setTimeout(() => {
                  store.reloadActiveSession({ soft: true, skipSave: true }).then(() => {
                    // Clean up phantom pets — terminals that exist in petStore but not
                    // in the module-level sessions Map (e.g. zombie PTY from crashed destroy)
                    const petIds = Object.keys(usePetStore.getState().pets);
                    const activeIds = getActiveTerminalInstanceIds();
                    for (const id of petIds) {
                      if (!activeIds.includes(id)) {
                        usePetStore.getState().processEvent({ type: 'terminal_disconnect', instanceId: id });
                      }
                    }
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
              log('[SyncWS] workspace_locked', { session_id: msg.session_id, locked_by: msg.locked_by, myDeviceId: getDeviceId(), isMe: msg.locked_by?.device_id === getDeviceId() });
              if (msg.session_id && msg.locked_by) {
                if (msg.locked_by.device_id === getDeviceId()) {
                  store.setLockState(msg.session_id, 'owner');
                } else {
                  // Another device acquired the lock — disconnect terminals
                  log('[SyncWS] workspace_locked by OTHER device — disconnecting all terminals');
                  disconnectAllTerminalSessions();
                  store.setLockState(msg.session_id, 'blocked', msg.locked_by);
                }
              }
              break;

            case 'workspace_unlocked':
              log('[SyncWS] workspace_unlocked', { session_id: msg.session_id, currentLock: store.lockStatus[msg.session_id] });
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
              log('[SyncWS] force_disconnected', { session_id: msg.session_id, locked_by: msg.locked_by, myDeviceId: getDeviceId(), isMe: msg.locked_by?.device_id === getDeviceId() });
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
                log('[SyncWS] force_disconnected by OTHER device — disconnecting all terminals + saving state');
                disconnectAllTerminalSessions();
                store.setLockState(msg.session_id, 'blocked', msg.locked_by);
              }
              break;

            case 'claude_hook':
              log('[SyncWS] claude_hook', { event: msg.event, instance_id: msg.instance_id, tool: msg.tool, status: msg.status });
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
              log('[SyncWS] pet_event', { pet_action: msg.pet_action, instance_id: msg.instance_id, device_id: msg.device_id, isOwnDevice: msg.device_id === getDeviceId() });
              // Cross-device pet sync — another device launched/disconnected Claude
              if (msg.device_id === getDeviceId()) break; // ignore own events (already handled locally)
              if (msg.pet_action === 'launched' && msg.instance_id) {
                emitActivity({ type: 'claude_launched', instanceId: msg.instance_id });
              } else if (msg.pet_action === 'disconnected' && msg.instance_id) {
                usePetStore.getState().processEvent({ type: 'terminal_disconnect', instanceId: msg.instance_id });
              }
              break;

            case 'terminal_rename':
              log('[SyncWS] terminal_rename', { instance_id: msg.instance_id, name: msg.name, device_id: msg.device_id, isOwnDevice: msg.device_id === getDeviceId() });
              // Cross-device terminal rename sync
              if (msg.device_id !== getDeviceId() && msg.instance_id && typeof msg.name === 'string') {
                setTerminalName(msg.instance_id, msg.name);
              }
              break;

            case 'workspace_session_changed':
              log('[Sync] workspace_session_changed', {
                action: msg.action,
                session_id: msg.session_id,
                activeSessionId: store.activeSessionId,
                isRecentSelfSave: isRecentSelfSave(),
                device_id: msg.device_id,
              });
              // NEVER reload active session from workspace_session_changed —
              // it causes ping-pong loop (restore→store change→save→broadcast→restore).
              // Cross-device layout sync happens ONLY via visibilitychange (tab focus).
              {
                getWorkspaceSessions().then(({ data }) => {
                  store.updateSessionsList(data || []);
                }).catch(() => { /* ignore */ });
              }
              break;
          }
        } catch { /* ignore non-JSON */ }
      };

      ws.onclose = (e) => {
        log(`[SyncWS] ws.onclose code=${e.code} reason=${e.reason} destroyed=${destroyed}`);
        setSyncWs(null);
        if (!destroyed) {
          log('[SyncWS] scheduling reconnect in 3s');
          reconnectTimerRef.current = window.setTimeout(connect, 3000);
        }
      };

      ws.onerror = (ev) => {
        console.error('[SyncWS] ws.onerror', ev);
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
