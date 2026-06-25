import { describe, it, expect, beforeEach } from 'vitest';
import {
  launchModeToViewProvider,
  getTerminalProvider,
  setTerminalProvider,
  getClaudeLaunchMode,
  setClaudeLaunchMode,
} from './terminalViewMode';

describe('launchModeToViewProvider — тройной маппинг режима запуска', () => {
  it('anthropic → терминал + Anthropic', () => {
    expect(launchModeToViewProvider('anthropic')).toEqual({ view: 'terminal', provider: 'anthropic' });
  });
  it('interface → чат + Anthropic', () => {
    expect(launchModeToViewProvider('interface')).toEqual({ view: 'chat', provider: 'anthropic' });
  });
  it('z → терминал + GLM', () => {
    expect(launchModeToViewProvider('z')).toEqual({ view: 'terminal', provider: 'glm' });
  });
});

describe('getTerminalProvider / setTerminalProvider', () => {
  it('по умолчанию anthropic для неизвестного instance', () => {
    expect(getTerminalProvider('no-such-instance')).toBe('anthropic');
  });
  it('set/get glm и обратно anthropic', () => {
    setTerminalProvider('inst-1', 'glm');
    expect(getTerminalProvider('inst-1')).toBe('glm');
    setTerminalProvider('inst-1', 'anthropic');
    expect(getTerminalProvider('inst-1')).toBe('anthropic');
  });
});

describe('launchMode preference + миграция со старого openMode', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('set/get переживает запись в localStorage', () => {
    setClaudeLaunchMode('z');
    expect(getClaudeLaunchMode()).toBe('z');
    expect(localStorage.getItem('nebulide-claude-launch-mode')).toBe('z');
    setClaudeLaunchMode('anthropic'); // вернуть дефолт, не мешать другим тестам
  });

  it('маппер связывает выбранный launchMode с провайдером', () => {
    setClaudeLaunchMode('z');
    const { provider } = launchModeToViewProvider(getClaudeLaunchMode());
    expect(provider).toBe('glm');
    setClaudeLaunchMode('anthropic');
  });
});
