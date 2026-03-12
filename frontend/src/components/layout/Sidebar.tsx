import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAuthStore } from '../../store/authStore';
import { useLayoutStore } from '../../store/layoutStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { useWorkspaceSessionStore } from '../../store/workspaceSessionStore';
import { logout, totpSetup, totpConfirm, changePassword, updateTelegramId } from '../../api/auth';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { QRCodeSVG } from 'qrcode.react';
import { panelIcons, panelTitles } from './PanelContent';
import type { BasePanelId } from '../../store/layoutUtils';
import { getDeviceId } from '../../utils/deviceId';
import { ACCENT_PRESETS, getAccentColor, getBlobsEnabled, saveThemeToServer } from '../../utils/theme';
import { isLoggingEnabled, setLoggingEnabled } from '../../utils/logger';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(
      () => toast.success(`Copied: ${value}`),
      () => toast.error('Failed to copy'),
    );
  };
  return (
    <div
      className="flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-all duration-150"
      style={{
        background: 'rgba(0,0,0,0.2)',
        border: '1px solid rgba(255,255,255,0.04)',
      }}
      onClick={handleCopy}
      title="Click to copy"
    >
      <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-muted)', minWidth: '80px' }}>
        {label}
      </span>
      <span
        className="text-xs flex-1 truncate"
        style={{
          color: 'var(--accent-bright)',
          fontFamily: "'SF Mono','JetBrains Mono',monospace",
          fontSize: '11px',
        }}
      >
        {value}
      </span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    </div>
  );
}

const allPanels: BasePanelId[] = ['chat', 'files', 'editor', 'preview', 'terminal', 'pet'];

/* ─────────────────────── Settings Modal ─────────────────────── */

