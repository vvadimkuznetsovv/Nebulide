package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"nebulide/config"
	"nebulide/database"
	"nebulide/models"
	"nebulide/utils"
)

// liveClaudeSession records the latest known Claude session for a terminal
// instance, learned from Claude Code hook events. Lets the chat-view wrapper
// map a terminal instanceId → its exact live session JSONL (sessionId + cwd).
type liveClaudeSession struct {
	SessionID      string
	CWD            string
	TranscriptPath string // точный путь к JSONL от claude — резолв берёт его напрямую
	Event          string
	UpdatedAt      time.Time
	Ended          bool // SessionEnd пришёл, но держим запись короткий грейс (см. liveEndGrace)
}

var (
	liveSessMu sync.RWMutex
	liveSess   = map[string]liveClaudeSession{} // instanceID → latest session info
	// Грейс после SessionEnd: НЕ забываем сессию мгновенно. /resume = SessionEnd старой →
	// SessionStart новой; в зазоре между ними карта иначе пуста → резолвер падает на
	// «новейший-на-диске» (чужая старая сессия) → мигание после /resume. Держим только-что-
	// закрытую сессию, пока новый SessionStart её не перезапишет; по истечении грейса — забываем
	// (терминал реально мёртв). var (не const) — тест ужимает грейс для проверки истечения.
	liveEndGrace = 30 * time.Second
)

// tailWindow — размер хвостового окна для tail=1 (см. TailSession). ДОЛЖЕН быть больше самой
// длинной строки JSONL (в сессиях claude встречаются строки по 9–10МБ: вкрученные base64-картинки/
// rrweb-записи). Иначе окно может целиком попасть ВНУТРЬ одной гигантской строки → ни одной целой
// строки → пустой хвост → вид показывает старое из кэша. var (не const) — тест ужимает для маленьких файлов.
var tailWindow int64 = 12 * 1024 * 1024

// recordLiveSession is called on every hook event to keep the instance→session map fresh.
func recordLiveSession(instanceID, sessionID, cwd, transcriptPath, event string) {
	if instanceID == "" || sessionID == "" {
		return
	}
	liveSessMu.Lock()
	prev := liveSess[instanceID]
	if cwd == "" {
		cwd = prev.CWD // keep last known cwd if this event omitted it
	}
	if transcriptPath == "" {
		transcriptPath = prev.TranscriptPath
	}
	liveSess[instanceID] = liveClaudeSession{SessionID: sessionID, CWD: cwd, TranscriptPath: transcriptPath, Event: event, UpdatedAt: time.Now()}
	liveSessMu.Unlock()
	// ДИАГНОСТИКА «войны сессий»: логируем КАЖДУЮ смену привязки instance→session (кто кого
	// перезатирает и каким событием). Сменился sid у инстанса = потенциальный источник скачка вида.
	if prev.SessionID != "" && prev.SessionID != sessionID {
		log.Printf("[LiveSess] instance=%s СМЕНА sid %s→%s event=%s prevEnded=%v prevEvent=%s cwd=%q",
			instanceID, prev.SessionID, sessionID, event, prev.Ended, prev.Event, cwd)
	} else {
		log.Printf("[LiveSess] instance=%s set sid=%s event=%s cwd=%q", instanceID, sessionID, event, cwd)
	}
}

// clearLiveSession drops the instance→session entry when claude exits (SessionEnd).
// Without this, a REUSED terminal keeps the OLD session in the map; opening a new
// session there (claude --resume blocks on the resume-mode menu before SessionStart
// updates the map) makes the resolver return the STALE/ancient session. Cleared → the
// resolver falls through to the explicit sessionId hint / cwd → the correct session.
func clearLiveSession(instanceID string) {
	if instanceID == "" {
		return
	}
	liveSessMu.Lock()
	// Мягкий конец: НЕ удаляем запись, а помечаем Ended + ставим время. Резолв в течение грейса
	// продолжит отдавать ЭТУ сессию (её JSONL ещё валиден), а не падать на «новейший-на-диске» —
	// убирает мигание в зазоре /resume (SessionEnd→SessionStart). recordLiveSession (любое НЕ-end
	// событие) воскрешает запись (Ended=false). По истечении грейса GetLiveSession её игнорирует.
	endedSid := ""
	if s, ok := liveSess[instanceID]; ok {
		s.Ended = true
		s.UpdatedAt = time.Now()
		liveSess[instanceID] = s
		endedSid = s.SessionID
	}
	liveSessMu.Unlock()
	log.Printf("[LiveSess] instance=%s SessionEnd (мягкий конец, грейс %s) sid=%s", instanceID, liveEndGrace, endedSid)
}

