import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'react-hot-toast'
import './index.css'
import App from './App'

// iOS virtual keyboard: adjust #root height to visible viewport.
// Without this, panels hide behind the keyboard when input is focused.
function updateAppHeight() {
  const h = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${h}px`);
}
window.visualViewport?.addEventListener('resize', updateAppHeight);
window.addEventListener('resize', updateAppHeight);
updateAppHeight();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <Toaster
      position="top-center"
      toastOptions={{
        style: {
          background: 'rgba(255, 255, 255, 0.08)',
          backdropFilter: 'blur(40px) saturate(180%)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%)',
          color: 'rgba(255, 255, 255, 0.95)',
          border: '1px solid rgba(255, 255, 255, 0.18)',
          borderRadius: '9999px',
          padding: '14px 24px',
          boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.15), inset 0 -1px 1px rgba(0,0,0,0.08), 0 8px 32px rgba(0,0,0,0.4)',
          fontSize: '14px',
          fontWeight: 500,
        },
      }}
    />
  </StrictMode>,
)