type SettingsView = 'main' | 'totp-setup';

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<SettingsView>('main');

  // Change password
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changePwLoading, setChangePwLoading] = useState(false);

  // Telegram ID
  const [telegramIdInput, setTelegramIdInput] = useState('');
  const [tgIdLoading, setTgIdLoading] = useState(false);

  // TOTP
  const [totpUrl, setTotpUrl] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpLoading, setTotpLoading] = useState(false);

  // Appearance
  const [accentColor, setAccentColor] = useState(getAccentColor);
  const [blobsOn, setBlobsOn] = useState(getBlobsEnabled);

  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const devMode = useWorkspaceStore((s) => s.devMode);
  const setDevMode = useWorkspaceStore((s) => s.setDevMode);
  const [loggingOn, setLoggingOn] = useState(isLoggingEnabled);

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

  const handleTotpSetup = async () => {
    try {
      const { data } = await totpSetup();
      setTotpUrl(data.url);
      setTotpSecret(data.secret);
      setView('totp-setup');
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
      setView('main');
      setTotpCode('');
      setTotpUrl('');
      setTotpSecret('');
    } catch {
      toast.error('Invalid code, try again');
    } finally {
      setTotpLoading(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(0, 0, 0, 0.25)', WebkitBackdropFilter: 'blur(24px) saturate(120%)', backdropFilter: 'blur(24px) saturate(120%)' }}
      onClick={onClose}
    >
      <div
        className="liquid-glass w-full max-w-sm rounded-3xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-6 pt-6 pb-4">
          {view === 'totp-setup' && (
            <button
              onClick={() => { setView('main'); setTotpCode(''); }}
              className="w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-200 flex-shrink-0"
              style={{
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                color: 'rgba(255, 255, 255, 0.5)',
              }}
              title="Back to Settings"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          )}
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
            {view === 'main' ? 'Settings' : 'Setup 2FA'}
          </h2>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-200 flex-shrink-0"
            style={{
              background: 'rgba(255, 255, 255, 0.06)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              color: 'rgba(255, 255, 255, 0.5)',
            }}
            title="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-5" style={{ scrollbarWidth: 'thin' }}>
          {view === 'main' ? (
            <>
              {/* Change Password */}
              <div>
                <label className="block text-xs font-semibold mb-3 uppercase tracking-wider" style={{ color: 'var(--text-muted)', fontSize: '11px', letterSpacing: '0.1em' }}>
                  Change Password
                </label>
                <form onSubmit={handleChangePassword} className="space-y-2.5">
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

              {/* Telegram ID */}
              <div>
                <label className="block text-xs font-semibold mb-3 uppercase tracking-wider" style={{ color: 'var(--text-muted)', fontSize: '11px', letterSpacing: '0.1em' }}>
                  Telegram ID
                </label>
                <div className="space-y-2.5">
                  <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid var(--glass-border)' }}>
                    <input
                      type="text"
                      value={telegramIdInput || (user?.telegram_id ? String(user.telegram_id) : '')}
                      onChange={(e) => setTelegramIdInput(e.target.value.replace(/\D/g, ''))}
                      placeholder="Your Telegram ID"
                      style={{ width: '100%', padding: '10px 12px', fontSize: '13px', background: 'transparent', border: 'none', color: 'var(--text-primary)', outline: 'none' }}
                    />
                  </div>
                  <p style={{ color: 'var(--text-muted)', fontSize: '11px', lineHeight: 1.4 }}>
                    Send /start to the bot to get your ID
                  </p>
                  <button
                    type="button"
                    disabled={tgIdLoading || !telegramIdInput}
                    className="w-full py-2.5 rounded-xl text-xs font-bold btn-accent"
                    style={{ opacity: (tgIdLoading || !telegramIdInput) ? 0.3 : 1 }}
                    onClick={async () => {
                      const id = parseInt(telegramIdInput, 10);
                      if (!id) { toast.error('Invalid Telegram ID'); return; }
                      setTgIdLoading(true);
                      try {
                        await updateTelegramId(id);
                        if (user) setUser({ ...user, telegram_id: id });
                        toast.success('Telegram ID saved');
                        setTelegramIdInput('');
                      } catch {
                        toast.error('Failed to save Telegram ID');
                      } finally {
                        setTgIdLoading(false);
                      }
                    }}
                  >
                    {tgIdLoading ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>

              <div className="glass-divider" />

              {/* Appearance */}
              <div>
                <label className="block text-xs font-semibold mb-3 uppercase tracking-wider" style={{ color: 'var(--text-muted)', fontSize: '11px', letterSpacing: '0.1em' }}>
                  Appearance
                </label>
                <div className="space-y-3">
                  {/* Blob toggle */}
                  <div
                    className="flex items-center justify-between px-3 py-2.5 rounded-xl cursor-pointer"
                    style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.04)' }}
                    onClick={() => { const next = !blobsOn; setBlobsOn(next); saveThemeToServer(accentColor, next); }}
                  >
                    <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Background blobs</span>
                    <div
                      className="w-9 h-5 rounded-full relative transition-colors duration-200"
                      style={{ background: blobsOn ? 'var(--accent)' : 'rgba(255,255,255,0.1)' }}
                    >
                      <div
                        className="absolute top-0.5 w-4 h-4 rounded-full transition-transform duration-200"
                        style={{
                          background: 'white',
                          transform: blobsOn ? 'translateX(18px)' : 'translateX(2px)',
                        }}
                      />
                    </div>
                  </div>
                  {/* Accent color */}
                  <div>
                    <span className="block text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>Accent color</span>
                    <div className="flex flex-wrap gap-2">
                      {ACCENT_PRESETS.map((p) => (
                        <button
                          key={p.hex}
                          type="button"
                          onClick={() => { setAccentColor(p.hex); saveThemeToServer(p.hex, blobsOn); }}
                          title={p.name}
                          className="w-7 h-7 rounded-full transition-all duration-200 flex-shrink-0"
                          style={{
                            background: p.hex,
                            border: accentColor === p.hex ? '2px solid white' : '2px solid transparent',
                            boxShadow: accentColor === p.hex ? `0 0 10px ${p.hex}` : 'none',
                            transform: accentColor === p.hex ? 'scale(1.15)' : 'scale(1)',
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
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

              <div className="glass-divider" />

              {/* Developer Mode */}
              <div>
                <label className="block text-xs font-semibold mb-3 uppercase tracking-wider" style={{ color: 'var(--text-muted)', fontSize: '11px', letterSpacing: '0.1em' }}>
                  Developer
                </label>
                <div className="space-y-2">
                  <div
                    className="flex items-center justify-between px-3 py-2.5 rounded-xl cursor-pointer"
                    style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.04)' }}
                    onClick={() => setDevMode(!devMode)}
                  >
                    <div>
                      <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Developer mode</span>
                      <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        Ctrl+Shift+C opens DevTools instead of copy
                      </p>
                    </div>
                    <div
                      className="w-9 h-5 rounded-full relative transition-colors duration-200"
                      style={{ background: devMode ? 'var(--accent)' : 'rgba(255,255,255,0.1)' }}
                    >
                      <div
                        className="absolute top-0.5 w-4 h-4 rounded-full transition-transform duration-200"
                        style={{ background: 'white', transform: devMode ? 'translateX(18px)' : 'translateX(2px)' }}
                      />
                    </div>
                  </div>

                  {/* Debug logging toggle */}
                  <div
                    className="flex items-center justify-between px-3 py-2.5 rounded-xl cursor-pointer"
                    style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.04)' }}
                    onClick={() => { const next = !loggingOn; setLoggingOn(next); setLoggingEnabled(next); }}
                  >
                    <div>
                      <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Debug logging</span>
                      <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        Terminal, sync, pet & auth logs in console
                      </p>
                    </div>
                    <div
                      className="w-9 h-5 rounded-full relative transition-colors duration-200"
                      style={{ background: loggingOn ? 'var(--accent)' : 'rgba(255,255,255,0.1)' }}
                    >
                      <div
                        className="absolute top-0.5 w-4 h-4 rounded-full transition-transform duration-200"
                        style={{ background: 'white', transform: loggingOn ? 'translateX(18px)' : 'translateX(2px)' }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="glass-divider" />

              {/* Quick Reference */}
              <div>
                <label className="block text-xs font-semibold mb-3 uppercase tracking-wider" style={{ color: 'var(--text-muted)', fontSize: '11px', letterSpacing: '0.1em' }}>
                  Quick Reference
                </label>
                <div className="space-y-2">
                  <CopyRow label="Workspace" value="~/workspace" />
                  <CopyRow label="Shared folder" value="/home/nebulide/shared" />
                  <CopyRow label="Uploads (from TG)" value="~/uploads" />

                  <div className="glass-divider" style={{ margin: '8px 0' }} />

                  <CopyRow label="Send file to TG" value="tg-send <file>" />
                  <CopyRow label="Install pip pkg" value="pip-persist <pkg>" />
                  {user?.is_admin && <CopyRow label="Install system pkg" value="apk-persist <pkg>" />}

                  <div className="glass-divider" style={{ margin: '8px 0' }} />

                  <CopyRow label="PostgreSQL" value="psql -h postgres -U dev" />
                  <CopyRow label="Git push" value="git push origin main" />
                  <CopyRow label="SSH" value="ssh user@host" />
                </div>
              </div>
            </>
          ) : (
            /* TOTP Setup view */
            <>
              <p className="text-sm text-center" style={{ color: 'var(--text-secondary)' }}>
                Scan the QR code with your authenticator app
              </p>

              <div className="flex justify-center">
                <div className="p-3 rounded-2xl" style={{ background: 'white' }}>
                  <QRCodeSVG value={totpUrl} size={180} />
                </div>
              </div>

              <div>
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

              <div>
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

              <button
                type="button"
                onClick={handleTotpConfirm}
                disabled={totpLoading || totpCode.length !== 6}
                className="w-full py-3 rounded-xl text-sm font-bold btn-accent"
                style={{ opacity: (totpLoading || totpCode.length !== 6) ? 0.3 : 1 }}
              >
                {totpLoading ? 'Verifying...' : 'Enable 2FA'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─────────────────────── Sidebar ─────────────────────── */

export default function Sidebar({ isOpen, onClose }: SidebarProps) {
  const { visibility, toggleVisibility, openNewTerminal } = useLayoutStore();
  const { sessions: wsSessions, activeSessionId, switchSession, createSession, renameSession, deleteSession, lockStatus, lockInfo } = useWorkspaceSessionStore();
  const [showSettings, setShowSettings] = useState(false);
  const [newWsName, setNewWsName] = useState('');
  const [showNewWsInput, setShowNewWsInput] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const newWsInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const navigate = useNavigate();

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
                    <ellipse cx="38" cy="43" rx="19" ry="16" transform="rotate(-20, 38, 43)" fill="var(--accent)"/>
                    <ellipse cx="58" cy="59" rx="15" ry="13" transform="rotate(-8, 58, 59)" fill="var(--accent)"/>
                    <ellipse cx="77" cy="28" rx="10" ry="12" transform="rotate(15, 77, 28)" fill="var(--accent)"/>
                    <ellipse cx="29" cy="78" rx="8" ry="10" transform="rotate(25, 29, 78)" fill="var(--accent)"/>
                  </g>
                </svg>
              </div>
              <h1 className="sidebar-glass-logo">Nebulide</h1>
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
          {allPanels.map((panel) => {
            const isTerminal = panel === 'terminal';
            const anyTerminalVisible = isTerminal
              ? Object.keys(visibility).some((k) => (k === 'terminal' || k.startsWith('terminal:')) && visibility[k])
              : visibility[panel];
            return (
              <button
                key={panel}
                type="button"
                onClick={() => isTerminal ? openNewTerminal() : toggleVisibility(panel)}
                title={isTerminal ? 'Open new terminal' : `${visibility[panel] ? 'Hide' : 'Show'} ${panelTitles[panel]}`}
                className="w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-200"
                style={{
                  background: anyTerminalVisible ? 'rgba(var(--accent-rgb), 0.15)' : 'rgba(255, 255, 255, 0.04)',
                  border: `1px solid ${anyTerminalVisible ? 'rgba(var(--accent-rgb), 0.3)' : 'rgba(255, 255, 255, 0.06)'}`,
                  color: anyTerminalVisible ? 'var(--accent-bright)' : 'rgba(255, 255, 255, 0.35)',
                }}
              >
                {panelIcons[panel]}
              </button>
            );
          })}
        </div>

        <div className="glass-divider mx-3" />

        {/* Workspace Sessions */}
        <div className="px-3 py-2 flex-1">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)', fontSize: '10px', letterSpacing: '0.1em' }}>
              Workspaces
            </span>
            <button
              type="button"
              onClick={() => { setShowNewWsInput(true); setTimeout(() => newWsInputRef.current?.focus(), 50); }}
              className="w-6 h-6 rounded-lg flex items-center justify-center transition-all duration-200"
              style={{
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.06)',
                color: 'rgba(255, 255, 255, 0.4)',
              }}
              title="New workspace"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>

          {/* New workspace input */}
          {showNewWsInput && (
            <div className="mb-2">
              <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid var(--glass-border)' }}>
                <input
                  ref={newWsInputRef}
                  type="text"
                  value={newWsName}
                  onChange={(e) => setNewWsName(e.target.value)}
                  placeholder="Workspace name"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newWsName.trim()) {
                      createSession(newWsName.trim());
                      setNewWsName('');
                      setShowNewWsInput(false);
                    }
                    if (e.key === 'Escape') {
                      setNewWsName('');
                      setShowNewWsInput(false);
                    }
                  }}
                  onBlur={() => { setNewWsName(''); setShowNewWsInput(false); }}
                  style={{ width: '100%', padding: '8px 12px', fontSize: '12px', background: 'transparent', border: 'none', color: 'var(--text-primary)', outline: 'none' }}
                />
              </div>
            </div>
          )}

          {/* Sessions list */}
          <div className="space-y-1 max-h-48 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
            {wsSessions.map((ws) => {
              const isActive = ws.id === activeSessionId;
              const wsLock = lockStatus[ws.id];
              const isLockedByOther = wsLock === 'blocked' || (ws.lock && ws.lock.device_id !== getDeviceId());
              return (
                <div
                  key={ws.id}
                  className="group flex items-center gap-2 px-2.5 py-2 rounded-xl cursor-pointer transition-all duration-200"
                  style={{
                    background: isActive ? 'rgba(var(--accent-rgb), 0.12)' : 'transparent',
                    border: `1px solid ${isActive ? 'rgba(var(--accent-rgb), 0.25)' : 'transparent'}`,
                  }}
                  onClick={() => { if (!isActive) switchSession(ws.id); }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setRenamingId(ws.id);
                    setRenameValue(ws.name);
                    setTimeout(() => renameInputRef.current?.focus(), 50);
                  }}
                >
                  {/* Status indicator */}
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{
                      background: isActive
                        ? 'var(--accent-bright)'
                        : isLockedByOther
                          ? 'rgb(251, 191, 36)'
                          : 'rgba(255,255,255,0.15)',
                      boxShadow: isActive
                        ? '0 0 6px rgba(var(--accent-rgb),0.5)'
                        : isLockedByOther
                          ? '0 0 6px rgba(251,191,36,0.4)'
                          : 'none',
                    }}
                  />

                  {renamingId === ws.id ? (
                    <input
                      ref={renameInputRef}
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && renameValue.trim()) {
                          renameSession(ws.id, renameValue.trim());
                          setRenamingId(null);
                        }
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      onBlur={() => {
                        if (renameValue.trim() && renameValue.trim() !== ws.name) {
                          renameSession(ws.id, renameValue.trim());
                        }
                        setRenamingId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        flex: 1, minWidth: 0, padding: '2px 4px', fontSize: '12px',
                        background: 'rgba(0,0,0,0.4)', border: '1px solid var(--glass-border)',
                        borderRadius: '6px', color: 'var(--text-primary)', outline: 'none',
                      }}
                    />
                  ) : (
                    <span
                      className="text-xs font-medium truncate flex-1"
                      style={{ color: isActive ? 'var(--accent-bright)' : 'rgba(255,255,255,0.6)' }}
                    >
                      {ws.name}
                    </span>
                  )}

                  {/* Device / lock info */}
                  {isLockedByOther ? (
                    <span className="text-xs flex-shrink-0 flex items-center gap-1" style={{ color: 'rgba(251,191,36,0.6)', fontSize: '10px' }}>
                      {(ws.lock?.device_type || lockInfo[ws.id]?.device_type) === 'phone' ? '\uD83D\uDCF1' : '\uD83D\uDCBB'}
                      <span>In use</span>
                    </span>
                  ) : ws.device_tag ? (
                    <span className="text-xs flex-shrink-0" style={{ color: 'rgba(255,255,255,0.2)', fontSize: '10px' }}>
                      {ws.device_tag}
                    </span>
                  ) : null}

                  {/* Delete button */}
                  {!isActive && wsSessions.length > 1 && (
                    <button
                      type="button"
                      className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      style={{
                        width: '22px',
                        height: '22px',
                        borderRadius: '7px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'rgba(var(--accent-rgb), 0.15)',
                        border: '1px solid rgba(var(--accent-rgb), 0.4)',
                        color: 'rgba(255,255,255,0.8)',
                        backdropFilter: 'blur(8px)',
                        boxShadow: '0 0 6px 1px rgba(var(--accent-rgb),0.2)',
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Delete workspace "${ws.name}"?`)) {
                          deleteSession(ws.id);
                        }
                      }}
                      title="Delete workspace"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="glass-divider mx-3" />

        {/* Footer */}
        <div className="p-3 space-y-2">
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className="sidebar-footer-btn w-full py-2.5 rounded-2xl text-xs font-semibold"
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

      {/* Settings Modal */}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </>
  );
}
