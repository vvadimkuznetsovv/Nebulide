import { useState, useEffect, useRef } from 'react';
import { useAuthStore } from '../../store/authStore';

interface ChatPanelProps {
  sessionId: string | null;
}

type Status = 'checking' | 'ok' | 'unavailable';

// ── Singleton iframe: created once, NEVER removed from DOM ──
// Survives any React remount (layout changes, tab switches, panel toggles).
// Uses DOM reparenting: iframe wrapper is moved between the panel container
// (when visible) and an offscreen holder (when panel unmounts).

let iframeWrapper: HTMLDivElement | null = null;
let iframeEl: HTMLIFrameElement | null = null;

let offscreenHolder: HTMLDivElement | null = null;
function ensureOffscreenHolder(): HTMLDivElement {
  if (!offscreenHolder) {
    offscreenHolder = document.createElement('div');
    offscreenHolder.style.cssText =
      'position:fixed;left:-9999px;top:-9999px;width:0;height:0;overflow:hidden;pointer-events:none;';
    document.body.appendChild(offscreenHolder);
  }
  return offscreenHolder;
}

function ensureIframe(token: string): void {
  if (iframeWrapper) return; // already created
  console.log('[ChatPanel] Creating singleton iframe');

  iframeWrapper = document.createElement('div');
  iframeWrapper.style.cssText =
    'position:absolute;inset:0;z-index:15;overflow:hidden;';

  iframeEl = document.createElement('iframe');
  iframeEl.src = `/code/?token=${token}`;
  iframeEl.title = 'VS Code';
  iframeEl.allow = 'clipboard-read; clipboard-write';
  iframeEl.style.cssText =
    'width:100%;height:100%;border:0;background:#1e1e1e;';
  iframeWrapper.appendChild(iframeEl);

  // Park in offscreen holder until a panel mounts
  ensureOffscreenHolder().appendChild(iframeWrapper);
}

function attachIframe(container: HTMLElement): void {
  if (!iframeWrapper) return;
  container.appendChild(iframeWrapper); // moves the node (no reload)
}

function detachIframe(): void {
  if (!iframeWrapper) return;
  ensureOffscreenHolder().appendChild(iframeWrapper); // back to offscreen
}

function isIframeCreated(): boolean {
  return !!iframeWrapper;
}

export default function ChatPanel(_props: ChatPanelProps) {
  const token = useAuthStore((s) => s.accessToken);
  const containerRef = useRef<HTMLDivElement>(null);

  // Probe result tracks which token was probed — auto-resets on token change
  const [probe, setProbe] = useState<{ token: string; result: 'ok' | 'failed' } | null>(
    isIframeCreated() ? { token: '', result: 'ok' } : null,
  );

  // Derive status: no refs, no setState during render
  const status: Status =
    isIframeCreated() ? 'ok' :
    !token ? 'unavailable' :
    (probe?.token === token && probe.result === 'ok') ? 'ok' :
    (probe?.token === token && probe.result === 'failed') ? 'unavailable' :
    'checking';

  // Probe code-server (fires when status is 'checking')
  useEffect(() => {
    if (status !== 'checking' || !token || isIframeCreated()) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    console.log('[ChatPanel] Probing /code/ ...');
    fetch(`/code/?token=${token}`, { method: 'HEAD', signal: controller.signal })
      .then(res => {
        console.log('[ChatPanel] Probe response:', res.status, res.ok);
        if (res.ok) {
          ensureIframe(token);
          setProbe({ token, result: 'ok' });
        } else {
          setProbe({ token, result: 'failed' });
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') {
          console.log('[ChatPanel] Probe aborted (cleanup) — ignoring');
          return;
        }
        console.warn('[ChatPanel] Probe failed:', err);
        setProbe({ token, result: 'failed' });
      })
      .finally(() => clearTimeout(timer));

    return () => { controller.abort(); clearTimeout(timer); };
  }, [status, token]);

  // Attach iframe to this container on mount, detach on unmount
  useEffect(() => {
    if (status !== 'ok' || !containerRef.current) return;
    attachIframe(containerRef.current);
    return () => { detachIframe(); };
  }, [status]);

  if (status === 'checking') {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Подключение...</div>
      </div>
    );
  }

  if (status === 'unavailable') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center h-full gap-4">
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: 'rgba(248,113,113,0.12)',
            border: '1px solid rgba(248,113,113,0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: 'var(--text-primary)', fontWeight: 500, marginBottom: 6 }}>
            Claude Code не запущен
          </p>
          <p style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
            Запустите сервис через Docker Compose
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setProbe(null); }}
          style={{
            padding: '8px 20px',
            borderRadius: 8,
            border: '1px solid var(--glass-border)',
            background: 'rgba(127,0,255,0.1)',
            color: 'var(--text-secondary)',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Повторить
        </button>
      </div>
    );
  }

  // Container for the iframe — position:relative so absolute iframe fills it
  return <div ref={containerRef} className="h-full" style={{ position: 'relative' }} />;
}
