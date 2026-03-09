import { useState, useEffect, useCallback } from 'react';
import { listClaudeSessions, listClaudePlans, readClaudePlan } from '../../api/claudeSessions';
import type { ClaudeProject, ClaudeSession, ClaudePlan } from '../../api/claudeSessions';
import { useLayoutStore } from '../../store/layoutStore';
import { typeCommandInTerminal } from '../terminal/Terminal';
import toast from 'react-hot-toast';

interface ChatPanelProps {
  sessionId: string | null;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function formatSize(mb: number): string {
  if (mb < 1) return `${Math.round(mb * 1024)}KB`;
  return `${mb.toFixed(1)}MB`;
}

// Friendly name from project slug: "c--Users-evgen--projects-Clauder" → "Clauder"
function projectDisplayName(slug: string): string {
  const parts = slug.split('--');
  return parts[parts.length - 1] || slug;
}

export default function ChatPanel(_props: ChatPanelProps) {
  const [projects, setProjects] = useState<ClaudeProject[]>([]);
  const [plans, setPlans] = useState<ClaudePlan[]>([]);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [planContent, setPlanContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState<string | null>(null);

  const openTerminalWithId = useLayoutStore((s) => s.openTerminalWithId);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [sessRes, plansRes] = await Promise.all([
        listClaudeSessions(),
        listClaudePlans(),
      ]);
      setProjects(sessRes.data.projects || []);
      setPlans(plansRes.data.plans || []);
    } catch {
      // Offline or no .claude dir
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleOpenSession = useCallback(async (session: ClaudeSession) => {
    if (launching) return;
    setLaunching(session.session_id);

    const instanceId = `claude-${Date.now()}`;
    openTerminalWithId(instanceId);

    const ok = await typeCommandInTerminal(instanceId, `claude --resume ${session.session_id}`);
    if (!ok) {
      toast.error('Failed to connect to terminal');
    }
    setLaunching(null);
  }, [launching, openTerminalWithId]);

  const handlePlanClick = useCallback(async (slug: string) => {
    if (expandedPlan === slug) {
      setExpandedPlan(null);
      return;
    }
    try {
      const { data } = await readClaudePlan(slug);
      setPlanContent(data.content);
      setExpandedPlan(slug);
    } catch {
      toast.error('Failed to load plan');
    }
  }, [expandedPlan]);

  const allSessions = projects.flatMap((p) =>
    p.sessions.map((s) => ({ ...s, project: p.slug }))
  );
  allSessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Загрузка...</div>
      </div>
    );
  }

  const isEmpty = allSessions.length === 0 && plans.length === 0;

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', height: '100%',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '1px solid var(--glass-border)',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          Claude Sessions
        </span>
        <button
          type="button"
          onClick={refresh}
          title="Refresh"
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 4,
            color: 'var(--text-muted)', display: 'flex',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
        {isEmpty && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', height: '100%', gap: 12,
            color: 'var(--text-tertiary)', fontSize: 13,
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>No Claude sessions found</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Run Claude in the terminal to create sessions
            </span>
          </div>
        )}

        {/* Plans section */}
        {plans.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div style={{
              padding: '6px 16px', fontSize: 10, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.08em',
              color: 'var(--text-muted)',
            }}>
              Plans
            </div>
            {plans.map((plan) => (
              <div key={plan.slug}>
                <button
                  type="button"
                  onClick={() => handlePlanClick(plan.slug)}
                  style={{
                    width: '100%', textAlign: 'left', background: 'none', border: 'none',
                    padding: '8px 16px', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 10,
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--glass-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                  </svg>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12, fontWeight: 500, color: 'var(--text-primary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {plan.title}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                      {timeAgo(plan.updated_at)}
                    </div>
                  </div>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    style={{ flexShrink: 0, transform: expandedPlan === plan.slug ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
                {expandedPlan === plan.slug && (
                  <div style={{
                    margin: '0 16px 8px', padding: '10px 12px',
                    borderRadius: 8,
                    background: 'rgba(var(--accent-rgb), 0.04)',
                    border: '1px solid var(--glass-border)',
                    maxHeight: 300, overflow: 'auto',
                  }}>
                    <pre style={{
                      margin: 0, fontSize: 11, lineHeight: 1.5,
                      color: 'var(--text-secondary)', whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word', fontFamily: 'inherit',
                    }}>
                      {planContent}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Sessions section */}
        {allSessions.length > 0 && (
          <div>
            <div style={{
              padding: '6px 16px', fontSize: 10, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.08em',
              color: 'var(--text-muted)',
            }}>
              Sessions
            </div>
            {allSessions.map((session) => {
              const isLaunching = launching === session.session_id;
              return (
                <button
                  key={session.session_id}
                  type="button"
                  onClick={() => handleOpenSession(session)}
                  disabled={isLaunching}
                  style={{
                    width: '100%', textAlign: 'left',
                    background: isLaunching ? 'rgba(var(--accent-rgb), 0.08)' : 'none',
                    border: 'none', padding: '10px 16px', cursor: isLaunching ? 'wait' : 'pointer',
                    display: 'flex', gap: 10, alignItems: 'flex-start',
                    transition: 'background 0.15s',
                    opacity: isLaunching ? 0.7 : 1,
                  }}
                  onMouseEnter={(e) => { if (!isLaunching) e.currentTarget.style.background = 'var(--glass-hover)'; }}
                  onMouseLeave={(e) => { if (!isLaunching) e.currentTarget.style.background = 'none'; }}
                >
                  {/* Terminal icon */}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
                    <polyline points="4 17 10 11 4 5" />
                    <line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Session name */}
                    <div style={{
                      fontSize: 12, fontWeight: 500, color: 'var(--text-primary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {session.slug || session.session_id.slice(0, 8)}
                    </div>
                    {/* First message preview */}
                    {session.first_message && (
                      <div style={{
                        fontSize: 11, color: 'var(--text-muted)', marginTop: 3,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {session.first_message}
                      </div>
                    )}
                    {/* Meta line */}
                    <div style={{
                      fontSize: 10, color: 'var(--text-muted)', marginTop: 3,
                      display: 'flex', gap: 8,
                    }}>
                      <span>{projectDisplayName(session.project)}</span>
                      <span>{formatSize(session.size_mb)}</span>
                      <span>{timeAgo(session.updated_at)}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
