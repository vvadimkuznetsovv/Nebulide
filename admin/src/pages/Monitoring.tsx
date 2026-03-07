import { useEffect, useState, useRef } from 'react';
import { getMonitoring, type MonitoringData } from '../api/admin';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function ProgressBar({ percent, color }: { percent: number; color: string }) {
  return (
    <div style={{
      height: '6px',
      background: 'rgba(255,255,255,0.08)',
      borderRadius: '3px',
      overflow: 'hidden',
      marginTop: '8px',
    }}>
      <div style={{
        height: '100%',
        width: `${Math.min(percent, 100)}%`,
        background: color,
        borderRadius: '3px',
        transition: 'width 0.5s ease',
      }} />
    </div>
  );
}

const ACID_GREEN = '#39ff14';

export default function Monitoring() {
  const [data, setData] = useState<MonitoringData | null>(null);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const fetchData = () => {
    getMonitoring()
      .then((r) => { setData(r.data); setError(''); })
      .catch(() => setError('Failed to load monitoring data'));
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchData, 5000);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh]);

  const cpuPercent = data?.system.cpu_percent ?? 0;
  const memPercent = data?.system.mem_percent ?? 0;
  const diskPercent = data?.system.disk_percent ?? 0;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <h1 className="page-heading" style={{ marginBottom: 0 }}>Нагрузка</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            className="glass-btn small"
            onClick={fetchData}
            title="Refresh"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              style={{ accentColor: 'var(--accent)' }}
            />
            Авто (5с)
          </label>
        </div>
      </div>

      {error && (
        <p style={{ color: 'var(--danger)', marginBottom: '16px' }}>{error}</p>
      )}

      {!data ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading...</p>
      ) : (
        <>
          {/* System stats cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" style={{ marginBottom: '28px' }}>
            {/* CPU */}
            <div className="stat-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <rect x="9" y="9" width="6" height="6" />
                  <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                  <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                  <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="15" x2="23" y2="15" />
                  <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="15" x2="4" y2="15" />
                </svg>
                <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>CPU</span>
              </div>
              <div style={{ color: ACID_GREEN, fontSize: '28px', fontWeight: 700, textShadow: `0 0 10px rgba(57,255,20,0.4)` }}>
                {cpuPercent.toFixed(1)}%
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '2px' }}>
                {data.system.cpu_count} cores
              </div>
              <ProgressBar percent={cpuPercent} color={ACID_GREEN} />
            </div>

            {/* Memory */}
            <div className="stat-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 19v-8a2 2 0 012-2h8a2 2 0 012 2v8" />
                  <path d="M6 19h12" />
                  <path d="M2 19h20" />
                  <rect x="8" y="5" width="8" height="4" rx="1" />
                </svg>
                <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Memory</span>
              </div>
              <div style={{ color: 'var(--text-primary)', fontSize: '28px', fontWeight: 700 }}>
                {memPercent.toFixed(0)}%
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '2px' }}>
                {formatBytes(data.system.mem_used_bytes)} / {formatBytes(data.system.mem_total_bytes)}
              </div>
              <ProgressBar percent={memPercent} color={memPercent > 85 ? 'var(--danger)' : memPercent > 60 ? 'var(--warning)' : 'var(--success)'} />
            </div>

            {/* Disk */}
            <div className="stat-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
                  <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                  <line x1="12" y1="22.08" x2="12" y2="12" />
                </svg>
                <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Disk</span>
              </div>
              {data.system.disk_total_bytes > 0 ? (
                <>
                  <div style={{ color: 'var(--text-primary)', fontSize: '28px', fontWeight: 700 }}>
                    {diskPercent.toFixed(0)}%
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '2px' }}>
                    {formatBytes(data.system.disk_used_bytes)} / {formatBytes(data.system.disk_total_bytes)}
                  </div>
                  <ProgressBar percent={diskPercent} color={diskPercent > 85 ? 'var(--danger)' : diskPercent > 60 ? 'var(--warning)' : 'var(--success)'} />
                </>
              ) : (
                <div style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '4px' }}>N/A (Linux only)</div>
              )}
            </div>

            {/* Goroutines */}
            <div className="stat-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                </svg>
                <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Goroutines</span>
              </div>
              <div style={{ color: 'var(--text-primary)', fontSize: '28px', fontWeight: 700 }}>{data.system.goroutines}</div>
            </div>
          </div>

          {/* Processes table */}
          <h2 style={{ color: 'var(--text-primary)', fontSize: '18px', fontWeight: 600, marginBottom: '16px' }}>
            Процессы ({data.processes.length})
          </h2>

          {data.processes.length === 0 ? (
            <div className="glass-table-wrap" style={{ padding: '32px', textAlign: 'center' }}>
              <p style={{ color: 'var(--text-muted)' }}>Нет активных терминальных сессий</p>
            </div>
          ) : (
            <div className="glass-table-wrap">
              <table className="glass-table">
                <thead>
                  <tr>
                    <th>PID</th>
                    <th>User</th>
                    <th>Instance</th>
                    <th>Status</th>
                    <th>CPU</th>
                    <th>RAM</th>
                    <th>Command</th>
                  </tr>
                </thead>
                <tbody>
                  {data.processes.map((p) => (
                    <tr key={p.session_key}>
                      <td style={{ fontFamily: 'monospace', fontSize: '13px' }}>{p.pid || '—'}</td>
                      <td>
                        <span style={{ fontWeight: 500 }}>{p.username}</span>
                      </td>
                      <td style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>{p.instance_id}</td>
                      <td>
                        <span className={`badge ${p.alive ? 'active' : 'danger'}`}>
                          {p.alive ? 'alive' : 'dead'}
                        </span>
                      </td>
                      <td style={{ fontFamily: 'monospace', fontSize: '13px', color: p.cpu_percent > 50 ? 'var(--warning)' : 'var(--text-primary)' }}>
                        {p.cpu_percent > 0 ? p.cpu_percent.toFixed(1) + '%' : '—'}
                      </td>
                      <td style={{ fontFamily: 'monospace', fontSize: '13px' }}>
                        {p.memory_rss_bytes > 0 ? formatBytes(p.memory_rss_bytes) : '—'}
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: '12px', fontFamily: 'monospace', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.command || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
