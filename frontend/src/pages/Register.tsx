import { useState, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { register } from '../api/auth';
import toast from 'react-hot-toast';

function PillInput({ type = 'text', value, onChange, placeholder, autoFocus, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
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
          width: '100%', padding: '18px 28px',
          fontSize: '16px', fontWeight: 500,
          background: 'transparent', border: 'none',
          color: '#fff', outline: 'none', borderRadius: '9999px',
        }}
      />
    </div>
  );
}

export default function Register() {
  const [inviteCode, setInviteCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    if (password.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    if (username.length < 3) {
      toast.error('Username must be at least 3 characters');
      return;
    }
    setLoading(true);
    try {
      await register(username, password, inviteCode);
      toast.success('Registration successful! Please sign in.');
      navigate('/login');
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string; retry_after_seconds?: number } }; message?: string };
      const msg = axiosErr.response?.data?.error || axiosErr.message || 'Registration failed';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: '11px', fontWeight: 700, marginBottom: '10px',
    letterSpacing: '0.1em', textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.9)', paddingLeft: '12px',
  };

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', position: 'relative', overflow: 'hidden' }}>

      <div className="lava-lamp">
        <div className="lava-blob lava-blob-1" />
        <div className="lava-blob lava-blob-2" />
        <div className="lava-blob lava-blob-3" />
        <div className="lava-blob lava-blob-4" />
        <div className="lava-blob lava-blob-5" />
        <div className="lava-blob lava-blob-6" />
        <div className="lava-glow" />
      </div>

      <div className="login-card glass-card" style={{
        position: 'relative', zIndex: 10, width: '100%', maxWidth: '460px',
        borderRadius: '36px', padding: '56px 44px',
        border: '1px solid rgba(255,255,255,0.18)',
      }}>
        <div className="glass-card-shimmer" />
        <div style={{ position: 'relative', zIndex: 3 }}>
          <div className="login-logo" style={{ textAlign: 'center', marginBottom: '40px' }}>
            <img src="/favicon.svg" alt="Nebulide" className="login-logo-icon" width="84" height="84" style={{ borderRadius: '22px', marginBottom: '28px', display: 'block', margin: '0 auto 28px' }} />
            <h1 className="login-title" style={{ fontSize: '38px', fontWeight: 800, letterSpacing: '-0.03em', color: 'rgba(255,255,255,0.95)', marginBottom: '10px' }}>Register</h1>
            <p className="login-subtitle" style={{ fontSize: '15px', color: 'rgba(255,255,255,0.4)', fontWeight: 500 }}>Create your account with an invite code</p>
          </div>

          <form onSubmit={handleRegister} className="login-form" style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
            <div>
              <label style={labelStyle}>Invite Code</label>
              <PillInput type="text" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="Enter invite code" autoFocus required />
            </div>
            <div>
              <label style={labelStyle}>Username</label>
              <PillInput type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Choose a username" required />
            </div>
            <div>
              <label style={labelStyle}>Password</label>
              <PillInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Create a password" required />
            </div>
            <div>
              <label style={labelStyle}>Confirm Password</label>
              <PillInput type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Confirm password" required />
            </div>
            <div style={{ height: '1px', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)', margin: '2px 0' }} />
            <button type="submit" disabled={loading} className="btn-accent login-btn"
              style={{ width: '100%', padding: '18px', borderRadius: '9999px', fontSize: '16px', fontWeight: 700, letterSpacing: '0.02em' }}>
              {loading ? 'Creating account...' : 'Create Account'}
            </button>
            <div style={{ textAlign: 'center', marginTop: '4px' }}>
              <Link to="/login" style={{ fontSize: '14px', color: 'rgba(255,255,255,0.45)', textDecoration: 'none', fontWeight: 500, transition: 'color 0.2s' }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-bright)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.45)'; }}>
                Already have an account? Sign in
              </Link>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
