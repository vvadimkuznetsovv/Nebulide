import { useState, useEffect, useCallback } from 'react';
import TerminalComponent from './Terminal';
import ClaudeChatView from './AgentChatView';
import { resolveLiveSession } from '../../api/claudeSessions';
import {
  getTerminalViewMode, setTerminalViewMode, getTerminalCwdHint, useTerminalViewModeVersion,
  hasTrustPending, consumeTrustPending,
} from '../../utils/terminalViewMode';

interface Props {
  instanceId: string;
  persistent?: boolean;
  active?: boolean;
}

/**
 * 2 режима: Терминал (сырой xterm) и Чат (тонкая обёртка над тем же живым `claude`
 * в PTY — лента из JSONL, действия → клавиши в PTY). Внутри Чата по требованию
 * (permission/rewind/resume) показываем НАСТОЯЩИЙ экран терминала того же PTY.
 * PTY живёт в module-level session — переключение видов его не рвёт.
 */
export default function TerminalChatPanel({ instanceId, persistent, active }: Props) {
  useTerminalViewModeVersion(); // re-render on mode change
  const mode = getTerminalViewMode(instanceId) === 'terminal' ? 'terminal' : 'chat';
  const cwd = getTerminalCwdHint(instanceId);
  // Trust-gate: новая папка → claude показывает родной trust-промпт первым экраном.
  // Стартуем с настоящего терминала, чтобы юзер его увидел и подтвердил.
  const [trustGate, setTrustGate] = useState(() => hasTrustPending(instanceId));
  const [showRawInChat, setShowRawInChat] = useState(() => hasTrustPending(instanceId));

  const inChatTerminal = mode === 'chat' && showRawInChat;

  // Пока ждём подтверждения доступа — поллим резолв сессии; как только claude
  // реально стартовал (появился JSONL) — авто-возврат к красивой ленте.
  useEffect(() => {
    if (mode !== 'chat' || !trustGate) return;
    let alive = true;
    const iv = window.setInterval(async () => {
      try {
        const { data } = await resolveLiveSession(instanceId, cwd);
        if (alive && data?.session_file) {
          consumeTrustPending(instanceId);
          setTrustGate(false);
          setShowRawInChat(false);
        }
      } catch { /* claude ещё не стартовал — ждём */ }
    }, 1500);
    return () => { alive = false; clearInterval(iv); };
  }, [mode, trustGate, instanceId, cwd]);

  // Любое ручное переключение режима снимает trust-gate — юзер берёт управление.
  const dropTrustGate = () => { consumeTrustPending(instanceId); setTrustGate(false); };
  // Стабильная ссылка — чтобы memo(ClaudeMessage) не сбивалась через onRewind.
  const requestTerminal = useCallback(() => setShowRawInChat(true), []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Mode toggle */}
      <div style={{
        flexShrink: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, padding: '4px 6px',
        borderBottom: '1px solid var(--glass-border)', background: 'rgba(0,0,0,0.12)',
      }}>
        <button type="button" onClick={() => { dropTrustGate(); setShowRawInChat(false); setTerminalViewMode(instanceId, 'terminal'); }} style={modeBtnStyle(mode === 'terminal')}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          Терминал
        </button>
        <button type="button" onClick={() => { dropTrustGate(); setShowRawInChat(false); setTerminalViewMode(instanceId, 'chat'); }} style={modeBtnStyle(mode === 'chat')}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          Чат
        </button>
        {inChatTerminal && (
          <button type="button" onClick={() => { dropTrustGate(); setShowRawInChat(false); }} title="Вернуться к чату" style={{ ...modeBtnStyle(false), marginLeft: 'auto', color: 'var(--accent-bright)' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            Назад к чату
          </button>
        )}
      </div>

      {inChatTerminal && trustGate && (
        <div style={{ flexShrink: 0, padding: '7px 12px', fontSize: 12, lineHeight: 1.45, color: 'var(--accent-bright)', background: 'rgba(var(--accent-rgb),0.12)', borderBottom: '1px solid var(--glass-border)' }}>
          Новая папка — Claude спрашивает доступ. Подтвердите ниже (нажмите «1»); чат откроется автоматически после первого сообщения.
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {mode === 'terminal' || inChatTerminal
          ? <TerminalComponent instanceId={instanceId} persistent={persistent} active={active} />
          : <ClaudeChatView instanceId={instanceId} cwd={cwd} onRequestTerminal={requestTerminal} />}
      </div>
    </div>
  );
}

function modeBtnStyle(activeMode: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 6,
    fontSize: 12, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
    background: activeMode ? 'rgba(var(--accent-rgb),0.2)' : 'rgba(255,255,255,0.04)',
    border: `1px solid ${activeMode ? 'rgba(var(--accent-rgb),0.4)' : 'var(--glass-border)'}`,
    color: activeMode ? 'var(--accent-bright)' : 'var(--text-muted)',
  };
}
