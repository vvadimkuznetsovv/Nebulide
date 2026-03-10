import { useEffect, useState, type ReactNode } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getUser, getUserTerminals, getUserSessions, killTerminal, deleteWorkspace, deleteUser, deleteUserSession, type UserDetail as UserDetailType, type TerminalSession, type WorkspaceSession } from '../api/admin';
import ConfirmDialog from '../components/ConfirmDialog';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

type TabId = 'sessions' | 'workspace' | 'terminals';

const tabs: { id: TabId; label: string; icon: ReactNode }[] = [
  {
    id: 'sessions',
    label: 'Sessions',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
  },
  {
    id: 'workspace',
    label: 'Workspace',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
      </svg>
    ),
  },
  {
    id: 'terminals',
    label: 'Terminals',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    ),
  },
];

export default function UserDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [user, setUser] = useState<UserDetailType | null>(null);
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const [sessions, setSessions] = useState<WorkspaceSession[]>([]);
  const [confirm, setConfirm] = useState<{ type: string; data?: string } | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('sessions');

  const load = () => {
    if (!id) return;
    getUser(id).then((r) => setUser(r.data));
    getUserTerminals(id).then((r) => setTerminals(r.data));
    getUserSessions(id).then((r) => setSessions(r.data));
  };

  useEffect(load, [id]);

  const handleConfirm = async () => {
    if (!id || !confirm) return;
    if (confirm.type === 'delete-user') {
      await deleteUser(id);
      navigate('/users');
    } else if (confirm.type === 'delete-workspace') {
      await deleteWorkspace(id);
      load();
    } else if (confirm.type === 'kill-terminal' && confirm.data) {
      await killTerminal(id, confirm.data);
      load();
    } else if (confirm.type === 'delete-session' && confirm.data) {
      await deleteUserSession(id, confirm.data);
      load();
    }
    setConfirm(null);
  };

  if (!user) return <p style={{ color: 'var(--text-muted)' }}>Loading...</p>;

  const aliveTerminals = terminals.filter((t) => t.alive);
  const totalCpu = terminals.reduce((sum, t) => sum + t.cpu_percent, 0);
  const totalRam = terminals.reduce((sum, t) => sum + t.memory_rss_bytes, 0);

  return (
    <div>
      <button className="glass-btn small" onClick={() => navigate('/users')} style={{ marginBottom: '16px' }}>
        &larr; Back
      </button>

      <h1 className="page-heading" style={{ marginBottom: '4px' }}>
        {user.username}
        {user.is_admin && <span className="badge admin" style={{ marginLeft: '12px', fontSize: '12px' }}>Admin</span>}
      </h1>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '24px' }}>Created: {user.created_at}</p>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4" style={{ marginBottom: '24px' }}>
        <div className="stat-card">
          <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '4px' }}>Workspace</div>
          <div style={{ color: 'var(--text-primary)', fontSize: '20px', fontWeight: 700 }}>
            {formatBytes(user.workspace_size_bytes)}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{user.workspace_file_count} files</div>
        </div>
        <div className="stat-card">
          <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '4px' }}>Active PTY</div>
          <div style={{ color: 'var(--text-primary)', fontSize: '20px', fontWeight: 700 }}>{aliveTerminals.length}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{terminals.length} total</div>
        </div>
        <div className="stat-card">
          <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '4px' }}>CPU / RAM</div>
          <div style={{ color: totalCpu > 50 ? 'var(--warning)' : 'var(--text-primary)', fontSize: '20px', fontWeight: 700, fontFamily: 'monospace' }}>
            {totalCpu > 0 ? totalCpu.toFixed(1) + '%' : '—'}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '11px', fontFamily: 'monospace' }}>{totalRam > 0 ? formatBytes(totalRam) : '—'}</div>
        </div>
        <div className="stat-card">
          <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '4px' }}>2FA</div>
          <div style={{ color: user.totp_enabled ? 'var(--success)' : 'var(--text-muted)', fontSize: '20px', fontWeight: 700 }}>
            {user.totp_enabled ? 'Enabled' : 'Off'}
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{
        display: 'flex',
        gap: '2px',
        marginBottom: '20px',
        background: 'rgba(255,255,255,0.04)',
        borderRadius: '10px',
        padding: '3px',
        border: '1px solid var(--glass-border)',
      }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '5px',
              padding: '8px 8px',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.2s',
              background: activeTab === tab.id ? 'rgba(127,0,255,0.15)' : 'transparent',
              color: activeTab === tab.id ? 'var(--accent-bright)' : 'var(--text-muted)',
              border: activeTab === tab.id ? '1px solid rgba(127,0,255,0.3)' : '1px solid transparent',
              boxShadow: activeTab === tab.id ? '0 0 12px rgba(127,0,255,0.1)' : 'none',
            }}
          >
            {tab.icon}
            {tab.label}
            {tab.id === 'sessions' && sessions.length > 0 && (
              <span style={{
                background: 'rgba(127,0,255,0.3)',
                color: 'var(--accent-bright)',
                fontSize: '11px',
                padding: '1px 6px',
                borderRadius: '10px',
                fontWeight: 600,
              }}>
                {sessions.length}
              </span>
            )}
            {tab.id === 'terminals' && aliveTerminals.length > 0 && (
              <span style={{
                background: 'rgba(127,0,255,0.3)',
                color: 'var(--accent-bright)',
                fontSize: '11px',
                padding: '1px 6px',
                borderRadius: '10px',
                fontWeight: 600,
              }}>
                {aliveTerminals.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'sessions' && (
        <div>
          {sessions.length === 0 ? (
            <div className="stat-card" style={{ padding: '32px', textAlign: 'center' }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ margin: '0 auto 12px' }}>
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
              <p style={{ color: 'var(--text-muted)' }}>No workspace sessions</p>
            </div>
          ) : (
            <div className="glass-table-wrap">
              <table className="glass-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Device</th>
                    <th>Updated</th>
                    <th>Created</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td style={{ fontWeight: 500 }}>{s.name}</td>
                      <td>
                        {s.device_tag ? (
                          <span className="badge active" style={{ fontSize: '11px' }}>{s.device_tag}</span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        )}
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
                        {new Date(s.updated_at).toLocaleString()}
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
                        {new Date(s.created_at).toLocaleString()}
                      </td>
                      <td>
                        <button
                          className="glass-btn danger small"
                          onClick={() => setConfirm({ type: 'delete-session', data: s.id })}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'workspace' && (
        <div>
          <div className="stat-card" style={{ padding: '20px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              </svg>
              <span style={{ color: 'var(--text-primary)', fontSize: '16px', fontWeight: 600 }}>Workspace Info</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '4px' }}>Size</div>
                <div style={{ color: 'var(--text-primary)', fontSize: '18px', fontWeight: 600 }}>{formatBytes(user.workspace_size_bytes)}</div>
              </div>
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '4px' }}>Files</div>
                <div style={{ color: 'var(--text-primary)', fontSize: '18px', fontWeight: 600 }}>{user.workspace_file_count}</div>
              </div>
            </div>
          </div>

          {/* Workspace actions */}
          {!user.is_admin && (
            <div style={{ display: 'flex', gap: '12px' }}>
              <button className="glass-btn danger" onClick={() => setConfirm({ type: 'delete-workspace' })}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
                Clear Workspace
              </button>
              <button className="glass-btn danger" onClick={() => setConfirm({ type: 'delete-user' })}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2" />
                  <circle cx="8.5" cy="7" r="4" />
                  <line x1="18" y1="8" x2="23" y2="13" />
                  <line x1="23" y1="8" x2="18" y2="13" />
                </svg>
                Delete User
              </button>
            </div>
          )}
        </div>
      )}

      {activeTab === 'terminals' && (
        <div>
          {terminals.length === 0 ? (
            <div className="stat-card" style={{ padding: '32px', textAlign: 'center' }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ margin: '0 auto 12px' }}>
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              <p style={{ color: 'var(--text-muted)' }}>No active terminal sessions</p>
            </div>
          ) : (
            <div className="glass-table-wrap">
              <table className="glass-table">
                <thead>
                  <tr>
                    <th>PID</th>
                    <th>Instance</th>
                    <th>Status</th>
                    <th>CPU</th>
                    <th>RAM</th>
                    <th>Command</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {terminals.map((t) => {
                    const canKill = t.status === 'offline';
                    const statusBadge = t.status === 'active'
                      ? 'active'
                      : t.status === 'hidden' ? 'warning' : '';
                    const statusLabel = t.status === 'active'
                      ? `Active (${t.writer_count})`
                      : t.status === 'hidden' ? 'Hidden' : 'Offline';
                    return (
                      <tr key={t.session_key}>
                        <td style={{ fontFamily: 'monospace', fontSize: '13px' }}>{t.pid || '—'}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: '13px' }}>{t.instance_id}</td>
                        <td>
                          <span className={`badge ${statusBadge}`} style={t.status === 'offline' ? { color: 'var(--text-muted)' } : undefined}>
                            {statusLabel}
                          </span>
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: '13px', color: t.cpu_percent > 50 ? 'var(--warning)' : 'var(--text-primary)' }}>
                          {t.cpu_percent.toFixed(1)}%
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: '13px' }}>
                          {t.memory_rss_bytes > 0 ? formatBytes(t.memory_rss_bytes) : '—'}
                        </td>
                        <td style={{ color: 'var(--text-muted)', fontSize: '12px', fontFamily: 'monospace', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {t.command || '—'}
                        </td>
                        <td>
                          <button
                            className="glass-btn danger small"
                            onClick={() => setConfirm({ type: 'kill-terminal', data: t.instance_id })}
                            disabled={!canKill}
                            title={canKill ? 'Kill terminal' : 'Cannot kill: user is online'}
                            style={!canKill ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                          >
                            Kill
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!confirm}
        title={
          confirm?.type === 'delete-user' ? 'Delete User' :
          confirm?.type === 'delete-workspace' ? 'Clear Workspace' :
          confirm?.type === 'delete-session' ? 'Delete Session' : 'Kill Terminal'
        }
        message={
          confirm?.type === 'delete-user' ? `Permanently delete "${user.username}" and all their data?` :
          confirm?.type === 'delete-workspace' ? `Clear all files in "${user.username}" workspace?` :
          confirm?.type === 'delete-session' ? `Delete this workspace session?` :
          `Kill terminal "${confirm?.data}"?`
        }
        confirmLabel={confirm?.type === 'kill-terminal' ? 'Kill' : 'Delete'}
        onConfirm={handleConfirm}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
