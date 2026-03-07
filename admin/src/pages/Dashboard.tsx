import { useEffect, useState, useRef } from 'react';
import { getStats, getMonitoring, type Stats } from '../api/admin';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

const MAX_HISTORY = 60;
const ACID_GREEN = '#39ff14';

function CpuChart({ history }: { history: number[] }) {
  const w = 600;
  const h = 120;
  const padL = 36;
  const padR = 8;
  const padT = 6;
  const padB = 20;
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

      <text x={padL} y={h - 2} fill="rgba(255,255,255,0.25)" fontSize="9" fontFamily="monospace">5m ago</text>
      <text x={w - padR} y={h - 2} fill="rgba(255,255,255,0.25)" fontSize="9" textAnchor="end" fontFamily="monospace">now</text>

      {areaPath && <path d={areaPath} fill="url(#cpuGrad)" />}
      {linePath && <path d={linePath} fill="none" stroke={ACID_GREEN} strokeWidth="2" filter="url(#glow)" strokeLinejoin="round" />}

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
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const cpuHistoryRef = useRef<number[]>([]);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [cpuPercent, setCpuPercent] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    getStats().then((r) => setStats(r.data));

    const fetchCpu = () => {
      getMonitoring().then((r) => {
        const cpu = r.data.system.cpu_percent ?? 0;
        setCpuPercent(cpu);
        const hist = [...cpuHistoryRef.current, cpu];
        if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
        cpuHistoryRef.current = hist;
        setCpuHistory(hist);
      }).catch(() => {});
    };

    fetchCpu();
    intervalRef.current = setInterval(fetchCpu, 5000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
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
      <h1 className="page-heading">Dashboard</h1>

      {!stats ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading...</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" style={{ marginBottom: '24px' }}>
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

      {/* CPU Load Chart */}
      <div className="stat-card" style={{ padding: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
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
            textShadow: '0 0 8px rgba(57,255,20,0.5)',
          }}>
            {cpuPercent > 0 ? cpuPercent.toFixed(1) + '%' : '—'}
          </span>
        </div>
        <CpuChart history={cpuHistory} />
      </div>
    </div>
  );
}
