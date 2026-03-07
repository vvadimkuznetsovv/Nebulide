import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getUsers, deleteUser, type UserListItem } from '../api/admin';
import ConfirmDialog from '../components/ConfirmDialog';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export default function Users() {
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<UserListItem | null>(null);
  const navigate = useNavigate();

  const loadUsers = () => {
    getUsers().then((r) => setUsers(r.data));
  };

  useEffect(loadUsers, []);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteUser(deleteTarget.id);
    setDeleteTarget(null);
    loadUsers();
  };

  return (
    <div>
      <h1 style={{ color: 'var(--text-primary)', fontSize: '24px', fontWeight: 700, marginBottom: '24px' }}>
        Users
      </h1>

      <div className="glass-table-wrap">
        <table className="glass-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Created</th>
              <th>Workspace</th>
              <th>PTY</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} onClick={() => navigate(`/users/${user.id}`)} style={{ cursor: 'pointer' }}>
                <td style={{ fontWeight: 600 }}>{user.username}</td>
                <td>
                  {user.is_admin ? (
                    <span className="badge admin">Admin</span>
                  ) : (
                    <span className="badge user">User</span>
                  )}
                </td>
                <td style={{ color: 'var(--text-muted)' }}>{user.created_at}</td>
                <td>{formatBytes(user.workspace_size_bytes)}</td>
                <td>
                  {user.active_pty_count > 0 ? (
                    <span className="badge active">{user.active_pty_count}</span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>0</span>
                  )}
                </td>
                <td>
                  {!user.is_admin && (
                    <button
                      className="glass-btn danger small"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(user);
                      }}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete User"
        message={`Delete user "${deleteTarget?.username}"? This will remove their account, workspace, and all data.`}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
