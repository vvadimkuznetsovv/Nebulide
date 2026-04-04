import { useState, useEffect, useCallback } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import MegaLogo from './MegaLogo';
import { useAuthStore } from '../store/authStore';
import { logout } from '../api/auth';

const ACCENT_PRESETS = [
  { name: 'Purple', hex: '#7F00FF' },
  { name: 'Blue', hex: '#0066FF' },
  { name: 'Cyan', hex: '#00B4D8' },
  { name: 'Green', hex: '#00CC66' },
  { name: 'Pink', hex: '#FF0099' },
  { name: 'Red', hex: '#FF3355' },
  { name: 'Orange', hex: '#FF6600' },
  { name: 'Gold', hex: '#CCAA00' },
];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function applyAccent(hex: string) {
  const [r, g, b] = hexToRgb(hex);
  const root = document.documentElement;
  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
  root.style.setProperty('--blob-glow-rgb', `${r}, ${g}, ${b}`);
  localStorage.setItem('mega-accent', hex);
}

function loadAdminTheme() {
  const accent = localStorage.getItem('mega-accent');
  if (accent) applyAccent(accent);
}
loadAdminTheme();

const navItems = [
  { to: '/', label: 'Dashboard', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4' },
  { to: '/users', label: 'Users', icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z' },
  { to: '/invites', label: 'Invites', icon: 'M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z' },
  { to: '/monitoring', label: 'Monitoring', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
];

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [blobsOn, setBlobsOn] = useState(() => localStorage.getItem('mega-blobs') !== 'false');
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem('mega-accent') || '#7F00FF');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const toggleBlobs = useCallback(() => {
    const next = !blobsOn;
    setBlobsOn(next);
    localStorage.setItem('mega-blobs', String(next));
    const lamp = document.querySelector('.lava-lamp') as HTMLElement;
    if (lamp) lamp.style.display = next ? '' : 'none';
  }, [blobsOn]);

  const changeAccent = useCallback((hex: string) => {
    setAccentColor(hex);
    applyAccent(hex);
  }, []);

  // Close sidebar on navigation (mobile)
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  const handleLogout = async () => {
    try { await logout(); } catch { /* ignore */ }
    clearAuth();
    navigate('/login');
  };

  return (
    <div className="min-h-screen flex" style={{ position: 'relative' }}>
      {/* Lava lamp background */}
      <div className="lava-lamp" style={{ display: blobsOn ? undefined : 'none' }}>
        <div className="lava-blob lava-blob-1" />
        <div className="lava-blob lava-blob-2" />
        <div className="lava-blob lava-blob-3" />
        <div className="lava-blob lava-blob-4" />
        <div className="lava-blob lava-blob-5" />
        <div className="lava-blob lava-blob-6" />
        <div className="lava-glow" />
      </div>

      {/* Mobile hamburger button */}
      <button
        className="mobile-hamburger"
        onClick={() => setSidebarOpen(true)}
        aria-label="Open menu"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="sidebar-overlay"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`admin-sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div style={{ padding: '20px 16px', borderBottom: '1px solid var(--glass-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <MegaLogo />
          <button
            className="sidebar-close-btn"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <nav className="flex-1" style={{ padding: '12px 8px' }}>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d={item.icon} />
              </svg>
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Settings */}
        <div style={{ padding: '8px', borderTop: '1px solid var(--glass-border)' }}>
          <button className="nav-link" onClick={() => setSettingsOpen(v => !v)} style={{ width: '100%' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Settings
          </button>
          {settingsOpen && (
            <div style={{ padding: '8px 4px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* Blobs toggle */}
              <div
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', borderRadius: 8, background: 'rgba(0,0,0,0.2)', cursor: 'pointer' }}
                onClick={toggleBlobs}
              >
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Background blobs</span>
                <div style={{ width: 32, height: 18, borderRadius: 9, background: blobsOn ? 'var(--accent)' : 'rgba(255,255,255,0.1)', position: 'relative', transition: 'background 0.2s' }}>
                  <div style={{ position: 'absolute', top: 2, width: 14, height: 14, borderRadius: 7, background: 'white', transition: 'transform 0.2s', transform: blobsOn ? 'translateX(16px)' : 'translateX(2px)' }} />
                </div>
              </div>
              {/* Accent color */}
              <div style={{ padding: '4px 8px' }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>Accent color</div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {ACCENT_PRESETS.map((p) => (
                    <button
                      key={p.hex}
                      type="button"
                      onClick={() => changeAccent(p.hex)}
                      title={p.name}
                      style={{
                        width: 22, height: 22, borderRadius: '50%', background: p.hex, border: 'none', cursor: 'pointer',
                        outline: accentColor === p.hex ? '2px solid white' : 'none',
                        outlineOffset: 2,
                        boxShadow: accentColor === p.hex ? `0 0 8px ${p.hex}` : 'none',
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: '8px', borderTop: '1px solid var(--glass-border)' }}>
          <button className="nav-link" onClick={handleLogout} style={{ width: '100%' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
            Logout
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="admin-main flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
