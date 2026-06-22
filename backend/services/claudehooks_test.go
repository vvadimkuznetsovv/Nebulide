package services

import "testing"

// Пустой конфиг → хуки на все события + наш statusLine.
func TestApplyNebulideHooks_Empty(t *testing.T) {
	s := map[string]any{}
	applyNebulideHooks(s, `node "h.mjs"`, `node "s.mjs"`)
	hooks, _ := s["hooks"].(map[string]any)
	for _, ev := range hookEvents {
		arr, _ := hooks[ev].([]any)
		if len(arr) != 1 {
			t.Fatalf("событие %s: ждём 1 группу, получили %d", ev, len(arr))
		}
	}
	sl, _ := s["statusLine"].(map[string]any)
	if sl["command"] != `node "s.mjs"` {
		t.Fatalf("statusLine не установлен: %v", sl)
	}
}

// Чужой хук на Stop сохраняется, наш ДОБАВЛЯЕТСЯ рядом.
func TestApplyNebulideHooks_PreservesForeign(t *testing.T) {
	s := map[string]any{
		"hooks": map[string]any{
			"Stop": []any{map[string]any{"matcher": "", "hooks": []any{map[string]any{"type": "command", "command": "foreign-notify"}}}},
		},
	}
	applyNebulideHooks(s, `node "h.mjs"`, `node "s.mjs"`)
	stop, _ := s["hooks"].(map[string]any)["Stop"].([]any)
	if len(stop) != 2 {
		t.Fatalf("Stop: ждём 2 (чужой + наш), получили %d", len(stop))
	}
	if !hookArrayHasCommand(stop, "foreign-notify") {
		t.Fatal("чужой хук потерян")
	}
	if !hookArrayHasCommand(stop, `node "h.mjs"`) {
		t.Fatal("наш хук не добавлен")
	}
}

// Устаревшая мёртвая запись (старый .sh из entrypoint-эпохи) ЗАМЕНЯЕТСЯ на актуальную .mjs,
// а не копится рядом — это и есть главный баг «nebulide-hook.sh: not found».
func TestApplyNebulideHooks_ReplacesStaleSh(t *testing.T) {
	s := map[string]any{
		"hooks": map[string]any{
			"Stop": []any{
				map[string]any{"matcher": "", "hooks": []any{map[string]any{"type": "command", "command": "/app/hooks/nebulide-hook.sh"}}},
				map[string]any{"matcher": "", "hooks": []any{map[string]any{"type": "command", "command": "foreign-notify"}}},
			},
		},
	}
	applyNebulideHooks(s, `node "h.mjs"`, `node "s.mjs"`)
	stop, _ := s["hooks"].(map[string]any)["Stop"].([]any)
	if len(stop) != 2 {
		t.Fatalf("Stop: ждём 2 (чужой + актуальный наш), получили %d", len(stop))
	}
	if hookArrayHasCommand(stop, "/app/hooks/nebulide-hook.sh") {
		t.Fatal("устаревший .sh не удалён")
	}
	if !hookArrayHasCommand(stop, `node "h.mjs"`) {
		t.Fatal("актуальный .mjs не добавлен")
	}
	if !hookArrayHasCommand(stop, "foreign-notify") {
		t.Fatal("чужой хук потерян")
	}
}

// Повторный вызов не плодит дубли (идемпотентность).
func TestApplyNebulideHooks_Idempotent(t *testing.T) {
	s := map[string]any{}
	applyNebulideHooks(s, `node "h.mjs"`, `node "s.mjs"`)
	applyNebulideHooks(s, `node "h.mjs"`, `node "s.mjs"`)
	stop, _ := s["hooks"].(map[string]any)["Stop"].([]any)
	if len(stop) != 1 {
		t.Fatalf("идемпотентность: Stop ждём 1, получили %d", len(stop))
	}
}

// Чужой кастомный statusLine НЕ перетираем.
func TestApplyNebulideHooks_PreservesForeignStatusLine(t *testing.T) {
	s := map[string]any{"statusLine": map[string]any{"type": "command", "command": "my-custom-statusline.sh"}}
	applyNebulideHooks(s, `node "h.mjs"`, `node "s.mjs"`)
	sl, _ := s["statusLine"].(map[string]any)
	if sl["command"] != "my-custom-statusline.sh" {
		t.Fatalf("чужой statusLine перетёрт: %v", sl["command"])
	}
}
