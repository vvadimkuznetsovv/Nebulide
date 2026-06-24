package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"

	"nebulide/config"
)

// Регресс на «два чата воюют / показывается старый монстр вместо нового пустого чата».
// Сценарий с прода (cars_site): живой claude (хук) сообщил НОВУЮ сессию своего терминала,
// но её JSONL ещё НЕ записан (юзер ничего не написал). В папке при этом лежит СТАРЫЙ огромный
// JSONL (от прошлого `claude -c`). Резолвер ОБЯЗАН вернуть сессию из ХУКА (живой чат), а НЕ
// воскрешать старый файл как «новейший». Прежде tier0/tier1 требовали наличие файла → промах →
// падение в новейший-в-папке → старьё.
func TestResolveLive_HookWinsOverOnDiskMonster(t *testing.T) {
	gin.SetMode(gin.TestMode)
	home := t.TempDir()
	t.Setenv("HOME", home)        // os.UserHomeDir на Linux
	t.Setenv("USERPROFILE", home) // os.UserHomeDir на Windows

	const cwd = "/tmp/ws"
	slug := workspaceSlug(cwd) // = -tmp-ws
	projDir := filepath.Join(home, ".claude", "projects", slug)
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}
	const oldMonster = "61b70890-bfd8-48eb-a775-ba57186c2ace" // старый огромный JSONL в папке
	const liveSid = "c90e17b7-6d1b-4cd6-8c80-517fbfa2ea9f"    // живая сессия терминала из хука
	if err := os.WriteFile(filepath.Join(projDir, oldMonster+".jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// liveSid.jsonl НАМЕРЕННО не создаём — новая сессия ещё не записана на диск.
	transcript := filepath.Join(projDir, liveSid+".jsonl")

	h := NewClaudeSessionsHandler(&config.Config{ClaudeWorkingDir: cwd, AdminUsername: "admin"})

	call := func(instanceID, cwdQuery string) map[string]any {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Set("username", "admin")
		c.Request = httptest.NewRequest(http.MethodGet,
			"/?instanceId="+instanceID+"&cwd="+cwdQuery, nil)
		h.ResolveLive(c)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body=%s)", w.Code, w.Body.String())
		}
		var got map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatalf("bad json: %v", err)
		}
		return got
	}

	// 1) Хук с transcript_path (tier0): живая сессия, файла нет → всё равно отдаём ЕЁ, не монстра.
	const inst1 = "claude-aaa"
	recordLiveSession(inst1, liveSid, cwd, transcript, "SessionStart")
	t.Cleanup(func() { clearLiveSession(inst1) })
	got := call(inst1, "") // cwd="" — как шлёт фронт на проде
	if got["session_id"] != liveSid {
		t.Errorf("tier0: session_id = %v, want %s (живая сессия из хука)", got["session_id"], liveSid)
	}
	if got["session_file"] != liveSid {
		t.Errorf("tier0: session_file = %v, want %s (НЕ старый монстр %s)", got["session_file"], liveSid, oldMonster)
	}

	// 2) Хук без transcript_path, только sid+cwd (tier1): файла нет → канонический путь по sid.
	const inst2 = "claude-bbb"
	recordLiveSession(inst2, liveSid, cwd, "", "UserPromptSubmit")
	t.Cleanup(func() { clearLiveSession(inst2) })
	got = call(inst2, "")
	if got["session_file"] != liveSid {
		t.Errorf("tier1: session_file = %v, want %s (НЕ старый монстр)", got["session_file"], liveSid)
	}

	// 3) БЕЗ хука вообще: фолбэк по cwd честно отдаёт новейший-в-папке (старый монстр) — это ок,
	//    тут другого источника нет. Проверяем, что фолбэк не сломан.
	const inst3 = "claude-ccc"
	got = call(inst3, cwd)
	if got["session_file"] != oldMonster {
		t.Errorf("fallback: session_file = %v, want %s (новейший-в-папке без хука)", got["session_file"], oldMonster)
	}
}
