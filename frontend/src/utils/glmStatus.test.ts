import { describe, it, expect } from 'vitest';
import { glmDotColor } from './glmStatus';
import type { GlmStatus } from '../api/glm';

describe('glmDotColor — цвет точки индикатора GLM', () => {
  it('нет статуса → точки нет', () => {
    expect(glmDotColor(null)).toBe(null);
  });

  it('ключ не задан (enabled=false) → точки нет', () => {
    const s: GlmStatus = { enabled: false, available: false };
    expect(glmDotColor(s)).toBe(null);
  });

  it('доступно → зелёная', () => {
    const s: GlmStatus = { enabled: true, available: true, level: 'pro', cycle_percent: 1 };
    expect(glmDotColor(s)).toBe('var(--success)');
  });

  it('исчерпано → красная', () => {
    const s: GlmStatus = { enabled: true, available: false, level: 'pro', cycle_percent: 100 };
    expect(glmDotColor(s)).toBe('var(--danger)');
  });
});
