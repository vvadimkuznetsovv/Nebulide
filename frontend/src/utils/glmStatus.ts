import { useSyncExternalStore } from 'react';
import { getGlmStatus, type GlmStatus } from '../api/glm';

// Синглтон-поллер статуса GLM. Источник бесплатный (usage-эндпоинт Z.ai), поэтому опрашиваем
// раз в 30с без оглядки на квоту. Ref-counted: интервал крутится, только пока есть подписчики
// (смонтирована хотя бы одна кнопка «Z»). Паттерн subscribe/version — как в terminalViewMode.ts.

let current: GlmStatus | null = null;
let version = 0;
let timer: number | null = null;
let inflight = false;
const listeners = new Set<() => void>();

const POLL_MS = 30_000;

function bump() {
  version++;
  for (const l of listeners) l();
}

async function fetchOnce() {
  if (inflight) return;
  inflight = true;
  try {
    const { data } = await getGlmStatus();
    current = data;
    bump();
  } catch {
    // сетевая ошибка — НЕ моргаем, держим прошлый статус
  } finally {
    inflight = false;
  }
}

function start() {
  if (timer != null) return;
  fetchOnce();
  timer = window.setInterval(fetchOnce, POLL_MS);
}

function stop() {
  if (timer != null) {
    clearInterval(timer);
    timer = null;
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) stop();
  };
}

export function useGlmStatus(): GlmStatus | null {
  useSyncExternalStore(subscribe, () => version, () => version);
  return current;
}

// Цвет точки-индикатора (чистая функция — для кнопки и теста):
// нет ключа/статуса → точки нет; доступно → зелёная; исчерпано → красная.
export function glmDotColor(s: GlmStatus | null): 'var(--success)' | 'var(--danger)' | null {
  if (!s || !s.enabled) return null;
  return s.available ? 'var(--success)' : 'var(--danger)';
}
