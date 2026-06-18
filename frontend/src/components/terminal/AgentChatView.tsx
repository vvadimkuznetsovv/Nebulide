import { useState, useEffect, useRef, useCallback } from 'react';
import { agentWsUrl, type PermissionMode, type PermissionScope } from '../../api/agent';
import { tailClaudeSession } from '../../api/claudeSessions';
import type { RichMessage } from '../../api/claudeSessions';
import ClaudeMessage from '../chat/ClaudeMessage';

interface Props {
  instanceId: string;
  cwd?: string;
  /** Resume a specific session (Open of a past session). */
  resume?: string;
  /** Optional: load this session's history before going live. */
  historyProject?: string;
  historySessionFile?: string;
}

interface PermReq { requestId: string; tool: string; input: unknown }

// Remember the resolved session id per instance so a remount resumes it.
const agentSessions = new Map<string, string>();

const MODES: { id: PermissionMode; label: string }[] = [
  { id: 'default', label: 'Обычный' },
  { id: 'plan', label: 'План' },
  { id: 'acceptEdits', label: 'Авто-правки' },
  { id: 'bypassPermissions', label: 'Разрешить всё' },
];

function permSummary(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of ['command', 'file_path', 'path', 'url', 'pattern']) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v.length > 160 ? v.slice(0, 160) + '…' : v;
    }
    try { return JSON.stringify(o).slice(0, 200); } catch { /* ignore */ }
  }
  return '';
}

