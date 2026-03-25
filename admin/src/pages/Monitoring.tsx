import { useEffect, useState, useRef, useMemo } from 'react';
import { getMonitoring, killTerminal, forceKillTerminal, killProcess, type MonitoringData, type ProcessInfo } from '../api/admin';
import ConfirmDialog from '../components/ConfirmDialog';

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

type SortKey = 'pid' | 'username' | 'cpu_percent' | 'memory_rss_bytes' | 'command' | 'status' | 'writer_count';
type FilterType = 'all' | 'user' | 'system';
type StatusFilter = 'all' | 'active' | 'hidden' | 'offline' | 'system';

const ACID_GREEN = '#39ff14';

export default function Monitoring() {
  const [data, setData] = useState<MonitoringData | null>(null);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  // New state
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');
  const [sortBy, setSortBy] = useState<SortKey>('memory_rss_bytes');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [confirm, setConfirm] = useState<{ userId: string; instanceId: string; command: string; force: boolean; pid?: number } | null>(null);
  const [killing, setKilling] = useState(false);

  const fetchData = () => {
    getMonitoring()
      .then((r) => { setData(r.data); setError(''); })
      .catch(() => setError('Failed to load monitoring data'));
  };

  useEffect(() => { fetchData(); }, []);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchData, 5000);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh]);

  const handleKill = async () => {
    if (!confirm) return;
    setKilling(true);
    try {
      if (confirm.pid && !confirm.instanceId) {
        await killProcess(confirm.pid);
      } else if (confirm.force) {
        await forceKillTerminal(confirm.userId, confirm.instanceId);
      } else {
        await killTerminal(confirm.userId, confirm.instanceId);
      }
      fetchData();
    } catch {
      setError('Failed to kill');
    }
    setKilling(false);
    setConfirm(null);
  };

  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(key);
      setSortDir('desc');
    }
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortBy !== col) return <span style={{ opacity: 0.3, marginLeft: '4px' }}>↕</span>;
    return <span style={{ marginLeft: '4px' }}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  // Filtered + sorted processes
  const processes = useMemo(() => {
    if (!data) return [];
    let list = [...data.processes];

    // Filter by type
    if (filter === 'user') list = list.filter(p => p.session_key);
    else if (filter === 'system') list = list.filter(p => !p.session_key);

    // Filter by status
    if (statusFilter !== 'all') list = list.filter(p => p.status === statusFilter);

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(p =>
        String(p.pid).includes(q) ||
        p.username.toLowerCase().includes(q) ||
        p.command.toLowerCase().includes(q) ||
        p.instance_id.toLowerCase().includes(q) ||
        p.session_key.toLowerCase().includes(q)
      );
    }

    // Sort
    list.sort((a, b) => {
      let va: string | number, vb: string | number;
      switch (sortBy) {
        case 'pid': va = a.pid; vb = b.pid; break;
        case 'username': va = a.username.toLowerCase(); vb = b.username.toLowerCase(); break;
        case 'cpu_percent': va = a.cpu_percent; vb = b.cpu_percent; break;
        case 'memory_rss_bytes': va = a.memory_rss_bytes; vb = b.memory_rss_bytes; break;
        case 'command': va = a.command.toLowerCase(); vb = b.command.toLowerCase(); break;
        case 'status': va = a.status; vb = b.status; break;
        case 'writer_count': va = a.writer_count; vb = b.writer_count; break;
        default: va = 0; vb = 0;
      }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    return list;
  }, [data, filter, statusFilter, search, sortBy, sortDir]);

  const cpuPercent = data?.system.cpu_percent ?? 0;
  const memPercent = data?.system.mem_percent ?? 0;
  const diskPercent = data?.system.disk_percent ?? 0;

  const filterBtnStyle = (active: boolean) => ({
    padding: '5px 12px',
    borderRadius: '6px',
    fontSize: '12px',
    fontWeight: 500 as const,
    cursor: 'pointer' as const,
    transition: 'all 0.2s',
    background: active ? 'rgba(127,0,255,0.2)' : 'rgba(255,255,255,0.04)',
    color: active ? 'var(--accent-bright)' : 'var(--text-muted)',
    border: active ? '1px solid rgba(127,0,255,0.4)' : '1px solid var(--glass-border)',
  });

  const statusBadge = (p: ProcessInfo) => {
    if (p.status === 'active') return <span className="badge active">Active ({p.writer_count})</span>;
    if (p.status === 'hidden') return <span className="badge warning">Hidden</span>;
    if (p.status === 'system') return <span className="badge" style={{ background: 'rgba(100,100,255,0.15)', color: '#8888ff' }}>System</span>;
    return <span style={{ color: 'var(--text-muted)' }}>Offline</span>;
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <h1 className="page-heading" style={{ marginBottom: 0 }}>Нагрузка</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button className="glass-btn small" onClick={fetchData} title="Refresh">
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

          {/* Processes header + controls */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
            <h2 style={{ color: 'var(--text-primary)', fontSize: '18px', fontWeight: 600, margin: 0 }}>
              Процессы ({processes.length}{processes.length !== data.processes.length ? ` / ${data.processes.length}` : ''})
            </h2>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              {/* Filter buttons */}
              <button style={filterBtnStyle(filter === 'all')} onClick={() => setFilter('all')}>All</button>
              <button style={filterBtnStyle(filter === 'user')} onClick={() => setFilter('user')}>User</button>
              <button style={filterBtnStyle(filter === 'system')} onClick={() => setFilter('system')}>System</button>
              <span style={{ width: '1px', height: '20px', background: 'var(--glass-border)', margin: '0 4px' }} />
              <button style={filterBtnStyle(statusFilter === 'all')} onClick={() => setStatusFilter('all')}>Any</button>
              <button style={filterBtnStyle(statusFilter === 'active')} onClick={() => setStatusFilter('active')}>Active</button>
              <button style={filterBtnStyle(statusFilter === 'hidden')} onClick={() => setStatusFilter('hidden')}>Hidden</button>
              <button style={filterBtnStyle(statusFilter === 'offline')} onClick={() => setStatusFilter('offline')}>Offline</button>
              <button style={filterBtnStyle(statusFilter === 'system')} onClick={() => setStatusFilter('system')}>System</button>

              {/* Search */}
              <div style={{ position: 'relative' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }}>
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search..."
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid var(--glass-border)',
                    borderRadius: '6px',
                    padding: '5px 10px 5px 30px',
                    fontSize: '12px',
                    color: 'var(--text-primary)',
                    width: '180px',
                    outline: 'none',
                  }}
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    style={{
                      position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)',
                      background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
                      fontSize: '14px', padding: '0 2px',
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Processes table */}
          {processes.length === 0 ? (
            <div className="glass-table-wrap" style={{ padding: '32px', textAlign: 'center' }}>
              <p style={{ color: 'var(--text-muted)' }}>
                {search || filter !== 'all' ? 'Ничего не найдено' : 'Нет активных терминальных сессий'}
              </p>
            </div>
          ) : (
            <div className="glass-table-wrap">
              <table className="glass-table">
                <thead>
                  <tr>
                    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('pid')}>
                      PID<SortIcon col="pid" />
                    </th>
                    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('username')}>
                      User<SortIcon col="username" />
                    </th>
                    <th>Instance</th>
                    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('status')}>
                      Status<SortIcon col="status" />
                    </th>
                    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('writer_count')}>
                      WS<SortIcon col="writer_count" />
                    </th>
                    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('cpu_percent')}>
                      CPU<SortIcon col="cpu_percent" />
                    </th>
                    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('memory_rss_bytes')}>
                      RAM<SortIcon col="memory_rss_bytes" />
                    </th>
                    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('command')}>
                      Command<SortIcon col="command" />
                    </th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {processes.map((p) => {
                    const canKill = p.status !== 'active';
                    return (
                      <tr key={p.session_key || `pid-${p.pid}`}>
                        <td style={{ fontFamily: 'monospace', fontSize: '13px' }}>{p.pid || '—'}</td>
                        <td>
                          <button
                            style={{
                              background: 'none', border: 'none', cursor: 'pointer',
                              color: 'var(--text-primary)', fontWeight: 500, padding: 0,
                              textDecoration: 'underline', textDecorationColor: 'rgba(127,0,255,0.3)',
                              textUnderlineOffset: '2px',
                            }}
                            onClick={() => { setSearch(p.username); setFilter('all'); }}
                            title={`Filter by ${p.username}`}
                          >
                            {p.username}
                          </button>
                        </td>
                        <td style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>{p.instance_id}</td>
                        <td>{statusBadge(p)}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: '13px', textAlign: 'center' }}>
                          {p.writer_count > 0
                            ? <span style={{ color: 'var(--success)' }}>{p.writer_count}</span>
                            : <span style={{ color: 'var(--text-muted)' }}>0</span>}
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: '13px', color: p.cpu_percent > 50 ? 'var(--warning)' : 'var(--text-primary)' }}>
                          {p.cpu_percent.toFixed(1)}%
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: '13px' }}>
                          {p.memory_rss_bytes > 0 ? formatBytes(p.memory_rss_bytes) : '—'}
                        </td>
                        <td style={{ color: 'var(--text-muted)', fontSize: '12px', fontFamily: 'monospace', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p.command || '—'}
                        </td>
                        <td style={{ display: 'flex', gap: '4px' }}>
                          {p.session_key ? (
                            <>
                              <button
                                className="glass-btn danger small"
                                onClick={() => setConfirm({ userId: p.user_id, instanceId: p.instance_id, command: p.command, force: false })}
                                disabled={!canKill}
                                title={canKill ? 'Kill (soft)' : 'Cannot kill: user is online'}
                                style={!canKill ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                              >
                                Kill
                              </button>
                              <button
                                className="glass-btn danger small"
                                onClick={() => setConfirm({ userId: p.user_id, instanceId: p.instance_id, command: p.command, force: true })}
                                title="Force kill (ignores online status + writers)"
                                style={{ background: 'rgba(255,0,0,0.2)', borderColor: 'rgba(255,0,0,0.5)' }}
                              >
                                Force
                              </button>
                            </>
                          ) : p.pid > 0 ? (
                            <button
                              className="glass-btn danger small"
                              onClick={() => setConfirm({ userId: '', instanceId: '', command: p.command, force: true, pid: p.pid })}
                              title="Kill process by PID"
                            >
                              Kill
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.force ? 'Force Kill' : 'Kill Terminal'}
        message={confirm ? `${confirm.force ? 'FORCE kill' : 'Kill'} process?\n\n${confirm.command || confirm.instanceId || `PID ${confirm.pid}`}` : ''}
        confirmLabel={killing ? 'Killing...' : confirm?.force ? 'Force Kill' : 'Kill'}
        onConfirm={handleKill}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
