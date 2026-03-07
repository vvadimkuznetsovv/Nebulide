export default function MegaLogo({ size = 'normal' }: { size?: 'normal' | 'large' }) {
  const fontSize = size === 'large' ? '28px' : '20px';
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
      <span className="mega-prefix" style={{ fontSize, fontWeight: 900, letterSpacing: '0.08em' }}>
        MEGA
      </span>
      <span className="sidebar-glass-logo" style={{ fontSize, fontWeight: 800, letterSpacing: '0.06em' }}>
        Nebulide
      </span>
    </div>
  );
}
