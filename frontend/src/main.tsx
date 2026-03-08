import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import SwipeableToaster from './components/SwipeableToaster'
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
    <SwipeableToaster />
  </StrictMode>,
)
