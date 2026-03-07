import { useEffect, useState } from 'react';
import { getStats, type Stats } from '../api/admin';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    getStats().then((r) => setStats(r.data));
  }, []);

  const cards = stats
    ? [
        { label: 'Users', value: stats.total_users, icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z' },
        { label: 'Workspace Size', value: formatBytes(stats.total_workspaces_size), icon: 'M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7M4 7l8-4 8 4M4 7l8 4 8-4' },
        { label: 'Active PTY', value: stats.active_pty_count, icon: 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z' },
        { label: 'Pending Invites', value: stats.invites_pending, icon: 'M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z' },
      ]
    : [];

  return (
    <div>
      <h1 style={{ color: 'var(--text-primary)', fontSize: '24px', fontWeight: 700, marginBottom: '24px' }}>
        Dashboard
      </h1>

      {!stats ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading...</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {cards.map((card) => (
            <div key={card.label} className="stat-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d={card.icon} />
                </svg>
                <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>{card.label}</span>
              </div>
              <div style={{ color: 'var(--text-primary)', fontSize: '28px', fontWeight: 700 }}>{card.value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