// GetLiveSession returns the latest hook-tracked session for a terminal instance.
// Ended-сессию отдаём только в течение liveEndGrace (см. clearLiveSession): во время /resume
// держим только-что-закрытую сессию, но «мёртвый» терминал (грейс истёк) забываем → резолв уходит
// в cwd/hint-фолбэк, а не показывает древний закрытый чат вечно.
func GetLiveSession(instanceID string) (sessionID, cwd, transcriptPath string, ok bool) {
	liveSessMu.RLock()
	defer liveSessMu.RUnlock()
	if s, found := liveSess[instanceID]; found {
		if s.Ended && time.Since(s.UpdatedAt) > liveEndGrace {
			return "", "", "", false
		}
		return s.SessionID, s.CWD, s.TranscriptPath, true
	}
	return "", "", "", false
}

// Claude Code fires hooks (UserPromptSubmit, PreToolUse, PostToolUse,
// PreCompact, Stop, etc.) via shell commands registered in ~/.claude/settings.json.
// The hook script reads JSON from stdin and POSTs it here.
// Auth: scoped JWT with purpose "claude-hook" (injected as NEBULIDE_HOOK_TOKEN env var).

type HookHandler struct {
	cfg *config.Config
}

func NewHookHandler(cfg *config.Config) *HookHandler {
	return &HookHandler{cfg: cfg}
}

type ClaudeHookEvent struct {
	SessionID      string                 `json:"session_id"`
	CWD            string                 `json:"cwd,omitempty"`
	TranscriptPath string                 `json:"transcript_path,omitempty"`
	Event          string                 `json:"event"`
	Status         string                 `json:"status,omitempty"`
	Tool           string                 `json:"tool,omitempty"`
	ToolInput      map[string]interface{} `json:"tool_input,omitempty"`
	UserPrompt     string                 `json:"user_prompt,omitempty"`
	PermissionMode string                 `json:"permission_mode,omitempty"`
	InstanceID     string                 `json:"instance_id,omitempty"`
	// statusLine (event="StatusLine"): живой контекст/токены/стоимость сессии.
	Model         string          `json:"model,omitempty"`
	ContextWindow json.RawMessage `json:"context_window,omitempty"`
	Cost          json.RawMessage `json:"cost,omitempty"`
}

// statusLine шлётся часто — дебаунсим форвард контекста на инстанс.
var (
	statusDebMu   sync.Mutex
	statusDebLast = map[string]time.Time{}
)

