import api from './client';

// Статус доступности GLM (Z.ai) для индикатора на кнопке «Z».
// Источник на бэке — бесплатный usage-эндпоинт Z.ai (промпт не тратится).
export interface GlmStatus {
  enabled: boolean;       // задан ли ZAI_API_KEY (иначе режима Z нет)
  available: boolean;     // зелёный? (5-часовой лимит не исчерпан)
  level?: string;         // pro / lite / max
  cycle_percent?: number; // 5-часовой цикл: % использования
  cycle_reset_at?: number;// epoch-ms сброса 5-часового цикла
  week_percent?: number;
  week_reset_at?: number;
}

export const getGlmStatus = () => api.get<GlmStatus>('/glm-status');
