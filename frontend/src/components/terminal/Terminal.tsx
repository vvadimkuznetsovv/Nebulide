import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import ContextMenu, { type ContextMenuItem } from '../files/ContextMenu';
import { useLongPress } from '../../hooks/useLongPress';
import { ensureFreshToken } from '../../api/tokenRefresh';
import toast from 'react-hot-toast';

// ── Clipboard helper: first readText() on mobile may fail (permission not yet initialized) ──

async function clipboardReadWithRetry(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    await new Promise(r => setTimeout(r, 100));
    return navigator.clipboard.readText();
  }
}

// ── Font size persistence ──

const FONT_SIZE_KEY = 'nebulide-terminal-font-size';
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 24;

function getSavedFontSize(): number {
  const saved = parseInt(localStorage.getItem(FONT_SIZE_KEY) || '', 10);
  return saved >= MIN_FONT_SIZE && saved <= MAX_FONT_SIZE ? saved : DEFAULT_FONT_SIZE;
}

// ── Per-instance sessions: xterm lives until explicitly destroyed ──
// Module-level Map — survives any React remount (layout changes, tab switches).
// Each terminal instance (identified by instanceId) has its own xterm + WebSocket.

interface TermSession {
  xterm: XTerm;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  container: HTMLDivElement | null;
  ws: WebSocket | null;
  reconnectTimer: number | null;
  reconnectAttempts: number;
  notifyRerender: (() => void) | null;
}

const sessions = new Map<string, TermSession>();

const MAX_RECONNECT = 5;
const RECONNECT_DELAY = 800;

/** Unique ID per browser tab — so two tabs/devices get separate PTY sessions */
function getTabSessionId(): string {
  let id = sessionStorage.getItem('nebulide-tab-id');
  if (!id) {
    id = Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('nebulide-tab-id', id);
  }
  return id;
}

function createXterm(instanceId: string): TermSession {
  console.log(`[Terminal] createXterm id=${instanceId}`);
  const fontSize = getSavedFontSize();

  // Create session object first so onData can close over session.ws
  const session: TermSession = {
    xterm: null!,
    fitAddon: null!,
    searchAddon: null!,
    container: null,
    ws: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    notifyRerender: null,
  };

  const xterm = new XTerm({
    cursorBlink: true,
    cursorStyle: 'bar',
    fontSize,
    scrollback: 5000,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    theme: {
      background: '#0a0a1a',
      foreground: 'rgba(255, 255, 255, 0.9)',
      cursor: '#6eb4ff',
      cursorAccent: '#0a0a1a',
      selectionBackground: 'rgba(110, 180, 255, 0.25)',
      selectionForeground: '#ffffff',
      black: '#484f58',
      red: '#f87171',
      green: '#4ade80',
      yellow: '#fbbf24',
      blue: '#6eb4ff',
      magenta: '#a78bfa',
      cyan: '#22d3ee',
      white: '#e2e8f0',
      brightBlack: '#6e7681',
      brightRed: '#fca5a5',
      brightGreen: '#86efac',
      brightYellow: '#fde68a',
      brightBlue: '#93c5fd',
      brightMagenta: '#c4b5fd',
      brightCyan: '#67e8f9',
      brightWhite: '#f8fafc',
    },
  });

  const fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.loadAddon(new WebLinksAddon());

  const searchAddon = new SearchAddon();
  xterm.loadAddon(searchAddon);

  // onData closes over session.ws (mutable field on the session object)
  xterm.onData((data) => {
    if (session.ws?.readyState === WebSocket.OPEN) {
      session.ws.send(new TextEncoder().encode(data));
    }
  });

  session.xterm = xterm;
  session.fitAddon = fitAddon;
  session.searchAddon = searchAddon;

  sessions.set(instanceId, session);
  return session;
}

