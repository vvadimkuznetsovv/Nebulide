import { useState } from 'react';
import { useAuthStore } from '../../store/authStore';
import { useLayoutStore } from '../../store/layoutStore';
import { logout, totpSetup, totpConfirm, changePassword } from '../../api/auth';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { QRCodeSVG } from 'qrcode.react';
import { panelIcons, panelTitles } from './PanelContent';
import type { BasePanelId } from '../../store/layoutUtils';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

const allPanels: BasePanelId[] = ['chat', 'files', 'editor', 'preview', 'terminal'];

export default function Sidebar({ isOpen, onClose }: SidebarProps) {
  const { visibility, toggleVisibility } = useLayoutStore();
  const [showSettings, setShowSettings] = useState(false);
  const [showTotpSetup, setShowTotpSetup] = useState(false);
  const [totpUrl, setTotpUrl] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpLoading, setTotpLoading] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changePwLoading, setChangePwLoading] = useState(false);
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const navigate = useNavigate();

  const handleTotpSetup = async () => {
    try {
      const { data } = await totpSetup();
      setTotpUrl(data.url);
      setTotpSecret(data.secret);
      setShowTotpSetup(true);
    } catch {
      toast.error('Failed to start 2FA setup');
    }
  };

  const handleTotpConfirm = async () => {
    if (totpCode.length !== 6) return;
    setTotpLoading(true);
    try {
      await totpConfirm(totpCode);
      if (user) setUser({ ...user, totp_enabled: true });
      toast.success('2FA enabled successfully');
      setShowTotpSetup(false);
      setTotpCode('');
      setTotpUrl('');
      setTotpSecret('');
    } catch {
      toast.error('Invalid code, try again');
    } finally {
      setTotpLoading(false);
    }
  };

  const handleBackToSessions = () => {
    setShowSettings(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    if (newPassword.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    setChangePwLoading(true);
    try {
      await changePassword(currentPassword, newPassword);
      toast.success('Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } }; message?: string };
      toast.error(axiosErr.response?.data?.error || 'Failed to change password');
    } finally {
      setChangePwLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
    } catch { /* ignore */ }
    clearAuth();
    navigate('/login');
  };

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 lg:hidden"
          style={{ background: 'rgba(0, 0, 0, 0.6)', WebkitBackdropFilter: 'blur(4px)', backdropFilter: 'blur(4px)' }}
          onClick={onClose}
        />
      )}

      <aside
        className={`fixed lg:static lg:h-full inset-y-0 left-0 z-50 w-64 flex flex-col transition-transform duration-300 lg:translate-x-0 lg:w-full ${
          isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
        style={{
          background: 'rgba(255, 255, 255, 0.03)',
          WebkitBackdropFilter: 'blur(40px)',
          backdropFilter: 'blur(40px)',
          borderRight: '1px solid var(--glass-border)',
        }}
      >
        {/* Header */}
        <div className="p-4 pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div>
                <svg width="30" height="30" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <filter id="sbl-lava" x="-40%" y="-40%" width="180%" height="180%" colorInterpolationFilters="sRGB">
                      <feGaussianBlur in="SourceGraphic" stdDeviation="5.5" result="blur"/>
                      <feColorMatrix in="blur" type="matrix"
                        values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -11"
                        result="merged"/>
                      <feGaussianBlur in="merged" stdDeviation="3"   result="glow1"/>
                      <feGaussianBlur in="merged" stdDeviation="6.5" result="glow2"/>
                      <feMerge>
                        <feMergeNode in="glow2"/>
                        <feMergeNode in="glow1"/>
                        <feMergeNode in="merged"/>
                      </feMerge>
                    </filter>
                  </defs>
                  <g filter="url(#sbl-lava)">
                    <ellipse cx="38" cy="43" rx="19" ry="16" transform="rotate(-20, 38, 43)" fill="#7F00FF"/>
                    <ellipse cx="58" cy="59" rx="15" ry="13" transform="rotate(-8, 58, 59)" fill="#7F00FF"/>
                    <ellipse cx="77" cy="28" rx="10" ry="12" transform="rotate(15, 77, 28)" fill="#7F00FF"/>
                    <ellipse cx="29" cy="78" rx="8" ry="10" transform="rotate(25, 29, 78)" fill="#7F00FF"/>
                  </g>
                </svg>
              </div>
              <h1 className="sidebar-glass-logo">Clauder</h1>
            </div>
            <button
              onClick={onClose}
              className="lg:hidden w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-200"
              style={{
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                color: 'rgba(255, 255, 255, 0.5)',
              }}
              title="Close"
              aria-label="Close sidebar"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Panel toggles */}
        <div className="px-3 py-2 flex items-center gap-1.5">
          {allPanels.map((panel) => (
            <button
              key={panel}
              type="button"
              onClick={() => toggleVisibility(panel)}
              title={`${visibility[panel] ? 'Hide' : 'Show'} ${panelTitles[panel]}`}
              className="w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-200"
              style={{
                background: visibility[panel] ? 'rgba(127, 0, 255, 0.15)' : 'rgba(255, 255, 255, 0.04)',
                border: `1px solid ${visibility[panel] ? 'rgba(127, 0, 255, 0.3)' : 'rgba(255, 255, 255, 0.06)'}`,
                color: visibility[panel] ? 'var(--accent-bright)' : 'rgba(255, 255, 255, 0.35)',
              }}
            >
              {panelIcons[panel]}
            </button>
          ))}
        </div>

        <div className="glass-divider mx-3" />

        {showSettings ? (
          <>
            {/* Settings header */}
            <div className="px-3 py-2 flex items-center gap-2">
              <button
                onClick={handleBackToSessions}
                className="w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-200"
                style={{
                  background: 'rgba(255, 255, 255, 0.06)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  color: 'rgba(255, 255, 255, 0.5)',
                }}
                title="Back to sessions"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Settings</span>
            </div>

            {/* Settings content */}
            <div className="flex-1 overflow-y-auto px-3 py-2 space-y-5">
              {/* Change Password */}
              <div>
                <label className="block text-xs font-semibold mb-3 uppercase tracking-wider" style={{ color: 'var(--text-muted)', fontSize: '11px', letterSpacing: '0.1em' }}>
                  Change Password
                </label>
                <form onSubmit={handleChangePassword} className="space-y-2.5">
                  <div>
                    <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid var(--glass-border)' }}>
                      <input
                        type="password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        placeholder="Current password"
                        autoComplete="current-password"
                        style={{ width: '100%', padding: '10px 12px', fontSize: '13px', background: 'transparent', border: 'none', color: 'var(--text-primary)', outline: 'none' }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid var(--glass-border)' }}>
                      <input
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="New password"
                        autoComplete="new-password"
                        style={{ width: '100%', padding: '10px 12px', fontSize: '13px', background: 'transparent', border: 'none', color: 'var(--text-primary)', outline: 'none' }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid var(--glass-border)' }}>
                      <input
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Confirm new password"
                        autoComplete="new-password"
                        style={{ width: '100%', padding: '10px 12px', fontSize: '13px', background: 'transparent', border: 'none', color: 'var(--text-primary)', outline: 'none' }}
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={changePwLoading || !currentPassword || !newPassword || !confirmPassword}
                    className="w-full py-2.5 rounded-xl text-xs font-bold btn-accent"
                    style={{ opacity: (changePwLoading || !currentPassword || !newPassword || !confirmPassword) ? 0.3 : 1 }}
                  >
                    {changePwLoading ? 'Changing...' : 'Change Password'}
                  </button>
                </form>
              </div>

              <div className="glass-divider" />

              {/* 2FA */}
              <div>
                <label className="block text-xs font-semibold mb-3 uppercase tracking-wider" style={{ color: 'var(--text-muted)', fontSize: '11px', letterSpacing: '0.1em' }}>
                  Two-Factor Authentication
                </label>
                {user?.totp_enabled ? (
                  <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl" style={{ background: 'rgba(74, 222, 128, 0.08)', border: '1px solid rgba(74, 222, 128, 0.2)' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2" strokeLinecap="round">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                    <span className="text-xs font-semibold" style={{ color: 'var(--success)' }}>2FA Enabled</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={handleTotpSetup}
                    className="sidebar-footer-btn w-full py-2.5 rounded-xl text-xs font-semibold"
                    title="Enable two-factor authentication"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                    Setup 2FA
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1" />
        )}

        <div className="glass-divider mx-3" />

        {/* Footer */}
        <div className="p-3 space-y-2">
          <button
            type="button"
            onClick={() => setShowSettings(!showSettings)}
            className={`sidebar-footer-btn w-full py-2.5 rounded-2xl text-xs font-semibold ${showSettings ? 'sidebar-footer-active' : ''}`}
            title="Settings"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Settings
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="sidebar-footer-btn sidebar-footer-danger w-full py-2.5 rounded-2xl text-xs font-semibold"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Logout
          </button>
        </div>
      </aside>

      {/* TOTP Setup Modal */}
      {showTotpSetup && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          style={{ background: 'rgba(0, 0, 0, 0.7)', WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)' }}
          onClick={() => { setShowTotpSetup(false); setTotpCode(''); }}
        >
          <div
            className="liquid-glass w-full max-w-sm rounded-3xl p-8"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-2 text-center" style={{ color: 'var(--text-primary)' }}>
              Setup 2FA
            </h2>
            <p className="text-sm mb-6 text-center" style={{ color: 'var(--text-secondary)' }}>
              Scan the QR code with your authenticator app
            </p>

            <div className="flex justify-center mb-4">
              <div className="p-3 rounded-2xl" style={{ background: 'white' }}>
                <QRCodeSVG value={totpUrl} size={180} />
              </div>
            </div>

            <div className="mb-6">
              <p className="text-xs mb-2 text-center" style={{ color: 'var(--text-muted)' }}>
                Or enter this secret manually:
              </p>
              <div
                className="rounded-xl p-3 text-center select-all cursor-pointer"
                style={{
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid var(--glass-border)',
                  fontFamily: "'SF Mono','JetBrains Mono',monospace",
                  fontSize: '12px',
                  color: 'var(--accent-bright)',
                  letterSpacing: '0.05em',
                  wordBreak: 'break-all',
                }}
                title="Click to select"
              >
                {totpSecret}
              </div>
            </div>

            <div className="mb-4">
              <label className="block text-xs font-semibold mb-2 uppercase tracking-wider" style={{ color: 'var(--text-muted)', paddingLeft: '4px' }}>
                Verification Code
              </label>
              <div
                className="rounded-xl overflow-hidden"
                style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid var(--glass-border)' }}
              >
                <input
                  type="text"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  maxLength={6}
                  autoFocus
                  autoComplete="off"
                  style={{
                    width: '100%', padding: '14px', fontSize: '24px', textAlign: 'center',
                    letterSpacing: '0.4em', fontFamily: "'SF Mono','JetBrains Mono',monospace",
                    fontWeight: 700, background: 'transparent', border: 'none',
                    color: 'var(--text-primary)', outline: 'none',
                  }}
                />
              </div>
            </div>

            <div className="space-y-2">
              <button
                type="button"
                onClick={handleTotpConfirm}
                disabled={totpLoading || totpCode.length !== 6}
                className="w-full py-3 rounded-xl text-sm font-bold btn-accent"
                style={{ opacity: (totpLoading || totpCode.length !== 6) ? 0.3 : 1 }}
              >
                {totpLoading ? 'Verifying...' : 'Enable 2FA'}
              </button>
              <button
                type="button"
                onClick={() => { setShowTotpSetup(false); setTotpCode(''); }}
                className="w-full py-2.5 rounded-xl text-sm font-medium btn-glass"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
