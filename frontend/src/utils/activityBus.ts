// Module-level activity event bus.
// Sources (terminal, chat, editor) emit events; pet store subscribes.

export type ActivityEvent =
  | { type: 'terminal_data'; instanceId: string; byteCount: number }
  | { type: 'terminal_input'; instanceId: string }
  | { type: 'terminal_connect'; instanceId: string }
  | { type: 'terminal_disconnect'; instanceId: string }
  | { type: 'terminal_streaming_start'; instanceId: string }
  | { type: 'terminal_streaming_end'; instanceId: string }
  | { type: 'claude_stream_start' }
  | { type: 'claude_stream_delta' }
  | { type: 'claude_stream_end' }
  | { type: 'claude_error' }
  | { type: 'file_save'; filePath: string };

type Listener = (event: ActivityEvent) => void;
const listeners = new Set<Listener>();

export function emitActivity(event: ActivityEvent) {
  // Log non-data events (data events are too frequent)
  if (event.type !== 'terminal_data' && event.type !== 'terminal_input') {
    console.log('[ActivityBus] emit:', event.type, event);
  }
  for (const fn of listeners) fn(event);
}

export function onActivity(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
