import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import SwipeableToaster from './components/SwipeableToaster'
import './index.css'
import App from './App'
import { loadTheme } from './utils/theme'
// Eagerly import petStore so it subscribes to activity bus before any terminal connects.
// Without this, terminal_connect events fired before the Pet panel is first shown are missed.
import './store/petStore'

loadTheme();

// iOS virtual keyboard: pin the app to the VISIBLE (visual) viewport.
// On iOS `position:fixed` is anchored to the LAYOUT viewport (full height,
// unchanged by the keyboard) while the keyboard shrinks the VISUAL viewport —
// so the user can pan into empty space below. We must follow BOTH height AND
// offsetTop, and update on the `scroll` event too (fires while panning), so the
// root always exactly covers the visible area and there's nothing to scroll into.
function updateAppHeight() {
  const vv = window.visualViewport;
  const h = vv?.height ?? window.innerHeight;
  const top = vv?.offsetTop ?? 0;
  const root = document.documentElement;
  root.style.setProperty('--app-height', `${h}px`);
  root.style.setProperty('--app-top', `${top}px`);
}
window.visualViewport?.addEventListener('resize', updateAppHeight);
window.visualViewport?.addEventListener('scroll', updateAppHeight);
window.addEventListener('resize', updateAppHeight);
updateAppHeight();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <SwipeableToaster />
  </StrictMode>,
)
