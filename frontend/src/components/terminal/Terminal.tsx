import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import ContextMenu, { type ContextMenuItem } from '../files/ContextMenu';
import { useLongPress } from '../../hooks/useLongPress';
import toast from 'react-hot-toast';

// ── Singleton terminal session that survives component remounts ──

interface TermSession {
  xterm: XTerm;
  fitAddon: FitAddon;
  ws: WebSocket;
  /** The DOM element xterm is currently attached to */
  container: HTMLDivElement | null;
}

let session: TermSession | null = null;

function getOrCreateSession(): TermSession {
  if (session && session.ws.readyState <= WebSocket.OPEN) return session;

  // Dispose stale session if any
  if (session) {
    session.ws.close();
    session.xterm.dispose();
    session = null;
  }

  const xterm = new XTerm({
    cursorBlink: true,
    cursorStyle: 'bar',
    fontSize: 13,
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

  const token = localStorage.getItem('access_token');
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws/terminal?token=${token}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    try {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        ws.send(JSON.stringify({ type: 'resize', rows: dims.rows, cols: dims.cols }));
      }
    } catch { /* xterm may not be attached yet */ }
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      xterm.write(new Uint8Array(event.data));
    } else {
      xterm.write(event.data);
    }
  };

  ws.onerror = () => {
    xterm.write('\r\n\x1b[38;2;248;113;113m[Connection error]\x1b[0m\r\n');
  };

  ws.onclose = () => {
    xterm.write('\r\n\x1b[38;2;248;113;113m[Terminal disconnected]\x1b[0m\r\n');
    if (session?.ws === ws) session = null;
  };

  xterm.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(new TextEncoder().encode(data));
    }
  });

  session = { xterm, fitAddon, ws, container: null };
  return session;
}

// ── React component — attaches/detaches the singleton to DOM ──

interface TerminalProps {
  active?: boolean;
}

// Feather-style SVG icons (14×14)
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
  trash: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  ),
};

export default function TerminalComponent({ active }: TerminalProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  // Long-press for mobile
  const { handlers: longPressHandlers } = useLongPress({
    onLongPress: (x, y) => setCtxMenu({ x, y }),
  });

  const fit = useCallback(() => {
    if (!session) return;
    try {
      session.fitAddon.fit();
      const dims = session.fitAddon.proposeDimensions();
      if (dims && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: 'resize', rows: dims.rows, cols: dims.cols }));
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const el = termRef.current;
    if (!el) return;

    const s = getOrCreateSession();

    // Attach xterm to this DOM element (re-open if container changed)
    if (s.container !== el) {
      // xterm.open() can only be called once; on remount we move the DOM node
      if (s.container) {
        // Move existing xterm DOM into new container
        const xtermEl = s.xterm.element?.parentElement;
        if (xtermEl) {
          el.appendChild(xtermEl);
        }
      } else {
        s.xterm.open(el);
      }
      s.container = el;
    }

    // Fit after attach
    setTimeout(fit, 50);

    const resizeObserver = new ResizeObserver(() => fit());
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      // Do NOT close ws or dispose xterm — keep session alive
    };
  }, [fit]);

  useEffect(() => {
    if (active) setTimeout(fit, 50);
  }, [active, fit]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleCtxAction = useCallback((action: string) => {
    setCtxMenu(null);
    if (!session) return;

    switch (action) {
      case 'copy': {
        const sel = session.xterm.getSelection();
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
            if (text && session?.ws.readyState === WebSocket.OPEN) {
              session.ws.send(new TextEncoder().encode(text));
            }
          })
          .catch(() => toast.error('Failed to paste'));
        break;
      case 'select-all':
        session.xterm.selectAll();
        break;
      case 'clear':
        session.xterm.clear();
        break;
    }
  }, []);

  const hasSelection = session?.xterm.hasSelection() ?? false;

  const ctxMenuItems: ContextMenuItem[] = [
    { label: 'Copy', action: 'copy', icon: TERM_ICONS.copy, disabled: !hasSelection },
    { label: 'Paste', action: 'paste', icon: TERM_ICONS.clipboard },
    { type: 'separator' },
    { label: 'Select All', action: 'select-all', icon: TERM_ICONS.selectAll },
    { label: 'Clear', action: 'clear', icon: TERM_ICONS.trash },
  ];

  return (
    <div
      className="h-full relative"
      style={{ background: '#0a0a1a' }}
      onContextMenu={handleContextMenu}
      {...longPressHandlers}
    >
      <div ref={termRef} className="h-full" />
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
