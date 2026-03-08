import { Link } from 'react-router-dom';

export default function Landing() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8 relative">
      <div className="bg-mesh" />

      {/* Floating orbs */}
      <div className="fixed top-20 right-1/4 w-72 h-72 rounded-full opacity-20 blur-3xl pointer-events-none"
           style={{ background: 'radial-gradient(circle, rgba(var(--accent-light-rgb),0.5), transparent)' }} />
      <div className="fixed bottom-20 left-1/3 w-56 h-56 rounded-full opacity-15 blur-3xl pointer-events-none"
           style={{ background: 'radial-gradient(circle, rgba(var(--accent-rgb),0.5), transparent)' }} />

      <div className="relative z-10 max-w-lg text-center">
        {/* Logo */}
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-3xl mb-6 glass glow-pulse">
          <span className="text-3xl font-mono font-bold" style={{ color: 'var(--accent)' }}>{'>'}_</span>
        </div>

        <h1 className="text-5xl font-bold tracking-tight mb-3" style={{ color: 'var(--text-primary)' }}>
          Nebulide
        </h1>
        <p className="text-lg mb-2" style={{ color: 'var(--text-primary)' }}>
          Claude Code in your browser
        </p>
        <p className="text-sm mb-10 max-w-md mx-auto leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          A self-hosted web interface for Claude Code. Chat with AI, edit files, run commands —
          all from your phone or desktop browser. Your own AI-powered development server.
        </p>

        <div className="flex gap-4 justify-center mb-14">
          <Link
            to="/login"
            className="btn-accent px-8 py-3 rounded-2xl font-medium text-sm inline-block"
          >
            Sign In
          </Link>
          <a
            href="#features"
            className="btn-glass px-8 py-3 rounded-2xl font-medium text-sm inline-block"
          >
            Learn More
          </a>
        </div>

        <div id="features" className="grid grid-cols-2 gap-4 text-left">
          {[
            { icon: '>', title: 'Chat', desc: 'Interact with Claude Code via real-time streaming chat' },
            { icon: '#', title: 'Editor', desc: 'Browse and edit files with Monaco code editor' },
            { icon: '$', title: 'Terminal', desc: 'Full terminal access via integrated web terminal' },
            { icon: '🔐', title: 'Secure', desc: '2FA authentication with TOTP, JWT tokens' },
          ].map((item) => (
            <div key={item.title} className="glass rounded-2xl p-5 group hover:scale-[1.02] transition-transform">
              <div className="w-10 h-10 rounded-xl glass flex items-center justify-center mb-3 text-lg font-mono"
                   style={{ color: 'var(--accent)' }}>
                {item.icon}
              </div>
              <h3 className="font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>
                {item.title}
              </h3>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                {item.desc}
              </p>
            </div>
          ))}
        </div>

        <p className="mt-14 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          Want your own Nebulide instance?{' '}
          <a href="#" className="hover:underline" style={{ color: 'var(--accent)' }}>
            Get in touch
          </a>
        </p>
      </div>
    </div>
  );
}
