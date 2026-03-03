// Bridge module to avoid circular dependency between useSyncWS ↔ workspaceSessionStore.
// useSyncWS sets the WS reference; workspaceSessionStore calls sendSyncMessage.

let syncWs: WebSocket | null = null;

export function setSyncWs(ws: WebSocket | null) {
  syncWs = ws;
}

export function sendSyncMessage(msg: Record<string, unknown>) {
  if (syncWs?.readyState === WebSocket.OPEN) {
    syncWs.send(JSON.stringify(msg));
  }
}
