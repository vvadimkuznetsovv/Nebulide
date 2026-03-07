import { useState, useRef, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, getMe } from '../api/auth';
import { useAuthStore } from '../store/authStore';
import MegaLogo from '../components/MegaLogo';

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
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const { data } = await login(username, password);
      if (data.requires_totp) {
        setError('TOTP not supported in admin panel yet');
        return;
      }

      setAuth(data.user, data.access_token, data.refresh_token);

      // Verify admin access
      const me = await getMe();
      if (!me.data.is_admin) {
        useAuthStore.getState().clearAuth();
        setError('Admin access required');
        return;
      }

      navigate('/');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Login failed';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', position: 'relative', overflow: 'hidden' }}>
      {/* Lava lamp background */}
      <div className="lava-lamp">
        <div className="lava-blob lava-blob-1" />
        <div className="lava-blob lava-blob-2" />
        <div className="lava-blob lava-blob-3" />
        <div className="lava-blob lava-blob-4" />
        <div className="lava-blob lava-blob-5" />
        <div className="lava-blob lava-blob-6" />
        <div className="lava-glow" />
      </div>

      {/* Liquid Glass login card */}
      <div className="glass-card" style={{
        position: 'relative', zIndex: 10, width: '100%', maxWidth: '460px',
        borderRadius: '36px', padding: '56px 44px',
        border: '1px solid rgba(255,255,255,0.18)',
      }}>
        {/* Shimmer line */}
        <div style={{
          position: 'absolute', top: 0, left: '8%', right: '8%', height: '1px',
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent)',
          pointerEvents: 'none', zIndex: 2,
        }} />

        <div style={{ position: 'relative', zIndex: 3 }}>
          {/* Logo */}
          <div style={{ textAlign: 'center', marginBottom: '48px' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '28px' }}>
              <MegaLogo size="large" />
            </div>
            <p style={{ fontSize: '15px', color: 'rgba(255,255,255,0.4)', fontWeight: 500 }}>Admin Panel</p>
          </div>

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, marginBottom: '10px', letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255,255,255,0.9)', paddingLeft: '12px' }}>
                Username
              </label>
              <PillInput type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Enter username" autoFocus required />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, marginBottom: '10px', letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255,255,255,0.9)', paddingLeft: '12px' }}>
                Password
              </label>
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

            {error && (
              <p style={{ color: 'var(--danger)', fontSize: '13px', textAlign: 'center' }}>
                {error}
              </p>
            )}

            <div style={{ height: '1px', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)', margin: '4px 0' }} />

            <button type="submit" className="glass-btn primary" disabled={loading}
              style={{
                width: '100%', padding: '18px', borderRadius: '9999px',
                fontSize: '16px', fontWeight: 700, letterSpacing: '0.02em',
                background: loading ? 'rgba(127,0,255,0.15)' : 'rgba(127,0,255,0.25)',
                borderColor: 'rgba(127,0,255,0.5)',
                boxShadow: loading ? 'none' : '0 0 25px rgba(127,0,255,0.2), inset 0 1px 0 rgba(255,255,255,0.1)',
              }}>
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
