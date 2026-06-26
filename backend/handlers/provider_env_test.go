package handlers

import (
	"testing"

	"nebulide/config"
)

func TestProviderEnv(t *testing.T) {
	withKey := &config.Config{
		ZaiAPIKey:  "zai-secret-123",
		ZaiBaseURL: "https://api.z.ai/api/anthropic",
		ZaiModel:   "glm-5.2[1m]",
	}
	noKey := &config.Config{
		ZaiBaseURL: "https://api.z.ai/api/anthropic",
		ZaiModel:   "glm-5.2[1m]",
	}

	t.Run("glm с ключом и моделью [1m] отдаёт ANTHROPIC_* + окно авто-компакта 1M", func(t *testing.T) {
		env := providerEnv("glm", withKey)
		if env == nil {
			t.Fatal("ожидали env, получили nil")
		}
		want := map[string]string{
			"ANTHROPIC_BASE_URL":              "https://api.z.ai/api/anthropic",
			"ANTHROPIC_AUTH_TOKEN":            "zai-secret-123",
			"ANTHROPIC_MODEL":                 "glm-5.2[1m]",
			"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1000000",
		}
		if len(env) != len(want) {
			t.Fatalf("ожидали %d переменных, получили %d: %v", len(want), len(env), env)
		}
		for k, v := range want {
			if env[k] != v {
				t.Errorf("%s = %q, ожидали %q", k, env[k], v)
			}
		}
	})

	t.Run("модель без [1m] не добавляет окно авто-компакта", func(t *testing.T) {
		env := providerEnv("glm", &config.Config{ZaiAPIKey: "k", ZaiBaseURL: "u", ZaiModel: "glm-4.6"})
		if _, ok := env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"]; ok {
			t.Errorf("не ожидали окно авто-компакта для не-1m модели: %v", env)
		}
		if len(env) != 3 {
			t.Fatalf("ожидали 3 переменные для не-1m модели, получили %d: %v", len(env), env)
		}
	})

	t.Run("glm БЕЗ ключа = nil (тихий фолбэк на Anthropic)", func(t *testing.T) {
		if env := providerEnv("glm", noKey); env != nil {
			t.Fatalf("ожидали nil без ключа, получили %v", env)
		}
	})

	t.Run("anthropic = nil", func(t *testing.T) {
		if env := providerEnv("anthropic", withKey); env != nil {
			t.Fatalf("ожидали nil для anthropic, получили %v", env)
		}
	})

	t.Run("пустой провайдер = nil", func(t *testing.T) {
		if env := providerEnv("", withKey); env != nil {
			t.Fatalf("ожидали nil для пустого провайдера, получили %v", env)
		}
	})

	t.Run("неизвестный провайдер = nil", func(t *testing.T) {
		if env := providerEnv("openai", withKey); env != nil {
			t.Fatalf("ожидали nil для неизвестного провайдера, получили %v", env)
		}
	})
}
