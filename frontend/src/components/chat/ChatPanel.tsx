import { useState, useEffect } from 'react';
import { useAuthStore } from '../../store/authStore';

interface ChatPanelProps {
  sessionId: string | null;
}

type Status = 'checking' | 'ok' | 'unavailable';

export default function ChatPanel(_props: ChatPanelProps) {
  // Reactive token — automatically re-probes after token refresh or logout
  const token = useAuthStore((s) => s.accessToken);
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    if (!token) { setStatus('unavailable'); return; }

    setStatus('checking');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    fetch(`/code/?token=${token}`, { method: 'HEAD', signal: controller.signal })
      .then(res => { setStatus(res.ok ? 'ok' : 'unavailable'); })
      .catch(() => { setStatus('unavailable'); })
      .finally(() => clearTimeout(timer));

    return () => { controller.abort(); clearTimeout(timer); };
  }, [token]);

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
          onClick={() => { setStatus('checking'); }}
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

  return (
    <div className="h-full">
      <iframe
        src={`/code/?token=${token}`}
        title="VS Code"
        className="w-full h-full border-0"
        style={{ background: '#1e1e1e' }}
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}
