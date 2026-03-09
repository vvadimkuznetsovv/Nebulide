import { useSyncExternalStore } from 'react';
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

// TODO: per-preset glow hue shift (disabled — needs tuning)
// const PRESET_GLOW_SHIFT: Record<string, number | null> = {
//   '#7F00FF': null,    // Purple: natural blue glow on dark bg
//   '#0066FF': -70,     // Blue → turquoise
//   '#00B4D8': +120,    // Cyan → magenta/pink
//   '#00CC66': +120,    // Green → blue
//   '#FF0099': +120,    // Pink → cyan/teal
//   '#FF3355': +120,    // Red → blue/cyan
//   '#FF6600': +120,    // Orange → cyan/teal
//   '#CCAA00': +120,    // Gold → blue/purple
// };

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

function hueShift(hex: string, degrees: number): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  h = ((h + degrees) % 360 + 360) % 360;
  const hn = h / 360;
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, hn + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, hn) * 255),
    Math.round(hue2rgb(p, q, hn - 1 / 3) * 255),
  ];
}

function lighten(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const lr = Math.min(255, r + (255 - r) * amount);
  const lg = Math.min(255, g + (255 - g) * amount);
  const lb = Math.min(255, b + (255 - b) * amount);
  return `rgb(${Math.round(lr)}, ${Math.round(lg)}, ${Math.round(lb)})`;
}

function lightenRgb(hex: string, amount: number): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [
    Math.min(255, Math.round(r + (255 - r) * amount)),
    Math.min(255, Math.round(g + (255 - g) * amount)),
    Math.min(255, Math.round(b + (255 - b) * amount)),
  ];
}

export function applyAccentColor(hex: string) {
  const [r, g, b] = hexToRgb(hex);
  const root = document.documentElement;

  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
  root.style.setProperty('--accent-bright', lighten(hex, 0.3));

  // Derived hues for borders, shadows, glows
  const [lr, lg, lb] = lightenRgb(hex, 0.4);
  root.style.setProperty('--accent-light-rgb', `${lr}, ${lg}, ${lb}`);

  const [mr, mg, mb] = lightenRgb(hex, 0.1);
  root.style.setProperty('--accent-mid-rgb', `${mr}, ${mg}, ${mb}`);

  const [br, bg2, bb] = lightenRgb(hex, 0.25);
  root.style.setProperty('--accent-bright-rgb', `${br}, ${bg2}, ${bb}`);

  root.style.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, 0.4)`);
  root.style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.15)`);

  // Glow = same as accent (no hue shift)
  root.style.setProperty('--blob-glow-rgb', `${r}, ${g}, ${b}`);
  localStorage.setItem(ACCENT_KEY, hex);
}

// --- Blobs reactive state ---
const blobListeners = new Set<() => void>();

export function useBlobsEnabled(): boolean {
  return useSyncExternalStore(
    (cb) => { blobListeners.add(cb); return () => { blobListeners.delete(cb); }; },
    () => { const v = localStorage.getItem(BLOBS_KEY); return v === null ? true : v === 'true'; },
  );
}

export function applyBlobsEnabled(enabled: boolean) {
  localStorage.setItem(BLOBS_KEY, String(enabled));
  blobListeners.forEach(cb => cb());
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
  applyAccentColor(accent);
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
