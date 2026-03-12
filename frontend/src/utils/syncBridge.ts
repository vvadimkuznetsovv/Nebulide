// Bridge module to avoid circular dependency between useSyncWS ↔ workspaceSessionStore.
// useSyncWS sets the WS reference; workspaceSessionStore calls sendSyncMessage.
import { log, warn } from './logger';

let syncWs: WebSocket | null = null;

export function setSyncWs(ws: WebSocket | null) {
  log('[SyncBridge] setSyncWs', ws ? 'connected' : 'null');
  syncWs = ws;
}

export function sendSyncMessage(msg: Record<string, unknown>) {
  if (syncWs?.readyState === WebSocket.OPEN) {
    log('[SyncBridge] send:', msg);
    syncWs.send(JSON.stringify(msg));
  } else {
    warn('[SyncBridge] send DROPPED (ws not open):', msg);
  }
}
