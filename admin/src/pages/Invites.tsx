import { useEffect, useState } from 'react';
import { getInvites, createInvite, deleteInvite, type Invite } from '../api/admin';

export default function Invites() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () => {
    getInvites().then((r) => setInvites(r.data));
  };

  useEffect(load, []);

  const handleCreate = async () => {
    setCreating(true);
    try {
      await createInvite();
      load();
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopied(code);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleDelete = async (id: string) => {
    await deleteInvite(id);
    load();
  };

  const now = new Date();

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h1 className="page-heading" style={{ marginBottom: 0 }}>Invite Codes</h1>
        <button className="glass-btn primary" onClick={handleCreate} disabled={creating}>
          {creating ? 'Creating...' : '+ New Invite'}
        </button>
      </div>

      <div className="glass-table-wrap">
        <table className="glass-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Status</th>
              <th>Expires</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {invites.map((inv) => {
              const expired = new Date(inv.expires_at) < now;
              const used = !!inv.used_by;
              return (
                <tr key={inv.id}>
                  <td>
                    <code style={{ fontSize: '13px', color: 'var(--accent-bright)' }}>{inv.code}</code>
                  </td>
                  <td>
                    {used ? (
                      <span className="badge">Used</span>
                    ) : expired ? (
                      <span className="badge danger">Expired</span>
                    ) : (
                      <span className="badge active">Active</span>
                    )}
                  </td>
                  <td style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
                    {new Date(inv.expires_at).toLocaleString()}
                  </td>
                  <td style={{ display: 'flex', gap: '8px' }}>
                    {!used && !expired && (
                      <button className="glass-btn small" onClick={() => handleCopy(inv.code)}>
                        {copied === inv.code ? 'Copied!' : 'Copy'}
                      </button>
                    )}
                    <button className="glass-btn danger small" onClick={() => handleDelete(inv.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
            {invites.length === 0 && (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px' }}>
                  No invites yet. Create one to invite users.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
