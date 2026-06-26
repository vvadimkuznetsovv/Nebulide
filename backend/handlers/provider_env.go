package handlers

import (
	"strings"

	"nebulide/config"
)

// providerEnv возвращает ANTHROPIC_* env для НЕ-дефолтного провайдера терминального claude.
// Возвращает nil (= провайдер Anthropic по умолчанию), если:
//   - провайдер не "glm", ИЛИ
//   - ключ Z.ai не задан в конфиге (тихий фолбэк на Anthropic — НИКОГДА не ломаем терминал
//     из-за отсутствия ключа; пользователь просто получит обычный claude).
//
// GLM (Z.ai) говорит на Anthropic-совместимом протоколе, поэтому claude переключается на него
// тремя переменными окружения. Эти значения вливаются в extraEnv PTY-сессии (см. terminal.go),
// откуда наследуются процессом claude, запущенным в шелле.
func providerEnv(provider string, cfg *config.Config) map[string]string {
	if provider != "glm" || cfg.ZaiAPIKey == "" {
		return nil
	}
	env := map[string]string{
		"ANTHROPIC_BASE_URL":   cfg.ZaiBaseURL,
		"ANTHROPIC_AUTH_TOKEN": cfg.ZaiAPIKey,
		"ANTHROPIC_MODEL":      cfg.ZaiModel,
	}
	// Модель с суффиксом [1m] (напр. glm-5.2[1m]) = 1M контекста. Без этого окна claude
	// авто-компактит на ~200K и миллион не используется — поднимаем окно авто-компакта.
	if strings.Contains(cfg.ZaiModel, "[1m]") {
		env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = "1000000"
	}
	return env
}
