import { useState, useEffect, useCallback, useMemo } from 'react';
import { listClaudeSessions, listClaudePlans, readClaudePlan, readClaudeSession } from '../../api/claudeSessions';
import type { ClaudeProject, ClaudeSession, ClaudePlan, ClaudeSessionMessage } from '../../api/claudeSessions';
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

function sessionDisplayName(session: ClaudeSession & { project: string }): string {
  if (session.first_message) {
    const msg = session.first_message;
    return msg.length > 60 ? msg.slice(0, 60) + '...' : msg;
  }
  return session.slug || session.session_id.slice(0, 8);
}

export default function ChatPanel(_props: ChatPanelProps) {
  const [projects, setProjects] = useState<ClaudeProject[]>([]);
  const [plans, setPlans] = useState<ClaudePlan[]>([]);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [planContent, setPlanContent] = useState<string>('');
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<ClaudeSessionMessage[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

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

  const handlePreviewSession = useCallback(async (session: ClaudeSession & { project: string }) => {
    const key = session.session_id;
    if (expandedSession === key) {
      setExpandedSession(null);
      return;
    }
    setPreviewLoading(true);
    try {
      // Try with session_id first (internal ID), fall back to filename
      const { data } = await readClaudeSession(session.project, session.session_id);
      setSessionMessages(data.messages || []);
      setExpandedSession(key);
    } catch {
      toast.error('Failed to load session preview');
    } finally {
      setPreviewLoading(false);
    }
  }, [expandedSession]);

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

  const allSessions = useMemo(() => {
    const flat = projects.flatMap((p) =>
      p.sessions.map((s) => ({ ...s, project: s.project || p.slug }))
    );
    flat.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return flat;
  }, [projects]);

  const filteredSessions = useMemo(() => {
    if (!searchQuery) return allSessions;
    const q = searchQuery.toLowerCase();
    return allSessions.filter(s =>
      s.first_message?.toLowerCase().includes(q)
      || s.slug?.toLowerCase().includes(q)
      || projectDisplayName(s.project).toLowerCase().includes(q)
      || s.session_id.toLowerCase().includes(q)
    );
  }, [allSessions, searchQuery]);

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Loading...</div>
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

      {/* Search */}
      {!isEmpty && (
        <div style={{ padding: '8px 12px', flexShrink: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'rgba(var(--accent-rgb), 0.06)',
            border: '1px solid var(--glass-border)',
            borderRadius: 8, padding: '6px 10px',
          }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search sessions..."
              style={{
                flex: 1, background: 'none', border: 'none', outline: 'none',
                color: 'var(--text-primary)', fontSize: 12, fontFamily: 'inherit',
              }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text-muted)', display: 'flex', padding: 0,
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

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
        {filteredSessions.length > 0 && (
          <div>
            <div style={{
              padding: '6px 16px', fontSize: 10, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.08em',
              color: 'var(--text-muted)',
            }}>
              Sessions{searchQuery ? ` (${filteredSessions.length})` : ''}
            </div>
            {filteredSessions.map((session) => {
              const isLaunching = launching === session.session_id;
              const isExpanded = expandedSession === session.session_id;
              return (
                <div key={session.session_id}>
                  <div
                    style={{
                      width: '100%', textAlign: 'left',
                      background: isLaunching ? 'rgba(var(--accent-rgb), 0.08)' : 'none',
                      padding: '10px 16px',
                      display: 'flex', gap: 10, alignItems: 'flex-start',
                      transition: 'background 0.15s',
                      opacity: isLaunching ? 0.7 : 1,
                    }}
                    onMouseEnter={(e) => { if (!isLaunching) e.currentTarget.style.background = 'var(--glass-hover)'; }}
                    onMouseLeave={(e) => { if (!isLaunching) e.currentTarget.style.background = isLaunching ? 'rgba(var(--accent-rgb), 0.08)' : 'none'; }}
                  >
                    {/* Terminal icon */}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
                      <polyline points="4 17 10 11 4 5" />
                      <line x1="12" y1="19" x2="20" y2="19" />
                    </svg>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {/* Session name — first_message as primary */}
                      <div style={{
                        fontSize: 12, fontWeight: 500, color: 'var(--text-primary)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {sessionDisplayName(session)}
                      </div>
                      {/* 2-line preview of first_message */}
                      {session.first_message && (
                        <div style={{
                          fontSize: 11, color: 'var(--text-muted)', marginTop: 3,
                          overflow: 'hidden', textOverflow: 'ellipsis',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          lineHeight: '1.4',
                        }}>
                          {session.first_message}
                        </div>
                      )}
                      {/* Meta line + action buttons */}
                      <div style={{
                        fontSize: 10, color: 'var(--text-muted)', marginTop: 4,
                        display: 'flex', alignItems: 'center', gap: 8,
                      }}>
                        <span>{projectDisplayName(session.project)}</span>
                        <span>{formatSize(session.size_mb)}</span>
                        <span>{timeAgo(session.updated_at)}</span>
                        <span style={{ flex: 1 }} />
                        {/* Preview button */}
                        <button
                          type="button"
                          onClick={() => handlePreviewSession(session)}
                          disabled={previewLoading && expandedSession !== session.session_id}
                          title="Preview conversation"
                          style={{
                            background: isExpanded ? 'rgba(var(--accent-rgb), 0.15)' : 'rgba(var(--accent-rgb), 0.08)',
                            border: '1px solid var(--glass-border)',
                            borderRadius: 4, padding: '3px 8px',
                            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
                            color: isExpanded ? 'var(--accent)' : 'var(--text-secondary)',
                            fontSize: 10, fontFamily: 'inherit',
                            transition: 'all 0.15s',
                          }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                          Preview
                        </button>
                        {/* Open button */}
                        <button
                          type="button"
                          onClick={() => handleOpenSession(session)}
                          disabled={!!launching}
                          title="Resume in terminal"
                          style={{
                            background: 'rgba(var(--accent-rgb), 0.12)',
                            border: '1px solid var(--glass-border)',
                            borderRadius: 4, padding: '3px 8px',
                            cursor: isLaunching ? 'wait' : 'pointer',
                            display: 'flex', alignItems: 'center', gap: 4,
                            color: 'var(--accent)',
                            fontSize: 10, fontFamily: 'inherit',
                            transition: 'all 0.15s',
                          }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="5 3 19 12 5 21 5 3" />
                          </svg>
                          Open
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Expanded preview */}
                  {isExpanded && (
                    <div style={{
                      margin: '0 16px 8px', padding: '10px 12px',
                      borderRadius: 8,
                      background: 'rgba(var(--accent-rgb), 0.04)',
                      border: '1px solid var(--glass-border)',
                      maxHeight: 400, overflow: 'auto',
                    }}>
                      {sessionMessages.length === 0 ? (
                        <div style={{ color: 'var(--text-muted)', fontSize: 11, textAlign: 'center', padding: 12 }}>
                          No messages in this session
                        </div>
                      ) : (
                        sessionMessages.map((msg, i) => (
                          <div key={i} style={{
                            marginBottom: i < sessionMessages.length - 1 ? 10 : 0,
                            paddingBottom: i < sessionMessages.length - 1 ? 10 : 0,
                            borderBottom: i < sessionMessages.length - 1 ? '1px solid var(--glass-border)' : 'none',
                          }}>
                            <div style={{
                              fontSize: 10, fontWeight: 600,
                              color: msg.role === 'user' ? 'var(--accent)' : 'var(--text-secondary)',
                              marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em',
                            }}>
                              {msg.role === 'user' ? 'You' : 'Claude'}
                              {msg.timestamp && (
                                <span style={{ fontWeight: 400, marginLeft: 8, color: 'var(--text-muted)' }}>
                                  {timeAgo(msg.timestamp)}
                                </span>
                              )}
                            </div>
                            <pre style={{
                              margin: 0, fontSize: 11, lineHeight: 1.5,
                              color: 'var(--text-primary)', whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word', fontFamily: 'inherit',
                            }}>
                              {msg.content}
                            </pre>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* No search results */}
        {searchQuery && filteredSessions.length === 0 && allSessions.length > 0 && (
          <div style={{
            padding: '20px 16px', textAlign: 'center',
            color: 'var(--text-muted)', fontSize: 12,
          }}>
            No sessions matching "{searchQuery}"
          </div>
        )}
      </div>
    </div>
  );
}
