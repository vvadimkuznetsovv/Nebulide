package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"nebulide/config"
	"nebulide/database"
	"nebulide/utils"
)

// liveClaudeSession records the latest known Claude session for a terminal
// instance, learned from Claude Code hook events. Lets the chat-view wrapper
// map a terminal instanceId → its exact live session JSONL (sessionId + cwd).
type liveClaudeSession struct {
	SessionID string
	CWD       string
	Event     string
	UpdatedAt time.Time
}

var (
	liveSessMu sync.RWMutex
	liveSess   = map[string]liveClaudeSession{} // instanceID → latest session info
)

// recordLiveSession is called on every hook event to keep the instance→session map fresh.
func recordLiveSession(instanceID, sessionID, cwd, event string) {
	if instanceID == "" || sessionID == "" {
		return
	}
	liveSessMu.Lock()
	prev := liveSess[instanceID]
	if cwd == "" {
		cwd = prev.CWD // keep last known cwd if this event omitted it
	}
	liveSess[instanceID] = liveClaudeSession{SessionID: sessionID, CWD: cwd, Event: event, UpdatedAt: time.Now()}
	liveSessMu.Unlock()
}

// GetLiveSession returns the latest hook-tracked session for a terminal instance.
func GetLiveSession(instanceID string) (sessionID, cwd string, ok bool) {
	liveSessMu.RLock()
	defer liveSessMu.RUnlock()
	if s, found := liveSess[instanceID]; found {
		return s.SessionID, s.CWD, true
	}
	return "", "", false
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
	Event          string                 `json:"event"`
	Status         string                 `json:"status,omitempty"`
	Tool           string                 `json:"tool,omitempty"`
	ToolInput      map[string]interface{} `json:"tool_input,omitempty"`
	UserPrompt     string                 `json:"user_prompt,omitempty"`
	PermissionMode string                 `json:"permission_mode,omitempty"`
	InstanceID     string                 `json:"instance_id,omitempty"`
}

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

	log.Printf("[Hook] event=%s instance=%s tool=%s session=%s user=%s",
		event.Event, event.InstanceID, event.Tool, event.SessionID, claims.Username)

	// Track instance → live session so the chat-view wrapper can resolve the JSONL.
	recordLiveSession(event.InstanceID, event.SessionID, event.CWD, event.Event)

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

	c.JSON(http.StatusOK, gin.H{"ok": true})
}