export default function AgentChatView({ instanceId, cwd, resume, historyProject, historySessionFile }: Props) {
  const [messages, setMessages] = useState<RichMessage[]>([]);
  const [streaming, setStreaming] = useState('');
  const [perm, setPerm] = useState<PermReq | null>(null);
  const [mode, setMode] = useState<PermissionMode>('default');
  const [status, setStatus] = useState<'connecting' | 'ready' | 'working' | 'error' | 'closed'>('connecting');
  const [input, setInput] = useState('');
  const [scopeOpen, setScopeOpen] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  const send = useCallback((obj: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }, []);

  // Initial history (for Open of a past session) + WS connect.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (historyProject && historySessionFile) {
        try {
          const { data } = await tailClaudeSession(historyProject, historySessionFile, 0);
          if (!cancelled && data.messages?.length) setMessages(data.messages);
        } catch { /* ignore */ }
      }

      const resumeId = resume || agentSessions.get(instanceId) || '';
      const ws = new WebSocket(agentWsUrl({ cwd, resume: resumeId, mode: 'default' }));
      wsRef.current = ws;

      ws.onopen = () => { if (!cancelled) setStatus('ready'); };
      ws.onclose = () => { if (!cancelled) setStatus('closed'); };
      ws.onerror = () => { if (!cancelled) setStatus('error'); };
      ws.onmessage = (e) => {
        if (cancelled) return;
        let m: Record<string, unknown>;
        try { m = JSON.parse(e.data); } catch { return; }
        const sc = scrollRef.current;
        stick.current = !sc || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
        switch (m.type) {
          case 'init':
            if (typeof m.session_id === 'string') agentSessions.set(instanceId, m.session_id);
            break;
          case 'delta':
            setStatus('working');
            setStreaming(prev => prev + (m.text as string || ''));
            break;
          case 'message': {
            const msg = m.message as RichMessage;
            setStreaming('');
            setMessages(prev => prev.some(x => x.uuid === msg.uuid) ? prev : [...prev, msg]);
            break;
          }
          case 'permission_request':
            setPerm({ requestId: m.requestId as string, tool: m.tool as string, input: m.input });
            break;
          case 'result':
            setStatus('ready');
            setStreaming('');
            break;
          case 'mode':
            if (typeof m.mode === 'string') setMode(m.mode as PermissionMode);
            break;
          case 'error':
            setStatus('error');
            break;
        }
      };
    })();

    return () => { cancelled = true; wsRef.current?.close(); wsRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  useEffect(() => {
    const sc = scrollRef.current;
    if (sc && stick.current) sc.scrollTop = sc.scrollHeight;
  }, [messages, streaming, perm, status]);

  const sendUser = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    setMessages(prev => [...prev, { uuid: `local-${Date.now()}`, role: 'user', blocks: [{ kind: 'text', text }] }]);
    setStatus('working');
    stick.current = true;
    send({ type: 'user', text });
  }, [input, send]);

  const decide = useCallback((behavior: 'allow' | 'deny', allowAlways?: boolean, scope?: PermissionScope) => {
    if (!perm) return;
    send({ type: 'permission', requestId: perm.requestId, behavior, allowAlways, scope });
    setPerm(null);
    setScopeOpen(false);
  }, [perm, send]);

  const changeMode = useCallback((m: PermissionMode) => {
    setMode(m);
    send({ type: 'set_mode', mode: m });
  }, [send]);

  const streamMsg: RichMessage | null = streaming
    ? { uuid: 'streaming', role: 'assistant', blocks: [{ kind: 'text', text: streaming }] }
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Mode selector + abort */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, padding: '5px 8px', borderBottom: '1px solid var(--glass-border)', background: 'rgba(0,0,0,0.12)', flexWrap: 'wrap' }}>
        {MODES.map(mo => (
          <button key={mo.id} type="button" onClick={() => changeMode(mo.id)}
            style={{
              padding: '5px 11px', borderRadius: 6, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
              background: mode === mo.id ? 'rgba(var(--accent-rgb),0.2)' : 'rgba(255,255,255,0.04)',
              border: `1px solid ${mode === mo.id ? 'rgba(var(--accent-rgb),0.4)' : 'var(--glass-border)'}`,
              color: mode === mo.id ? 'var(--accent-bright)' : 'var(--text-muted)',
            }}>
            {mo.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {status === 'working' && (
          <button type="button" onClick={() => send({ type: 'abort' })} title="Остановить"
            style={{ padding: '5px 11px', borderRadius: 6, fontSize: 10, cursor: 'pointer', fontFamily: 'inherit',
              background: 'rgba(var(--danger-rgb),0.1)', border: '1px solid rgba(var(--danger-rgb),0.3)', color: 'var(--danger)' }}>
            ■ Стоп
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '10px 12px', WebkitOverflowScrolling: 'touch' }}>
        {messages.length === 0 && !streaming && (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: 13, textAlign: 'center', padding: 20 }}>
            {status === 'connecting' ? 'Подключение…' : status === 'error' ? 'Ошибка подключения к агенту' : 'Напишите сообщение, чтобы начать.'}
          </div>
        )}
        {messages.map(m => <ClaudeMessage key={m.uuid} msg={m} />)}
        {streamMsg && <ClaudeMessage msg={streamMsg} />}
        {status === 'working' && !streaming && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 12, color: 'var(--accent)' }}>
            <span className="claude-chat-pulse" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)' }} />
            Claude работает…
          </div>
        )}
      </div>

      {/* Permission request */}
      {perm && (
        <div style={{ flexShrink: 0, borderTop: '1px solid rgba(var(--accent-rgb),0.4)', background: 'rgba(var(--accent-rgb),0.08)', padding: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-primary)', marginBottom: 4 }}>
            Claude запрашивает доступ: <b style={{ color: 'var(--accent)' }}>{perm.tool}</b>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {permSummary(perm.input)}
          </div>
          <div style={{ display: 'flex', gap: 8, position: 'relative', flexWrap: 'wrap' }}>
            <button type="button" onClick={() => decide('allow')}
              style={btn('rgba(var(--success-rgb),0.18)', 'rgba(var(--success-rgb),0.4)', 'var(--success)')}>Да</button>
            <div style={{ position: 'relative' }}>
              <button type="button" onClick={() => setScopeOpen(v => !v)}
                style={btn('rgba(var(--accent-rgb),0.18)', 'rgba(var(--accent-rgb),0.4)', 'var(--accent-bright)')}>
                Да навсегда ▾
              </button>
              {scopeOpen && (
                <div style={{ position: 'absolute', bottom: '110%', right: 0, zIndex: 10, minWidth: 160,
                  background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: 8, overflow: 'hidden' }}>
                  {([['session', 'Эта сессия'], ['project', 'Этот проект'], ['always', 'Навсегда']] as [PermissionScope, string][]).map(([s, l]) => (
                    <button key={s} type="button" onClick={() => decide('allow', true, s)}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px', fontSize: 12, fontFamily: 'inherit',
                        background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--glass-hover)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
                      {l}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button type="button" onClick={() => decide('deny')}
              style={btn('rgba(var(--danger-rgb),0.12)', 'rgba(var(--danger-rgb),0.35)', 'var(--danger)')}>Нет</button>
          </div>
        </div>
      )}

      {/* Input */}
      <div style={{ flexShrink: 0, borderTop: '1px solid var(--glass-border)', padding: 8, background: 'rgba(0,0,0,0.15)', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendUser(); } }}
          placeholder="Сообщение для Claude…"
          rows={1}
          style={{ flex: 1, resize: 'none', maxHeight: 120, minHeight: 38, padding: '9px 12px', borderRadius: 10,
            fontSize: 13, fontFamily: 'inherit', lineHeight: 1.4, background: 'rgba(var(--accent-rgb),0.06)',
            border: '1px solid var(--glass-border)', color: 'var(--text-primary)', outline: 'none' }}
        />
        <button type="button" onClick={sendUser} disabled={!input.trim()}
          style={{ flexShrink: 0, width: 38, height: 38, borderRadius: 10, cursor: input.trim() ? 'pointer' : 'not-allowed',
            display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--accent-rgb),0.2)',
            border: '1px solid rgba(var(--accent-rgb),0.4)', color: 'var(--accent-bright)', opacity: input.trim() ? 1 : 0.5 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function btn(bg: string, border: string, color: string): React.CSSProperties {
  return { padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: bg, border: `1px solid ${border}`, color };
}
