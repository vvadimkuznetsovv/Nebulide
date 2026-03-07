import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, getMe } from '../api/auth';
import { useAuthStore } from '../store/authStore';
import MegaLogo from '../components/MegaLogo';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
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
    <div className="lava-lamp">
      <div className="lava-blob lava-blob-1" />
      <div className="lava-blob lava-blob-2" />
      <div className="lava-blob lava-blob-3" />
      <div className="lava-blob lava-blob-4" />
      <div className="lava-blob lava-blob-5" />
      <div className="lava-blob lava-blob-6" />
      <div className="lava-glow" />
      <div className="min-h-screen flex items-center justify-center relative z-10">
        <div className="glass-card" style={{ padding: '40px', width: '380px', maxWidth: '90vw' }}>
          <div style={{ textAlign: 'center', marginBottom: '32px' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '8px' }}>
              <MegaLogo size="large" />
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Admin Panel</p>
          </div>

          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: '16px' }}>
              <input
                type="text"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="glass-input"
                autoFocus
              />
            </div>
            <div style={{ marginBottom: '20px' }}>
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="glass-input"
              />
            </div>

            {error && (
              <p style={{ color: 'var(--danger)', fontSize: '13px', marginBottom: '16px', textAlign: 'center' }}>
                {error}
              </p>
            )}

            <button type="submit" className="glass-btn primary" disabled={loading} style={{ width: '100%' }}>
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