// ANSI color helpers for in-terminal diagnostics
const _blue = (s: string) => `\x1b[38;2;110;180;255m${s}\x1b[0m`;
const _green = (s: string) => `\x1b[38;2;74;222;128m${s}\x1b[0m`;
const _yellow = (s: string) => `\x1b[38;2;251;191;36m${s}\x1b[0m`;
const _red = (s: string) => `\x1b[38;2;248;113;113m${s}\x1b[0m`;

async function connectWs(instanceId: string): Promise<void> {
  const session = sessions.get(instanceId);
  if (!session) return;

  session.xterm.write(_blue('[WS] Getting token...') + '\r\n');

  const token = await ensureFreshToken();
  if (!token) {
    console.warn(`[Terminal] connectWs SKIP — no access_token id=${instanceId}`);
    session.xterm.write(_red('[WS] No access token! Login required.') + '\r\n');
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const tabId = getTabSessionId();
  const wsInstanceId = `${instanceId}@${tabId}`;
  const url = `${protocol}//${window.location.host}/ws/terminal?token=${token}&instanceId=${encodeURIComponent(wsInstanceId)}`;
  const safeUrl = url.replace(/token=[^&]+/, 'token=***');
  session.xterm.write(_blue(`[WS] Connecting ${safeUrl}`) + '\r\n');
  console.log(`[Terminal] connectWs id=${instanceId} attempt=${session.reconnectAttempts} url=${safeUrl}`);

  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  session.ws = ws;

  let opened = false;

  ws.onopen = () => {
    opened = true;
    session.xterm.write(_green('[WS] Connected!') + '\r\n');
    console.log(`[Terminal] ws.onopen id=${instanceId}`);
    session.reconnectAttempts = 0;
    try {
      session.fitAddon.fit();
      const dims = session.fitAddon.proposeDimensions();
      if (dims) {
        ws.send(JSON.stringify({ type: 'resize', rows: dims.rows, cols: dims.cols }));
      }
    } catch { /* xterm may not be attached yet */ }
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      session.xterm.write(new Uint8Array(event.data));
    } else {
      session.xterm.write(event.data);
    }
  };

  ws.onerror = (e) => {
    session.xterm.write(_red('[WS] Connection error!') + '\r\n');
    console.warn(`[Terminal] ws.onerror id=${instanceId}`, e);
  };

  ws.onclose = (e) => {
    const info = `code=${e.code} reason=${e.reason || 'none'} opened=${opened}`;
    session.xterm.write(_yellow(`[WS] Closed ${info}`) + '\r\n');
    console.log(`[Terminal] ws.onclose id=${instanceId} ${info} session.ws===ws:${session.ws === ws} inMap:${sessions.has(instanceId)}`);

    // WS was superseded by a newer connection — don't reconnect
    if (session.ws !== ws) {
      console.log(`[Terminal] ws.onclose IGNORED (superseded) id=${instanceId}`);
      return;
    }
    session.ws = null;

    // Connection was rejected before opening (401, network error) — don't reconnect
    if (!opened) {
      console.log(`[Terminal] ws.onclose REJECTED (never opened) id=${instanceId}`);
      session.xterm.write(_red('[Connection rejected — check auth/backend]') + '\r\n');
      session.xterm.write(_blue('[Right-click \u2192 Reconnect]') + '\r\n');
      session.notifyRerender?.();
      return;
    }

    if (!sessions.has(instanceId)) return; // session was destroyed

    if (session.reconnectAttempts < MAX_RECONNECT) {
      session.reconnectAttempts++;
      session.xterm.write(_yellow(`[Shell exited \u2014 reconnecting ${session.reconnectAttempts}/${MAX_RECONNECT}...]`) + '\r\n');
      session.reconnectTimer = window.setTimeout(() => {
        session.reconnectTimer = null;
        if (sessions.has(instanceId)) connectWs(instanceId);
      }, RECONNECT_DELAY);
    } else {
      session.xterm.write(_red('[Disconnected — max retries reached]') + '\r\n');
      session.xterm.write(_blue('[Right-click \u2192 Reconnect]') + '\r\n');
      session.reconnectAttempts = 0;
    }
    session.notifyRerender?.();
  };
}

