package services

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// События Claude Code, на которые вешаем nebulide-hook (как в entrypoint.sh ранее).
var hookEvents = []string{
	"UserPromptSubmit", "PreToolUse", "PostToolUse",
	"Stop", "SessionStart", "SessionEnd", "Notification", "PermissionRequest",
}

// RegisterClaudeHooks мерджит наши hooks + statusLine в ~/.claude/settings.json КРОСС-ПЛАТФОРМЕННО
// (замена jq-мерджа из entrypoint.sh — теперь работает и в Docker на Linux, и локально на Windows,
// чтобы claude в терминале Nebulide одинаково дёргал хуки). Скрипты — Node .mjs (один код на обе ОС).
//
// БЕЗОПАСНО: хуки ДОБАВЛЯЕМ в массив каждого события (не затирая чужие — например плагин
// уведомлений продолжит работать), идемпотентно (повторный старт не плодит дубли). statusLine
// ставим, только если его нет или он уже наш (чужой кастомный statusLine не трогаем).
func RegisterClaudeHooks() {
	dir := resolveHooksDir()
	if dir == "" {
		log.Printf("[claudehooks] nebulide-hook.mjs не найден — пропускаю регистрацию хуков")
		return
	}
	settingsPath := claudeSettingsPath()
	if settingsPath == "" {
		log.Printf("[claudehooks] не удалось определить ~/.claude — пропускаю")
		return
	}
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		log.Printf("[claudehooks] mkdir .claude: %v", err)
		return
	}

	settings := map[string]any{}
	if b, err := os.ReadFile(settingsPath); err == nil && len(b) > 0 {
		if err := json.Unmarshal(b, &settings); err != nil {
			log.Printf("[claudehooks] settings.json — невалидный JSON, НЕ трогаю: %v", err)
			return
		}
	}

	hookCmd := nodeCmd(filepath.Join(dir, "nebulide-hook.mjs"))
	statusCmd := nodeCmd(filepath.Join(dir, "nebulide-statusline.mjs"))
	applyNebulideHooks(settings, hookCmd, statusCmd)

	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		log.Printf("[claudehooks] marshal: %v", err)
		return
	}
	if err := os.WriteFile(settingsPath, out, 0o644); err != nil {
		log.Printf("[claudehooks] запись settings.json: %v", err)
		return
	}
	log.Printf("[claudehooks] hooks + statusLine зарегистрированы в %s (скрипты: %s)", settingsPath, dir)
}

// applyNebulideHooks мутирует settings: для каждого события СНОСИТ все прежние группы НАШИХ хуков
// и ставит ровно одну актуальную (.mjs). Это чинит главный баг: старая мёртвая запись из
// entrypoint-эпохи (/app/hooks/nebulide-hook.sh, которой уже нет в образе) копилась рядом с
// актуальной .mjs — claude дёргал несуществующий скрипт на КАЖДОМ событии («nebulide-hook.sh:
// not found»). Чужие хуки (плагины и т.п.) сохраняем; statusLine ставим, только если пусто/наш.
// Чистая — тестируется без файловой системы. Идемпотентна (повторный вызов не плодит дубли).
func applyNebulideHooks(settings map[string]any, hookCmd, statusCmd string) {
	hooks, _ := settings["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}
	for _, ev := range hookEvents {
		arr, _ := hooks[ev].([]any)
		arr = stripNebulideHookGroups(arr, hookCmd) // убрать прежние наши (в т.ч. устаревшие .sh)
		arr = append(arr, map[string]any{
			"matcher": "",
			"hooks":   []any{map[string]any{"type": "command", "command": hookCmd}},
		})
		hooks[ev] = arr
	}
	settings["hooks"] = hooks

	// statusLine single-valued: ставим, если пусто/наш; чужой кастомный НЕ перетираем.
	if sl, ok := settings["statusLine"].(map[string]any); ok {
		if cmd, _ := sl["command"].(string); cmd != "" && !strings.Contains(cmd, "nebulide-statusline") {
			log.Printf("[claudehooks] найден чужой statusLine — НЕ трогаю (контекст-пилюля не активна): %s", cmd)
			return
		}
	}
	settings["statusLine"] = map[string]any{"type": "command", "command": statusCmd}
}

// stripNebulideHookGroups убирает из массива групп события ВСЕ группы, чей хоть один hook-command
// — наш: подстрока "nebulide-hook" (ловит устаревший .sh и прежние пути) ЛИБО точное совпадение с
// текущей командой cur (гарантирует идемпотентность при любом виде команды). Чужие группы
// (плагины и т.п.) сохраняем. Возвращает НОВЫЙ слайс (исходный не мутируем).
func stripNebulideHookGroups(arr []any, cur string) []any {
	out := make([]any, 0, len(arr))
	for _, g := range arr {
		grp, ok := g.(map[string]any)
		if !ok {
			out = append(out, g)
			continue
		}
		hs, _ := grp["hooks"].([]any)
		ours := false
		for _, h := range hs {
			hm, ok := h.(map[string]any)
			if !ok {
				continue
			}
			if c, _ := hm["command"].(string); strings.Contains(c, "nebulide-hook") || c == cur {
				ours = true
				break
			}
		}
		if !ours {
			out = append(out, g)
		}
	}
	return out
}

// hookArrayHasCommand — есть ли уже наша command-команда в массиве групп события (дедуп).
func hookArrayHasCommand(arr []any, cmd string) bool {
	for _, g := range arr {
		grp, ok := g.(map[string]any)
		if !ok {
			continue
		}
		hs, _ := grp["hooks"].([]any)
		for _, h := range hs {
			hm, ok := h.(map[string]any)
			if !ok {
				continue
			}
			if c, _ := hm["command"].(string); c == cmd {
				return true
			}
		}
	}
	return false
}

// claudeSettingsPath — settings.json конфиг-каталога claude (туда же он смотрит). Уважает
// CLAUDE_CONFIG_DIR (если claude запущен с кастомным конфигом), иначе ~/.claude: на Linux в
// Docker — /root/.claude, на Windows — C:\Users\<user>\.claude.
func claudeSettingsPath() string {
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, "settings.json")
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".claude", "settings.json")
}

// resolveHooksDir находит каталог со скриптами hook/statusLine (Docker: /app/hooks;
// локально: <repo>/hooks рядом с exe или cwd). Берём первый, где лежит nebulide-hook.mjs.
func resolveHooksDir() string {
	var cands []string
	if d := os.Getenv("NEBULIDE_HOOKS_DIR"); d != "" {
		cands = append(cands, d)
	}
	cands = append(cands, "/app/hooks")
	if exe, err := os.Executable(); err == nil {
		ed := filepath.Dir(exe)
		cands = append(cands, filepath.Join(ed, "hooks"), filepath.Join(ed, "..", "hooks"))
	}
	if wd, err := os.Getwd(); err == nil {
		cands = append(cands, filepath.Join(wd, "hooks"), filepath.Join(wd, "..", "hooks"))
	}
	for _, c := range cands {
		if _, err := os.Stat(filepath.Join(c, "nebulide-hook.mjs")); err == nil {
			return filepath.Clean(c)
		}
	}
	return ""
}

// nodeCmd — команда запуска .mjs через node (кросс-платформенно; путь в кавычках для пробелов).
func nodeCmd(scriptPath string) string {
	return `node "` + scriptPath + `"`
}
