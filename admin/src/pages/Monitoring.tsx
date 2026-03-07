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

const MAX_HISTORY = 60; // 60 points × 5s = 5 minutes
const ACID_GREEN = '#39ff14';


function CpuChart({ history }: { history: number[] }) {
  const w = 600;
  const h = 140;
  const padL = 36;
  const padR = 8;
  const padT = 8;
  const padB = 24;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  const points = history.map((val, i) => {
    const x = padL + (i / (MAX_HISTORY - 1)) * chartW;
    const y = padT + chartH - (Math.min(val, 100) / 100) * chartH;
    return `${x},${y}`;
  });

  const linePath = points.length > 1 ? `M${points.join('L')}` : '';
  const areaPath = points.length > 1
    ? `M${padL + (0 / (MAX_HISTORY - 1)) * chartW},${padT + chartH}L${points.join('L')}L${padL + ((history.length - 1) / (MAX_HISTORY - 1)) * chartW},${padT + chartH}Z`
    : '';

  const gridLines = [0, 25, 50, 75, 100];

  return (
    <div className="stat-card" style={{ padding: '16px', marginBottom: '28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={ACID_GREEN} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
          <span style={{ color: 'var(--text-primary)', fontSize: '15px', fontWeight: 600 }}>CPU Load</span>
        </div>
        <span style={{
          color: ACID_GREEN,
          fontSize: '22px',
          fontWeight: 700,
          fontFamily: 'monospace',
          textShadow: `0 0 8px rgba(57,255,20,0.5)`,
        }}>
          {history.length > 0 ? history[history.length - 1].toFixed(1) + '%' : '—'}
        </span>
      </div>

      <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: 'block' }}>
        <defs>
          <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ACID_GREEN} stopOpacity="0.3" />
            <stop offset="100%" stopColor={ACID_GREEN} stopOpacity="0.02" />
          </linearGradient>
          <filter id="glow">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Grid lines */}
        {gridLines.map((val) => {
          const y = padT + chartH - (val / 100) * chartH;
          return (
            <g key={val}>
              <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
              <text x={padL - 6} y={y + 4} fill="rgba(255,255,255,0.3)" fontSize="10" textAnchor="end" fontFamily="monospace">
                {val}%
              </text>
            </g>
          );
        })}

        {/* Time labels */}
        <text x={padL} y={h - 4} fill="rgba(255,255,255,0.25)" fontSize="9" fontFamily="monospace">5m ago</text>
        <text x={w - padR} y={h - 4} fill="rgba(255,255,255,0.25)" fontSize="9" textAnchor="end" fontFamily="monospace">now</text>

        {/* Area fill */}
        {areaPath && (
          <path d={areaPath} fill="url(#cpuGrad)" />
        )}

        {/* Line */}
        {linePath && (
          <path d={linePath} fill="none" stroke={ACID_GREEN} strokeWidth="2" filter="url(#glow)" strokeLinejoin="round" />
        )}

        {/* Current value dot */}
        {history.length > 0 && (
          <circle
            cx={padL + ((history.length - 1) / (MAX_HISTORY - 1)) * chartW}
            cy={padT + chartH - (Math.min(history[history.length - 1], 100) / 100) * chartH}
            r="4"
            fill={ACID_GREEN}
            style={{ filter: `drop-shadow(0 0 6px ${ACID_GREEN})` }}
          />
        )}
      </svg>
    </div>
  );
}

export default function Monitoring() {
  const [data, setData] = useState<MonitoringData | null>(null);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const cpuHistoryRef = useRef<number[]>([]);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);

  const fetchData = () => {
    getMonitoring()
      .then((r) => {
        setData(r.data);
        setError('');
        // Accumulate CPU history
        const cpu = r.data.system.cpu_percent ?? 0;
        const hist = [...cpuHistoryRef.current, cpu];
        if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
        cpuHistoryRef.current = hist;
        setCpuHistory(hist);
      })
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
        <h1 style={{ color: 'var(--text-primary)', fontSize: '24px', fontWeight: 700 }}>
          Нагрузка
        </h1>
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
          {/* CPU Chart */}
          <CpuChart history={cpuHistory} />

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
