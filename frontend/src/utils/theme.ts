import { getTheme, updateTheme } from '../api/auth';

const ACCENT_KEY = 'nebulide-accent-color';
const BLOBS_KEY = 'nebulide-blobs-enabled';

const DEFAULT_ACCENT = '#7F00FF';

export const ACCENT_PRESETS = [
  { name: 'Purple', hex: '#7F00FF' },
  { name: 'Blue', hex: '#0066FF' },
  { name: 'Cyan', hex: '#00B4D8' },
  { name: 'Green', hex: '#00CC66' },
  { name: 'Pink', hex: '#FF0099' },
  { name: 'Red', hex: '#FF3355' },
  { name: 'Orange', hex: '#FF6600' },
  { name: 'Gold', hex: '#CCAA00' },
];

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

function lighten(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const lr = Math.min(255, r + (255 - r) * amount);
  const lg = Math.min(255, g + (255 - g) * amount);
  const lb = Math.min(255, b + (255 - b) * amount);
  return `rgb(${Math.round(lr)}, ${Math.round(lg)}, ${Math.round(lb)})`;
}

export function applyAccentColor(hex: string) {
  const [r, g, b] = hexToRgb(hex);
  const root = document.documentElement;
  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent-bright', lighten(hex, 0.3));
  root.style.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, 0.4)`);
  root.style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.15)`);
  localStorage.setItem(ACCENT_KEY, hex);
}

export function applyBlobsEnabled(enabled: boolean) {
  const el = document.querySelector('.lava-lamp') as HTMLElement | null;
  if (el) el.style.display = enabled ? '' : 'none';
  localStorage.setItem(BLOBS_KEY, String(enabled));
}

export function getAccentColor(): string {
  return localStorage.getItem(ACCENT_KEY) || DEFAULT_ACCENT;
}

export function getBlobsEnabled(): boolean {
  const val = localStorage.getItem(BLOBS_KEY);
  return val === null ? true : val === 'true';
}

/** Call once on app startup — applies cached theme from localStorage */
export function loadTheme() {
  const accent = getAccentColor();
  if (accent !== DEFAULT_ACCENT) applyAccentColor(accent);
  if (!getBlobsEnabled()) {
    requestAnimationFrame(() => applyBlobsEnabled(false));
  }
}

/** Fetch theme from server and apply (call after login / auth restore) */
export async function syncThemeFromServer() {
  try {
    const { data } = await getTheme();
    if (data.accent_color) {
      applyAccentColor(data.accent_color);
    }
    applyBlobsEnabled(data.blobs_enabled !== false);
  } catch {
    // Not authenticated or server error — use localStorage cache
  }
}

/** Save theme to server + localStorage */
export async function saveThemeToServer(accentColor: string, blobsEnabled: boolean) {
  applyAccentColor(accentColor);
  applyBlobsEnabled(blobsEnabled);
  try {
    await updateTheme(accentColor, blobsEnabled);
  } catch {
    // Offline — localStorage already updated
  }
}