function forceReconnect(instanceId: string): void {
  const session = sessions.get(instanceId);
  if (!session) {
    console.error(`[Terminal] forceReconnect: NO SESSION for id=${instanceId}`);
    return;
  }

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
  if (session.ws) {
    session.ws.close();
    session.ws = null;
  }
  session.reconnectAttempts = 0;
  session.xterm.write('\r\n\x1b[38;2;110;180;255m[Reconnecting...]\x1b[0m\r\n');
  connectWs(instanceId);
}

function getOrCreateSession(instanceId: string): TermSession {
  let session = sessions.get(instanceId);
  const existed = !!session;
  if (!session) {
    session = createXterm(instanceId);
    session.xterm.write(_blue(`[Terminal] Session created id=${instanceId}`) + '\r\n');
  }
  const wsState = session.ws ? ['CONNECTING','OPEN','CLOSING','CLOSED'][session.ws.readyState] : 'null';
  console.log(`[Terminal] getOrCreateSession id=${instanceId} existed=${existed} wsState=${wsState}`);
  session.xterm.write(_blue(`[Terminal] getOrCreate existed=${existed} wsState=${wsState}`) + '\r\n');
  if (!session.ws || session.ws.readyState > WebSocket.OPEN) {
    connectWs(instanceId);
  }
  return session;
}

/** Destroy a terminal session: close WS, dispose xterm, remove from Map.
 *  Called by layoutStore when a detached terminal panel is closed. */
export function destroyTerminalSession(instanceId: string): void {
  const session = sessions.get(instanceId);
  console.log(`[Terminal] destroyTerminalSession id=${instanceId} exists=${!!session}`);
  if (!session) return;

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
  if (session.ws) {
    session.ws.close();
    session.ws = null;
  }
  session.xterm.dispose();
  sessions.delete(instanceId);
}

// ── React component ──

interface TerminalProps {
  instanceId: string;
  active?: boolean;
  /** If true, do NOT destroy the xterm session on unmount.
   *  Use for the base 'terminal' panel which is toggled visible/hidden. */
  persistent?: boolean;
}

// Feather-style SVG icons (14x14)
const TERM_ICONS = {
  copy: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  ),
  clipboard: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
    </svg>
  ),
  selectAll: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><path d="M9 12l2 2 4-4" />
    </svg>
  ),
  search: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  zoomIn: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  ),
  zoomOut: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  ),
  trash: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  ),
  refresh: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  ),
  eraser: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 20H7L3 16a1 1 0 0 1 0-1.4l9.6-9.6a2 2 0 0 1 2.8 0l5.2 5.2a2 2 0 0 1 0 2.8L15 18.6" /><path d="M6.5 13.5L12 8" />
    </svg>
  ),
};

// ── Mobile toolbar: shortcut keys for touch devices ──

const TOOLBAR_KEYS: { label: string; data: string }[] = [
  { label: 'Tab', data: '\t' },
  { label: '\u2191', data: '\x1b[A' },
  { label: '\u2193', data: '\x1b[B' },
  { label: '\u2190', data: '\x1b[D' },
  { label: '\u2192', data: '\x1b[C' },
  { label: 'C-c', data: '\x03' },
  { label: 'C-d', data: '\x04' },
  { label: 'C-z', data: '\x1a' },
  { label: 'C-l', data: '\x0c' },
];

