const KEY = 'nebulide-device-id';

export function getDeviceId(): string {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}

export type DeviceType = 'phone' | 'tablet' | 'desktop';

export function detectDeviceType(): DeviceType {
  const w = window.innerWidth;
  if (w <= 640) return 'phone';
  if (w <= 1024) return 'tablet';
  return 'desktop';
}
