import TerminalComponent from './Terminal';
import ClaudeChatView from './ClaudeChatView';
import AgentChatView from './AgentChatView';
import {
  getTerminalViewMode, setTerminalViewMode, getTerminalCwdHint, getAgentLaunch, useTerminalViewModeVersion,
} from '../../utils/terminalViewMode';

interface Props {
  instanceId: string;
  persistent?: boolean;
  active?: boolean;
}

/**
 * Wraps a terminal instance with a Terminal ⇄ Chat toggle. In chat mode the
 * raw xterm is unmounted but its module-level PTY/WebSocket session stays alive
 * (same as panel hide/show), so Claude keeps running underneath and the chat
 * view tails its JSONL.
 */
export default function TerminalChatPanel({ instanceId, persistent, active }: Props) {
  useTerminalViewModeVersion(); // re-render on mode change
  const mode = getTerminalViewMode(instanceId);
  const cwd = getTerminalCwdHint(instanceId);
  const agentLaunch = getAgentLaunch(instanceId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Mode toggle */}
      <div style={{
        flexShrink: 0, display: 'flex', flexWrap: 'wrap', gap: 4, padding: '4px 6px',
        borderBottom: '1px solid var(--glass-border)', background: 'rgba(0,0,0,0.12)',
      }}>
        <button
          type="button"
          onClick={() => setTerminalViewMode(instanceId, 'terminal')}
          style={modeBtnStyle(mode === 'terminal')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          Терминал
        </button>
        <button
          type="button"
          onClick={() => setTerminalViewMode(instanceId, 'agent')}
          style={modeBtnStyle(mode === 'agent')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
          </svg>
          Чат
        </button>
        <button
          type="button"
          onClick={() => setTerminalViewMode(instanceId, 'chat')}
          title="Монитор сессии (только чтение JSONL)"
          style={modeBtnStyle(mode === 'chat')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
          </svg>
          Монитор
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {mode === 'agent'
          ? <AgentChatView instanceId={instanceId} cwd={cwd} resume={agentLaunch?.resume} historyProject={agentLaunch?.historyProject} historySessionFile={agentLaunch?.historySessionFile} />
          : mode === 'chat'
            ? <ClaudeChatView instanceId={instanceId} cwd={cwd} />
            : <TerminalComponent instanceId={instanceId} persistent={persistent} active={active} />}
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
