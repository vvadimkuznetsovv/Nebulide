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

// ── Font size persistence ──

const FONT_SIZE_KEY = 'clauder-terminal-font-size';
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
  let id = sessionStorage.getItem('clauder-tab-id');
  if (!id) {
    id = Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('clauder-tab-id', id);
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

async function connectWs(instanceId: string): Promise<void> {
  const session = sessions.get(instanceId);
  if (!session) return;

  const token = await ensureFreshToken();
  if (!token) {
    console.warn(`[Terminal] connectWs SKIP — no access_token id=${instanceId}`);
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const tabId = getTabSessionId();
  const wsInstanceId = `${instanceId}@${tabId}`;
  const url = `${protocol}//${window.location.host}/ws/terminal?token=${token}&instanceId=${encodeURIComponent(wsInstanceId)}`;
  console.log(`[Terminal] connectWs id=${instanceId} attempt=${session.reconnectAttempts}`);
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  session.ws = ws;

  let opened = false;

  ws.onopen = () => {
    opened = true;
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
    console.warn(`[Terminal] ws.onerror id=${instanceId}`, e);
  };

  ws.onclose = (e) => {
    console.log(`[Terminal] ws.onclose id=${instanceId} code=${e.code} opened=${opened} session.ws===ws:${session.ws === ws} inMap:${sessions.has(instanceId)}`);

    // WS was superseded by a newer connection — don't reconnect
    if (session.ws !== ws) {
      console.log(`[Terminal] ws.onclose IGNORED (superseded) id=${instanceId}`);
      return;
    }
    session.ws = null;

    // Connection was rejected before opening (401, network error) — don't reconnect
    if (!opened) {
      console.log(`[Terminal] ws.onclose REJECTED (never opened) id=${instanceId}`);
      session.xterm.write('\r\n\x1b[38;2;248;113;113m[Connection rejected]\x1b[0m\r\n');
      session.xterm.write('\x1b[38;2;110;180;255m[Right-click \u2192 Reconnect]\x1b[0m\r\n');
      session.notifyRerender?.();
      return;
    }

    if (!sessions.has(instanceId)) return; // session was destroyed

    if (session.reconnectAttempts < MAX_RECONNECT) {
      session.reconnectAttempts++;
      session.xterm.write('\r\n\x1b[38;2;251;191;36m[Shell exited \u2014 reconnecting...]\x1b[0m\r\n');
      session.reconnectTimer = window.setTimeout(() => {
        session.reconnectTimer = null;
        if (sessions.has(instanceId)) connectWs(instanceId);
      }, RECONNECT_DELAY);
    } else {
      session.xterm.write('\r\n\x1b[38;2;248;113;113m[Disconnected]\x1b[0m\r\n');
      session.xterm.write('\x1b[38;2;110;180;255m[Right-click \u2192 Reconnect]\x1b[0m\r\n');
      session.reconnectAttempts = 0;
    }
    session.notifyRerender?.();
  };
}

function forceReconnect(instanceId: string): void {
  const session = sessions.get(instanceId);
  if (!session) return;

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
  }
  const wsState = session.ws ? ['CONNECTING','OPEN','CLOSING','CLOSED'][session.ws.readyState] : 'null';
  console.log(`[Terminal] getOrCreateSession id=${instanceId} existed=${existed} wsState=${wsState}`);
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
  { label: 'C-c', data: '\x03' },
  { label: 'C-d', data: '\x04' },
  { label: 'C-z', data: '\x1a' },
  { label: 'C-l', data: '\x0c' },
];

const isTouchDevice = 'ontouchstart' in globalThis;

export default function TerminalComponent({ instanceId, active, persistent }: TerminalProps) {
  const termRef = useRef<HTMLDivElement>(null);
  // Store persistent/instanceId in refs to access stable values in cleanup
  const persistentRef = useRef(persistent);
  const instanceIdRef = useRef(instanceId);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [, setTick] = useState(0);

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
      if (s.container) {
        const xtermEl = s.xterm.element?.parentElement;
        if (xtermEl) {
          el.appendChild(xtermEl);
        }
      } else {
        s.xterm.open(el);
      }
      s.container = el;
    }

    setTimeout(fit, 50);

    const resizeObserver = new ResizeObserver(() => fit());
    resizeObserver.observe(el);

    return () => {
      console.log(`[Terminal] useEffect CLEANUP id=${instanceIdRef.current} persistent=${persistentRef.current}`);
      resizeObserver.disconnect();
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
        navigator.clipboard.readText()
          .then((text) => {
            if (text && s?.ws?.readyState === WebSocket.OPEN) {
              s.ws!.send(new TextEncoder().encode(text));
            }
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
        // Full terminal reset — clears scrollback + screen
        s?.xterm.reset();
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
      {/* Mobile shortcut toolbar */}
      {isTouchDevice && (
        <div className="terminal-toolbar">
          {TOOLBAR_KEYS.map((k) => (
            <button
              key={k.label}
              type="button"
              className="terminal-toolbar-btn"
              onPointerDown={(e) => { e.preventDefault(); sendKey(k.data); }}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}

      <div
        ref={termRef}
        className="flex-1 min-h-0"
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
