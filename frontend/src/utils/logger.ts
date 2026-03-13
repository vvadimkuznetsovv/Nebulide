// Centralized debug logger with enable/disable toggle.
// All debug logging across the app goes through this module.
// Controlled via Settings → "Debug logging" toggle.
// Errors (console.error) are NEVER suppressed.

const STORAGE_KEY = 'nebulide-debug-logging';

let _enabled: boolean = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
})();

/** Check if debug logging is currently enabled */
export function isLoggingEnabled(): boolean {
  return _enabled;
}

/** Toggle debug logging on/off. Persists to localStorage. */
export function setLoggingEnabled(on: boolean): void {
  _enabled = on;
  try {
    if (on) {
      localStorage.setItem(STORAGE_KEY, '1');
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch { /* ignore */ }
}

// ── Remote log buffer — batches and sends to /api/logs every 2s ──
let _remoteBuffer: string[] = [];
let _remoteTimer: ReturnType<typeof setTimeout> | null = null;

function flushRemoteLogs() {
  _remoteTimer = null;
  if (_remoteBuffer.length === 0) return;
  const lines = _remoteBuffer;
  _remoteBuffer = [];
  const token = localStorage.getItem('nebulide-token') || '';
  fetch('/api/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ lines }),
  }).catch(() => { /* ignore */ });
}

function sendRemote(level: string, args: unknown[]) {
  try {
    const msg = args.map(a =>
      typeof a === 'string' ? a : JSON.stringify(a)
    ).join(' ');
    _remoteBuffer.push(`[${level}] ${msg}`);
    if (!_remoteTimer) {
      _remoteTimer = setTimeout(flushRemoteLogs, 2000);
    }
  } catch { /* ignore */ }
}

/** Debug log — only outputs when logging is enabled */
export function log(...args: unknown[]): void {
  if (_enabled) {
    console.log(...args);
    sendRemote('LOG', args);
  }
}

/** Debug warn — only outputs when logging is enabled */
export function warn(...args: unknown[]): void {
  if (_enabled) {
    console.warn(...args);
    sendRemote('WARN', args);
  }
}

/** Error — ALWAYS outputs (never suppressed) */
export function error(...args: unknown[]): void {
  console.error(...args);
  sendRemote('ERROR', args);
}