func (h *HookHandler) HandleClaudeHook(c *gin.Context) {
	tokenStr := ""
	if auth := c.GetHeader("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		tokenStr = strings.TrimPrefix(auth, "Bearer ")
	}
	if tokenStr == "" {
		tokenStr = c.Query("token")
	}
	if tokenStr == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "token required"})
		return
	}

	claims, err := utils.ParseToken(h.cfg.JWTSecret, tokenStr)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
		return
	}
	if claims.Purpose != "claude-hook" {
		c.JSON(http.StatusForbidden, gin.H{"error": "wrong token scope"})
		return
	}

	var event ClaudeHookEvent
	if err := c.ShouldBindJSON(&event); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON"})
		return
	}

	// statusLine — отдельный лёгкий путь: форвардим живой контекст/токены в чат
	// (дебаунс), без записи сессии / Telegram / общего claude_hook-форварда.
	if event.Event == "StatusLine" {
		h.forwardStatus(claims.UserID, event)
		c.JSON(http.StatusOK, gin.H{"ok": true})
		return
	}

	log.Printf("[Hook] event=%s instance=%s tool=%s session=%s user=%s",
		event.Event, event.InstanceID, event.Tool, event.SessionID, claims.Username)

	// Track instance → live session so the chat-view wrapper can resolve the JSONL.
	// On SessionEnd, CLEAR the entry (claude exited) — иначе переиспользованный терминал
	// держит старую сессию и резолвер отдаёт древний чат вместо открытого.
	if event.Event == "SessionEnd" {
		clearLiveSession(event.InstanceID)
	} else {
		recordLiveSession(event.InstanceID, event.SessionID, event.CWD, event.TranscriptPath, event.Event)
	}

	if database.RDB != nil {
		payload := map[string]interface{}{
			"type":        "claude_hook",
			"event":       event.Event,
			"instance_id": event.InstanceID,
			"session_id":  event.SessionID,
		}
		if event.CWD != "" {
			payload["cwd"] = event.CWD
		}
		if event.Tool != "" {
			payload["tool"] = event.Tool
		}
		if event.UserPrompt != "" {
			payload["user_prompt"] = event.UserPrompt
		}
		if event.Status != "" {
			payload["status"] = event.Status
		}
		if event.PermissionMode != "" {
			payload["permission_mode"] = event.PermissionMode
		}
		if len(event.ToolInput) > 0 {
			payload["tool_input"] = event.ToolInput
		}

		data, _ := json.Marshal(payload)
		channel := "ws:user:" + claims.UserID.String()
		database.RDB.Publish(context.Background(), channel, string(data))
	}

	// Opt-in Telegram notification: claude finished a turn or needs the user.
	switch event.Event {
	case "Stop", "SessionEnd", "Notification", "PermissionRequest":
		h.maybeNotifyTelegram(claims.UserID, event.InstanceID, event.CWD, event.Event)
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// forwardStatus публикует живой контекст/токены/стоимость (из statusLine) в чат через
// Redis (тип claude_status). Дебаунс на инстанс — statusLine срабатывает часто.
func (h *HookHandler) forwardStatus(userID uuid.UUID, event ClaudeHookEvent) {
	if database.RDB == nil || event.InstanceID == "" {
		return
	}
	statusDebMu.Lock()
	if time.Since(statusDebLast[event.InstanceID]) < 1500*time.Millisecond {
		statusDebMu.Unlock()
		return
	}
	statusDebLast[event.InstanceID] = time.Now()
	statusDebMu.Unlock()

	payload := map[string]interface{}{
		"type":        "claude_status",
		"instance_id": event.InstanceID,
		"session_id":  event.SessionID,
	}
	if event.Model != "" {
		payload["model"] = event.Model
	}
	if len(event.ContextWindow) > 0 {
		payload["context_window"] = event.ContextWindow
	}
	if len(event.Cost) > 0 {
		payload["cost"] = event.Cost
	}
	data, _ := json.Marshal(payload)
	database.RDB.Publish(context.Background(), "ws:user:"+userID.String(), string(data))
}

// Per-user debounce so rapid turns don't flood Telegram.
var (
	tgNotifyMu   sync.Mutex
	tgNotifyLast = map[string]time.Time{}
)

// maybeNotifyTelegram pings the user in Telegram (if they opted in and linked an account)
// when claude finishes or waits. Debounced per user. Fire-and-forget.
func (h *HookHandler) maybeNotifyTelegram(userID uuid.UUID, instanceID, cwd, event string) {
	if h.cfg.TelegramBotToken == "" {
		return
	}
	var user models.User
	if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
		return
	}
	if !user.NotifyTelegram || user.TelegramID == 0 {
		return
	}
	// Debounce per session (instanceID), not per user → каждый claude уведомляет отдельно
	// и не схлопывается в один безликий пинг.
	key := instanceID
	if key == "" {
		key = userID.String()
	}
	tgNotifyMu.Lock()
	if time.Since(tgNotifyLast[key]) < 15*time.Second {
		tgNotifyMu.Unlock()
		return
	}
	tgNotifyLast[key] = time.Now()
	tgNotifyMu.Unlock()

	// Указываем, КАКОЙ именно claude — по имени папки (basename cwd).
	where := ""
	if cwd != "" {
		where = " — 📁 " + filepath.Base(cwd)
	}
	text := "⏳ Claude ждёт ответа" + where
	if event == "Stop" || event == "SessionEnd" {
		text = "✅ Claude закончил" + where
	}
	go sendTelegramMessage(h.cfg.TelegramBotToken, user.TelegramID, text)
}

func sendTelegramMessage(token string, chatID int64, text string) {
	form := url.Values{}
	form.Set("chat_id", strconv.FormatInt(chatID, 10))
	form.Set("text", text)
	client := &http.Client{Timeout: 5 * time.Second}
	if resp, err := client.PostForm("https://api.telegram.org/bot"+token+"/sendMessage", form); err == nil {
		resp.Body.Close()
	}
}
