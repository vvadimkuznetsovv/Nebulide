package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"nebulide/config"
)

func msgLine(uuid, parent, role, text string) string {
	m := map[string]any{
		"type": role, "uuid": uuid, "parentUuid": parent, "sessionId": "s1",
		"timestamp": "2026-06-24T00:00:00Z",
		"message":   map[string]any{"role": role, "content": []map[string]any{{"type": "text", "text": text}}},
	}
	b, _ := json.Marshal(m)
	return string(b) + "\n"
}

// Регресс на «псевдо-войну двух чатов» = ОДИН огромный JSONL (много `claude -c` в один файл),
// который грузился С НАЧАЛА (древний разговор) и «прыгал» по кускам. tail=1 грузит ОТ КОНЦА:
// свежие сообщения видны сразу, древнее начало (вне окна) НЕ показывается.
func TestTailSession_TailLoadsRecentNotAncient(t *testing.T) {
	gin.SetMode(gin.TestMode)
	// Ужимаем хвостовое окно, чтобы небольшой тест-файл (~2.7МБ) триггерил tail-режим (в проде 12МБ).
	origWindow := tailWindow
	tailWindow = 512 * 1024
	defer func() { tailWindow = origWindow }()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	const cwd = "/tmp/ws"
	slug := workspaceSlug(cwd)
	projDir := filepath.Join(home, ".claude", "projects", slug)
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Файл > tailWindow (2MB): древнее сообщение в начале, гора филлера, свежее в конце.
	var sb strings.Builder
	sb.WriteString(msgLine("u0", "", "user", "ANCIENT_rrweb_в_самом_начале"))
	prev := "u0"
	big := strings.Repeat("x", 3000)
	for i := 1; i <= 900; i++ { // ~2.7MB филлера → древнее начало уходит за окно хвоста
		u := fmt.Sprintf("u%d", i)
		sb.WriteString(msgLine(u, prev, "assistant", "filler "+big))
		prev = u
	}
	sb.WriteString(msgLine("uNEW", prev, "assistant", "NEWEST_8vehicles_fleet_montage"))
	if err := os.WriteFile(filepath.Join(projDir, "s1.jsonl"), []byte(sb.String()), 0o644); err != nil {
		t.Fatal(err)
	}

	h := NewClaudeSessionsHandler(&config.Config{ClaudeWorkingDir: cwd, AdminUsername: "admin"})

	get := func(query string) string {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Set("username", "admin")
		c.Params = gin.Params{{Key: "project", Value: slug}, {Key: "sessionFile", Value: "s1"}}
		c.Request = httptest.NewRequest(http.MethodGet, "/"+query, nil)
		h.TailSession(c)
		if w.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
		return w.Body.String()
	}

	// tail=1 → видим СВЕЖЕЕ, НЕ древнее начало.
	body := get("?offset=0&tail=1")
	if !strings.Contains(body, "NEWEST_8vehicles_fleet_montage") {
		t.Errorf("tail: нет свежего сообщения в ответе")
	}
	if strings.Contains(body, "ANCIENT_rrweb_в_самом_начале") {
		t.Errorf("tail: древнее начало НЕ должно попадать в хвостовое окно (это и есть баг «прыжков»)")
	}

	// Без tail (offset 0) старое поведение: грузит с начала (первые 24МБ) — тут весь файл влезает,
	// так что древнее видно. Проверяем, что путь offset=0 не сломан.
	body0 := get("?offset=0")
	if !strings.Contains(body0, "ANCIENT_rrweb_в_самом_начале") {
		t.Errorf("offset0: ожидали древнее начало при загрузке с нуля")
	}
}