export default function TerminalComponent({ instanceId, active, persistent }: TerminalProps) {
  const termRef = useRef<HTMLDivElement>(null);
  // Store persistent/instanceId in refs to access stable values in cleanup
  const persistentRef = useRef(persistent);
  const instanceIdRef = useRef(instanceId);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [, setTick] = useState(0);
  const [toolbarOpen, setToolbarOpen] = useState(() =>
    localStorage.getItem('nebulide-terminal-toolbar') !== 'closed',
  );
  const [copyMode, setCopyMode] = useState(false);
  const [row2Open, setRow2Open] = useState(() =>
    localStorage.getItem('nebulide-terminal-toolbar-r2') !== 'closed',
  );
  const selRef = useRef({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });

  // Long-press for mobile context menu
  const { handlers: longPressHandlers } = useLongPress({
    onLongPress: (x, y) => setCtxMenu({ x, y }),
  });

  const fit = useCallback(() => {
    const s = sessions.get(instanceId);
    if (!s) return;
    try {
      s.fitAddon.fit();
      const dims = s.fitAddon.proposeDimensions();
      if (dims && s.ws?.readyState === WebSocket.OPEN) {
        s.ws.send(JSON.stringify({ type: 'resize', rows: dims.rows, cols: dims.cols }));
      }
    } catch { /* ignore */ }
  }, [instanceId]);

  useEffect(() => {
    const el = termRef.current;
    if (!el) return;

    console.log(`[Terminal] useEffect MOUNT id=${instanceId} persistent=${persistent}`);
    const s = getOrCreateSession(instanceId);

    // Register re-render notifier
    s.notifyRerender = () => setTick((t) => t + 1);

    // Attach xterm to this DOM element (re-attach if container changed)
    if (s.container !== el) {
      if (s.container && s.xterm.element) {
        // Move xterm's own element directly into the new container.
        // Moving parentElement would nest old container inside new one,
        // breaking FitAddon (it reads dimensions from xterm.element.parentElement).
        el.appendChild(s.xterm.element);
      } else {
        s.xterm.open(el);
      }
      s.container = el;
    }

    setTimeout(fit, 50);

    let rafId = 0;
    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => fit());
    });
    resizeObserver.observe(el);

    // Reconnect when page becomes visible (phone woke from sleep/background).
    // setTimeout timers are frozen during background — this ensures immediate reconnect.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const sess = sessions.get(instanceId);
        if (sess && (!sess.ws || sess.ws.readyState > WebSocket.OPEN)) {
          sess.reconnectAttempts = 0; // reset — this is a fresh wake
          connectWs(instanceId);
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      console.log(`[Terminal] useEffect CLEANUP id=${instanceIdRef.current} persistent=${persistentRef.current}`);
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      // Destroy session on unmount only for non-persistent (detached) terminals
      if (!persistentRef.current) {
        destroyTerminalSession(instanceIdRef.current);
      }
    };
  // fit intentionally excluded: instanceId change re-runs the effect, fit is stable
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  useEffect(() => {
    if (active) setTimeout(fit, 50);
  }, [active, fit]);

  // ── Touch scroll (swipe up/down to scroll terminal output) ──
  useEffect(() => {
    const el = termRef.current;
    if (!el) return;
    let startY = 0;
    const onTouchStart = (e: TouchEvent) => { startY = e.touches[0].clientY; };
    const onTouchMove = (e: TouchEvent) => {
      const s = sessions.get(instanceId);
      if (!s) return;
      const deltaY = startY - e.touches[0].clientY;
      const lineH = (s.xterm.options.fontSize || DEFAULT_FONT_SIZE) * 1.2;
      const lines = Math.round(deltaY / lineH);
      if (lines !== 0) {
        s.xterm.scrollLines(lines);
        startY = e.touches[0].clientY;
        e.preventDefault();
      }
    };
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
    };
  }, [instanceId]);

  // ── Context menu ──

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleCtxAction = useCallback((action: string) => {
    setCtxMenu(null);
    const s = sessions.get(instanceId);

    switch (action) {
      case 'copy': {
        const sel = s?.xterm.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel)
            .then(() => toast.success('Copied'))
            .catch(() => toast.error('Failed to copy'));
        }
        break;
      }
      case 'paste':
        clipboardReadWithRetry()
          .then((text) => {
            if (!s?.ws || s.ws.readyState !== WebSocket.OPEN) {
              toast.error('Terminal disconnected');
              return;
            }
            if (text) s.ws.send(new TextEncoder().encode(text));
          })
          .catch(() => toast.error('Failed to paste'));
        break;
      case 'select-all':
        s?.xterm.selectAll();
        break;
      case 'find':
        setSearchVisible(true);
        break;
      case 'font-increase': {
        if (!s) break;
        const cur = s.xterm.options.fontSize || DEFAULT_FONT_SIZE;
        const next = Math.min(cur + 1, MAX_FONT_SIZE);
        s.xterm.options.fontSize = next;
        localStorage.setItem(FONT_SIZE_KEY, String(next));
        fit();
        break;
      }
      case 'font-decrease': {
        if (!s) break;
        const cur = s.xterm.options.fontSize || DEFAULT_FONT_SIZE;
        const next = Math.max(cur - 1, MIN_FONT_SIZE);
        s.xterm.options.fontSize = next;
        localStorage.setItem(FONT_SIZE_KEY, String(next));
        fit();
        break;
      }
      case 'clear':
        // ANSI: clear screen + cursor home (visual clear, keeps scrollback)
        s?.xterm.write('\x1b[2J\x1b[H');
        break;
      case 'clear-all':
        // Clear scrollback but keep current viewport (preserves prompt)
        s?.xterm.clear();
        break;
      case 'reconnect':
        forceReconnect(instanceId);
        break;
    }
  }, [instanceId, fit]);

  // ── Search ──

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearchTerm(val);
    const s = sessions.get(instanceId);
    if (val) s?.searchAddon.findNext(val);
  }, [instanceId]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    const s = sessions.get(instanceId);
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) s?.searchAddon.findPrevious(searchTerm);
      else s?.searchAddon.findNext(searchTerm);
    }
    if (e.key === 'Escape') {
      setSearchVisible(false);
      setSearchTerm('');
      s?.searchAddon.clearDecorations();
    }
  }, [instanceId, searchTerm]);

  const closeSearch = useCallback(() => {
    setSearchVisible(false);
    setSearchTerm('');
    sessions.get(instanceId)?.searchAddon.clearDecorations();
  }, [instanceId]);

  const sendKey = useCallback((data: string) => {
    const s = sessions.get(instanceId);
    if (s?.ws?.readyState === WebSocket.OPEN) {
      s.ws.send(new TextEncoder().encode(data));
    }
  }, [instanceId]);

  const pasteToTerminal = useCallback(() => {
    const s = sessions.get(instanceId);
    clipboardReadWithRetry()
      .then((text) => {
        if (!s?.ws || s.ws.readyState !== WebSocket.OPEN) {
          toast.error('Terminal disconnected');
          return;
        }
        if (text) s.ws.send(new TextEncoder().encode(text));
      })
      .catch(() => toast.error('Failed to paste'));
  }, [instanceId]);

  const copyTermSelection = useCallback(() => {
    const s = sessions.get(instanceId);
    const sel = s?.xterm.getSelection();
    if (sel) {
      navigator.clipboard.writeText(sel)
        .then(() => toast.success('Copied'))
        .catch(() => toast.error('Failed to copy'));
    }
  }, [instanceId]);

  /** Copy last N lines from terminal buffer (0 = all) */
  const copyLines = useCallback((n: number) => {
    const s = sessions.get(instanceId);
    if (!s) return;
    const buf = s.xterm.buffer.active;
    const total = buf.length;
    const start = n > 0 ? Math.max(0, total - n) : 0;
    const lines: string[] = [];
    for (let i = start; i < total; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    const text = lines.join('\n');
    if (text) {
      navigator.clipboard.writeText(text)
        .then(() => toast.success(`Copied ${lines.length} lines`))
        .catch(() => toast.error('Failed to copy'));
    }
  }, [instanceId]);

  // ── Copy mode (row 3) — character-level selection via buttons ──

  /** Apply selection from selRef coordinates using xterm.select(col, row, length) */
  const applySelection = useCallback(() => {
    const s = sessions.get(instanceId);
    if (!s) return;
    const buf = s.xterm.buffer.active;
    const sel = selRef.current;
    // Compute total character length from (startRow,startCol) to (endRow,endCol)
    let len: number;
    if (sel.startRow === sel.endRow) {
      len = Math.max(0, sel.endCol - sel.startCol);
    } else {
      len = (buf.getLine(sel.startRow)?.translateToString(true).length ?? 0) - sel.startCol;
      for (let r = sel.startRow + 1; r < sel.endRow; r++) {
        len += buf.getLine(r)?.translateToString(true).length ?? 0;
      }
      len += sel.endCol;
    }
    if (len > 0) {
      s.xterm.select(sel.startCol, sel.startRow, Math.max(1, len));
    }
  }, [instanceId]);

  /** Get line length for a buffer row */
  const getLineLen = useCallback((row: number) => {
    const s = sessions.get(instanceId);
    if (!s) return 0;
    return s.xterm.buffer.active.getLine(row)?.translateToString(true).length ?? 0;
  }, [instanceId]);

  const toggleCopyMode = useCallback(() => {
    setCopyMode((prev) => {
      if (prev) {
        sessions.get(instanceId)?.xterm.clearSelection();
        return false;
      }
      const s = sessions.get(instanceId);
      if (!s) return false;
      const buf = s.xterm.buffer.active;
      let lastLine = buf.length - 1;
      while (lastLine > 0) {
        const line = buf.getLine(lastLine);
        if (line && line.translateToString(true).trim() !== '') break;
        lastLine--;
      }
      const lineLen = buf.getLine(lastLine)?.translateToString(true).length ?? 0;
      selRef.current = { startRow: lastLine, startCol: 0, endRow: lastLine, endCol: lineLen };
      s.xterm.selectLines(lastLine, lastLine);
      s.xterm.scrollToLine(lastLine);
      return true;
    });
  }, [instanceId]);

  /** Move selection boundary by line (row delta) */
  const moveSelRow = useCallback((boundary: 'start' | 'end', delta: number) => {
    const s = sessions.get(instanceId);
    if (!s) return;
    const buf = s.xterm.buffer.active;
    const maxLine = buf.length - 1;
    const sel = selRef.current;
    if (boundary === 'start') {
      sel.startRow = Math.max(0, Math.min(maxLine, sel.startRow + delta));
      sel.startCol = 0;
      if (sel.startRow > sel.endRow) {
        sel.endRow = sel.startRow;
        sel.endCol = getLineLen(sel.endRow);
      }
    } else {
      sel.endRow = Math.max(0, Math.min(maxLine, sel.endRow + delta));
      sel.endCol = getLineLen(sel.endRow);
      if (sel.endRow < sel.startRow) {
        sel.startRow = sel.endRow;
        sel.startCol = 0;
      }
    }
    applySelection();
    s.xterm.scrollToLine(boundary === 'start' ? sel.startRow : sel.endRow);
  }, [instanceId, applySelection, getLineLen]);

  /** Move selection boundary by character (col delta) */
  const moveSelCol = useCallback((boundary: 'start' | 'end', delta: number) => {
    const s = sessions.get(instanceId);
    if (!s) return;
    const buf = s.xterm.buffer.active;
    const maxLine = buf.length - 1;
    const sel = selRef.current;
    if (boundary === 'start') {
      sel.startCol += delta;
      // Wrap to previous/next line
      if (sel.startCol < 0 && sel.startRow > 0) {
        sel.startRow--;
        sel.startCol = getLineLen(sel.startRow);
      } else if (sel.startCol > getLineLen(sel.startRow) && sel.startRow < maxLine) {
        sel.startRow++;
        sel.startCol = 0;
      }
      sel.startCol = Math.max(0, Math.min(getLineLen(sel.startRow), sel.startCol));
      // Keep start <= end
      if (sel.startRow > sel.endRow || (sel.startRow === sel.endRow && sel.startCol > sel.endCol)) {
        sel.endRow = sel.startRow;
        sel.endCol = sel.startCol;
      }
    } else {
      sel.endCol += delta;
      if (sel.endCol < 0 && sel.endRow > 0) {
        sel.endRow--;
        sel.endCol = getLineLen(sel.endRow);
      } else if (sel.endCol > getLineLen(sel.endRow) && sel.endRow < maxLine) {
        sel.endRow++;
        sel.endCol = 0;
      }
      sel.endCol = Math.max(0, Math.min(getLineLen(sel.endRow), sel.endCol));
      // Keep end >= start
      if (sel.endRow < sel.startRow || (sel.endRow === sel.startRow && sel.endCol < sel.startCol)) {
        sel.startRow = sel.endRow;
        sel.startCol = sel.endCol;
      }
    }
    applySelection();
    s.xterm.scrollToLine(boundary === 'start' ? sel.startRow : sel.endRow);
  }, [instanceId, applySelection, getLineLen]);

  const copySelection = useCallback(() => {
    const s = sessions.get(instanceId);
    if (!s) return;
    const sel = s.xterm.getSelection();
    if (sel) {
      navigator.clipboard.writeText(sel)
        .then(() => toast.success('Copied'))
        .catch(() => toast.error('Failed to copy'));
    }
  }, [instanceId]);

  const selectAllLines = useCallback(() => {
    const s = sessions.get(instanceId);
    if (!s) return;
    s.xterm.selectAll();
    const buf = s.xterm.buffer.active;
    const lastLine = buf.length - 1;
    selRef.current = { startRow: 0, startCol: 0, endRow: lastLine, endCol: getLineLen(lastLine) };
  }, [instanceId, getLineLen]);

  const exitCopyMode = useCallback(() => {
    sessions.get(instanceId)?.xterm.clearSelection();
    setCopyMode(false);
  }, [instanceId]);

  // ── Build menu items ──

  const s = sessions.get(instanceId);
  const hasSelection = s?.xterm.hasSelection() ?? false;
  const isConnected = s?.ws?.readyState === WebSocket.OPEN;

  const ctxMenuItems: ContextMenuItem[] = [
    { label: 'Copy', action: 'copy', icon: TERM_ICONS.copy, disabled: !hasSelection },
    { label: 'Paste', action: 'paste', icon: TERM_ICONS.clipboard },
    { type: 'separator' },
    { label: 'Select All', action: 'select-all', icon: TERM_ICONS.selectAll },
    { label: 'Find...', action: 'find', icon: TERM_ICONS.search },
    { type: 'separator' },
    { label: 'Font +', action: 'font-increase', icon: TERM_ICONS.zoomIn },
    { label: 'Font \u2013', action: 'font-decrease', icon: TERM_ICONS.zoomOut },
    { type: 'separator' },
    { label: 'Clear', action: 'clear', icon: TERM_ICONS.trash },
    { label: 'Clear Console', action: 'clear-all', icon: TERM_ICONS.eraser, danger: true },
    { label: 'Reconnect', action: 'reconnect', icon: TERM_ICONS.refresh, disabled: isConnected },
  ];

  return (
    <div
      className="h-full relative flex flex-col"
      style={{ background: '#0a0a1a' }}
      onContextMenu={handleContextMenu}
    >
      {/* Row 1: shortcut keys + C-p + f-V + f-C */}
      <div className={`terminal-toolbar ${toolbarOpen ? '' : 'collapsed'}`}>
        <button
          type="button"
          className="terminal-toolbar-toggle"
          onClick={() => setToolbarOpen((v) => {
            localStorage.setItem('nebulide-terminal-toolbar', v ? 'closed' : 'open');
            setTimeout(fit, 50);
            return !v;
          })}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            {toolbarOpen ? <polyline points="18 15 12 9 6 15" /> : <polyline points="6 9 12 15 18 9" />}
          </svg>
        </button>
        {toolbarOpen && (
          <>
            {TOOLBAR_KEYS.map((k) => (
              <button
                key={k.label}
                type="button"
                className="terminal-toolbar-btn"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => sendKey(k.data)}
              >
                {k.label}
              </button>
            ))}
            <div className="terminal-toolbar-sep" />
            <button
              type="button"
              className={`terminal-toolbar-btn${row2Open ? ' active' : ''}`}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => setRow2Open((v) => {
                localStorage.setItem('nebulide-terminal-toolbar-r2', v ? 'closed' : 'open');
                setTimeout(fit, 50);
                return !v;
              })}
            >
              f-V
            </button>
            <button
              type="button"
              className={`terminal-toolbar-btn${copyMode ? ' active' : ''}`}
              onPointerDown={(e) => e.preventDefault()}
              onClick={toggleCopyMode}
            >
              f-C
            </button>
          </>
        )}
      </div>

      {/* Row 2: common actions (toggled by f-V) */}
      {row2Open && toolbarOpen && (
        <div className="terminal-toolbar">
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={copyTermSelection}>
            Copy
          </button>
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={pasteToTerminal}>
            Paste
          </button>
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={() => sessions.get(instanceId)?.xterm.selectAll()}>
            Sel All
          </button>
          <div className="terminal-toolbar-sep" />
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={() => sendKey('\x1b[H')}>
            Home
          </button>
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={() => sendKey('\x1b[F')}>
            End
          </button>
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={() => sendKey('\x1b[5~')}>
            PgUp
          </button>
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={() => sendKey('\x1b[6~')}>
            PgDn
          </button>
        </div>
      )}

      {/* Row 3: copy mode — line & character selection (toggled by f-C) */}
      {copyMode && toolbarOpen && (
        <div className="terminal-toolbar">
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={() => moveSelRow('start', -1)}>
            S{'\u2191'}
          </button>
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={() => moveSelRow('start', 1)}>
            S{'\u2193'}
          </button>
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={() => moveSelCol('start', -1)}>
            S{'\u2190'}
          </button>
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={() => moveSelCol('start', 1)}>
            S{'\u2192'}
          </button>
          <div className="terminal-toolbar-sep" />
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={() => moveSelRow('end', -1)}>
            E{'\u2191'}
          </button>
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={() => moveSelRow('end', 1)}>
            E{'\u2193'}
          </button>
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={() => moveSelCol('end', -1)}>
            E{'\u2190'}
          </button>
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={() => moveSelCol('end', 1)}>
            E{'\u2192'}
          </button>
          <div className="terminal-toolbar-sep" />
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={copySelection}>
            Copy
          </button>
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={selectAllLines}>
            All
          </button>
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={exitCopyMode}>
            {'\u00d7'}
          </button>
          <div className="terminal-toolbar-sep" />
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={() => copyLines(5)}>
            Cp5
          </button>
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={() => copyLines(30)}>
            Cp30
          </button>
          <button type="button" className="terminal-toolbar-btn" onPointerDown={(e) => e.preventDefault()} onClick={() => copyLines(0)}>
            CpAll
          </button>
        </div>
      )}

      <div
        ref={termRef}
        className="flex-1 min-h-0 min-w-0 overflow-hidden"
        {...longPressHandlers}
      />

      {/* Search bar */}
      {searchVisible && (
        <div className="terminal-search-bar">
          <input
            value={searchTerm}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
            placeholder="Find..."
            autoFocus
          />
          <button
            type="button"
            title="Previous (Shift+Enter)"
            onClick={() => sessions.get(instanceId)?.searchAddon.findPrevious(searchTerm)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          <button
            type="button"
            title="Next (Enter)"
            onClick={() => sessions.get(instanceId)?.searchAddon.findNext(searchTerm)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <button type="button" title="Close (Escape)" onClick={closeSearch}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenuItems}
          onAction={handleCtxAction}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}
