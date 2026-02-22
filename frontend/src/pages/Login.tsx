import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, totpVerify } from '../api/auth';
import { useAuthStore } from '../store/authStore';
import toast from 'react-hot-toast';

function EyeIcon({ open }: { open: boolean }) {
  if (open) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    );
  }
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

function PillInput({ type = 'text', value, onChange, placeholder, autoFocus, endIcon, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { endIcon?: React.ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const setFocused = (on: boolean) => {
    const el = wrapRef.current;
    if (!el) return;
    if (on) {
      el.style.borderColor = 'rgba(127,0,255,0.6)';
      el.style.boxShadow = '0 0 0 4px rgba(127,0,255,0.12), 0 0 25px rgba(127,0,255,0.08), inset 0 2px 6px rgba(0,0,0,0.4)';
      el.style.background = 'rgba(0,0,0,0.8)';
    } else {
      el.style.borderColor = 'rgba(255,255,255,0.25)';
      el.style.boxShadow = 'inset 0 2px 6px rgba(0,0,0,0.6), inset 0 -1px 0 rgba(255,255,255,0.04)';
      el.style.background = 'rgba(0,0,0,0.75)';
    }
  };
  return (
    <div ref={wrapRef} style={{
      borderRadius: '9999px', overflow: 'hidden',
      background: 'rgba(0,0,0,0.75)',
      border: '1px solid rgba(255,255,255,0.25)',
      boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.6), inset 0 -1px 0 rgba(255,255,255,0.04)',
      transition: 'all 0.3s cubic-bezier(0.4,0,0.2,1)',
      backdropFilter: 'blur(12px) saturate(150%)',
      WebkitBackdropFilter: 'blur(12px) saturate(150%)',
      display: 'flex', alignItems: 'center', position: 'relative',
    }}>
      <input type={type} value={value} onChange={onChange}
        placeholder={placeholder} autoFocus={autoFocus}
        autoComplete="off"
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        {...rest}
        className="login-pill-input"
        style={{
          width: '100%', padding: '18px 28px', paddingRight: endIcon ? '52px' : '28px',
          fontSize: '16px', fontWeight: 500,
          background: 'transparent', border: 'none',
          color: '#fff', outline: 'none', borderRadius: '9999px',
        }}
      />
      {endIcon && (
        <div style={{ position: 'absolute', right: '16px', top: '50%', transform: 'translateY(-50%)' }}>
          {endIcon}
        </div>
      )}
    </div>
  );
}

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [showTotp, setShowTotp] = useState(false);
  const [partialToken, setPartialToken] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true);
    try {
      const { data } = await login(username, password);
      if (data.requires_totp) { setPartialToken(data.partial_token); setShowTotp(true); setLoading(false); return; }
      setAuth(data.user, data.access_token, data.refresh_token); navigate('/');
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string }; status?: number }; message?: string };
      const msg = axiosErr.response?.data?.error || axiosErr.message || 'Login failed';
      toast.error(msg);
      console.error('Login error:', axiosErr.response?.status, axiosErr.response?.data || axiosErr.message);
    } finally { setLoading(false); }
  };

  const handleTotp = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true);
    try {
      const { data } = await totpVerify(totpCode, partialToken);
      setAuth(data.user, data.access_token, data.refresh_token); navigate('/');
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string }; status?: number }; message?: string };
      const msg = axiosErr.response?.data?.error || axiosErr.message || 'TOTP verification failed';
      toast.error(msg);
      console.error('TOTP error:', axiosErr.response?.status, axiosErr.response?.data || axiosErr.message);
    } finally { setLoading(false); }
  };

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', position: 'relative', overflow: 'hidden' }}>

      {/* SVG Glass Distortion Filters (Chromium only) */}
      <svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style={{ position: 'absolute', overflow: 'hidden' }}>
        <defs>
          {/* Desktop — strong refraction */}
          <filter id="glass-distortion" x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.006 0.006" numOctaves="3" seed="42" result="noise" />
            <feGaussianBlur in="noise" stdDeviation="2.5" result="blurred" />
            <feDisplacementMap in="SourceGraphic" in2="blurred" scale="120" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          {/* Mobile — softer refraction */}
          <filter id="glass-distortion-mobile" x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.008 0.008" numOctaves="2" seed="42" result="noise" />
            <feGaussianBlur in="noise" stdDeviation="3" result="blurred" />
            <feDisplacementMap in="SourceGraphic" in2="blurred" scale="40" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>

      {/* LAVA LAMP — 8 sharp blobs */}
      <div className="lava-lamp">
        <div className="lava-blob lava-blob-1" />
        <div className="lava-blob lava-blob-2" />
        <div className="lava-blob lava-blob-3" />
        <div className="lava-blob lava-blob-4" />
        <div className="lava-blob lava-blob-5" />
        <div className="lava-blob lava-blob-6" />
        <div className="lava-blob lava-blob-7" />
        <div className="lava-blob lava-blob-8" />
        {/* === NEW BLOBS — раскомментировать если нужны ===
        <div className="lava-blob lava-blob-9" />
        <div className="lava-blob lava-blob-10" />
        <div className="lava-blob lava-blob-11" />
        <div className="lava-blob lava-blob-12" />
        === END NEW BLOBS === */}
        <div className="lava-glow" />
      </div>

      {/* LIQUID GLASS CARD — uses real glass distortion */}
      <div className="login-card glass-card" style={{
        position: 'relative', zIndex: 10, width: '100%', maxWidth: '460px',
        borderRadius: '36px', padding: '56px 44px',
        border: '1px solid rgba(255,255,255,0.18)',
      }}>
        {/* Shimmer line */}
        <div className="glass-card-shimmer" />
        <div style={{ position: 'relative', zIndex: 3 }}>
          {/* Logo */}
          <div className="login-logo" style={{ textAlign: 'center', marginBottom: '48px' }}>
            <div className="glow-pulse login-logo-icon" style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: '84px', height: '84px', borderRadius: '26px',
              background: 'rgba(255,255,255,0.06)',
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              border: '1px solid rgba(255,255,255,0.2)',
              marginBottom: '28px', position: 'relative', overflow: 'hidden',
              boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.2), inset 0 -1px 1px rgba(0,0,0,0.1), 0 0 50px rgba(127,0,255,0.2)',
            }}>
              {/* Glass specular highlight */}
              <div style={{ position: 'absolute', inset: 0, borderRadius: '26px', background: 'linear-gradient(145deg, rgba(255,255,255,0.25) 0%, rgba(255,255,255,0.05) 30%, transparent 55%)', pointerEvents: 'none' }} />
              {/* Favicon logo */}
              <img src="/favicon.svg" alt="Clauder" width="52" height="52" style={{ position: 'relative', zIndex: 1, borderRadius: '12px', filter: 'drop-shadow(0 0 12px rgba(127,0,255,0.6))' }} />
            </div>
            <h1 className="login-title" style={{ fontSize: '38px', fontWeight: 800, letterSpacing: '-0.03em', color: 'rgba(255,255,255,0.95)', marginBottom: '10px' }}>Clauder</h1>
            <p className="login-subtitle" style={{ fontSize: '15px', color: 'rgba(255,255,255,0.4)', fontWeight: 500 }}>Claude Code Web Interface</p>
          </div>

          {!showTotp ? (
            <form onSubmit={handleLogin} className="login-form" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div>
                <label className="login-label" style={{ display: 'block', fontSize: '11px', fontWeight: 700, marginBottom: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.9)', paddingLeft: '12px' }}>Username</label>
                <PillInput type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Enter username" autoFocus required />
              </div>
              <div>
                <label className="login-label" style={{ display: 'block', fontSize: '11px', fontWeight: 700, marginBottom: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.9)', paddingLeft: '12px' }}>Password</label>
                <PillInput
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  required
                  endIcon={
                    <button
                      type="button"
                      title={showPassword ? 'Hide password' : 'Show password'}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      onClick={() => setShowPassword(!showPassword)}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer', padding: '4px',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        opacity: 0.7, transition: 'opacity 0.2s',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
                      tabIndex={-1}
                    >
                      <EyeIcon open={showPassword} />
                    </button>
                  }
                />
              </div>
              <div style={{ height: '1px', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)', margin: '4px 0' }} />
              <button type="submit" disabled={loading} className="btn-accent login-btn"
                style={{ width: '100%', padding: '18px', borderRadius: '9999px', fontSize: '16px', fontWeight: 700, letterSpacing: '0.02em' }}>
                {loading ? 'Signing in...' : 'Sign In'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleTotp} style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: '68px', height: '68px', borderRadius: '22px',
                  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                  marginBottom: '20px', fontSize: '30px',
                  boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.1)',
                }}>🔐</div>
                <p style={{ fontSize: '15px', color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>Enter the 6-digit code from your authenticator app</p>
              </div>
              <div style={{ borderRadius: '24px', overflow: 'hidden', background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.12)', boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.3)' }}>
                <input type="text" value={totpCode} onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000" maxLength={6} autoFocus required autoComplete="off"
                  style={{ width: '100%', padding: '22px', fontSize: '32px', textAlign: 'center', letterSpacing: '0.5em', fontFamily: "'SF Mono','JetBrains Mono',monospace", fontWeight: 800, background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.95)', outline: 'none', borderRadius: '24px' }} />
              </div>
              <button type="submit" disabled={loading || totpCode.length !== 6} className="btn-accent"
                style={{ width: '100%', padding: '18px', borderRadius: '9999px', fontSize: '16px', fontWeight: 700, opacity: (loading || totpCode.length !== 6) ? 0.3 : 1 }}>
                {loading ? 'Verifying...' : 'Verify'}
              </button>
              <button type="button" onClick={() => { setShowTotp(false); setTotpCode(''); }} className="btn-glass"
                style={{ width: '100%', padding: '16px', borderRadius: '9999px', fontSize: '15px', fontWeight: 600 }}>Back to login</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
