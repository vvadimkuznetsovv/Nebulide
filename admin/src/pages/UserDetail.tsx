import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getUser, getUserTerminals, killTerminal, deleteWorkspace, deleteUser, type UserDetail as UserDetailType, type TerminalSession } from '../api/admin';
import ConfirmDialog from '../components/ConfirmDialog';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export default function UserDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [user, setUser] = useState<UserDetailType | null>(null);
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const [confirm, setConfirm] = useState<{ type: string; data?: string } | null>(null);

  const load = () => {
    if (!id) return;
    getUser(id).then((r) => setUser(r.data));
    getUserTerminals(id).then((r) => setTerminals(r.data));
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
    }
    setConfirm(null);
  };

  if (!user) return <p style={{ color: 'var(--text-muted)' }}>Loading...</p>;

  return (
    <div>
      <button className="glass-btn small" onClick={() => navigate('/users')} style={{ marginBottom: '16px' }}>
        &larr; Back
      </button>

      <h1 style={{ color: 'var(--text-primary)', fontSize: '24px', fontWeight: 700, marginBottom: '4px' }}>
        {user.username}
        {user.is_admin && <span className="badge admin" style={{ marginLeft: '12px', fontSize: '12px' }}>Admin</span>}
      </h1>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '24px' }}>Created: {user.created_at}</p>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4" style={{ marginBottom: '24px' }}>
        <div className="stat-card">
          <div style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '4px' }}>Workspace</div>
          <div style={{ color: 'var(--text-primary)', fontSize: '22px', fontWeight: 700 }}>
            {formatBytes(user.workspace_size_bytes)}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{user.workspace_file_count} files</div>
        </div>
        <div className="stat-card">
          <div style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '4px' }}>Active PTY</div>
          <div style={{ color: 'var(--text-primary)', fontSize: '22px', fontWeight: 700 }}>{user.active_pty_count}</div>
        </div>
        <div className="stat-card">
          <div style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '4px' }}>2FA</div>
          <div style={{ color: user.totp_enabled ? 'var(--success)' : 'var(--text-muted)', fontSize: '22px', fontWeight: 700 }}>
            {user.totp_enabled ? 'Enabled' : 'Off'}
          </div>
        </div>
      </div>

      {/* Terminals */}
      <h2 style={{ color: 'var(--text-primary)', fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>
        Terminal Sessions
      </h2>
      {terminals.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', marginBottom: '24px' }}>No active terminals</p>
      ) : (
        <div className="glass-table-wrap" style={{ marginBottom: '24px' }}>
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
              {terminals.map((t) => (
                <tr key={t.session_key}>
                  <td style={{ fontFamily: 'monospace', fontSize: '13px' }}>{t.pid || '—'}</td>
                  <td style={{ fontFamily: 'monospace' }}>{t.instance_id}</td>
                  <td>
                    <span className={`badge ${t.alive ? 'active' : ''}`}>{t.alive ? 'Alive' : 'Dead'}</span>
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: '13px' }}>
                    {t.cpu_percent > 0 ? t.cpu_percent.toFixed(1) + '%' : '—'}
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
                    >
                      Kill
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Actions */}
      {!user.is_admin && (
        <div style={{ display: 'flex', gap: '12px' }}>
          <button className="glass-btn danger" onClick={() => setConfirm({ type: 'delete-workspace' })}>
            Clear Workspace
          </button>
          <button className="glass-btn danger" onClick={() => setConfirm({ type: 'delete-user' })}>
            Delete User
          </button>
        </div>
      )}

      <ConfirmDialog
        open={!!confirm}
        title={
          confirm?.type === 'delete-user' ? 'Delete User' :
          confirm?.type === 'delete-workspace' ? 'Clear Workspace' : 'Kill Terminal'
        }
        message={
          confirm?.type === 'delete-user' ? `Permanently delete "${user.username}" and all their data?` :
          confirm?.type === 'delete-workspace' ? `Clear all files in "${user.username}" workspace?` :
          `Kill terminal "${confirm?.data}"?`
        }
        confirmLabel={confirm?.type === 'kill-terminal' ? 'Kill' : 'Delete'}
        onConfirm={handleConfirm}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
