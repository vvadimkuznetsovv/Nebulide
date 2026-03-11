package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"nebulide/config"
	"nebulide/database"
	"nebulide/utils"
)

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

	if database.RDB != nil {
		payload := map[string]interface{}{
			"type":        "claude_hook",
			"event":       event.Event,
			"instance_id": event.InstanceID,
			"session_id":  event.SessionID,
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

		data, _ := json.Marshal(payload)
		channel := "ws:user:" + claims.UserID.String()
		database.RDB.Publish(context.Background(), channel, string(data))
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}
