// Module-level activity event bus.
// Sources (terminal, chat, editor) emit events; pet store subscribes.

export type ActivityEvent =
  | { type: 'terminal_data'; instanceId: string; byteCount: number }
  | { type: 'terminal_input'; instanceId: string }
  | { type: 'terminal_connect'; instanceId: string }
  | { type: 'terminal_disconnect'; instanceId: string }
  | { type: 'claude_stream_start' }
  | { type: 'claude_stream_delta' }
  | { type: 'claude_stream_end' }
  | { type: 'file_save'; filePath: string };

type Listener = (event: ActivityEvent) => void;
const listeners = new Set<Listener>();

export function emitActivity(event: ActivityEvent) {
  for (const fn of listeners) fn(event);
}

export function onActivity(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
