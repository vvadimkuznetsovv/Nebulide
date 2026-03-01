package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"nebulide/config"
	"nebulide/database"
	"nebulide/models"
	"nebulide/services"
	"nebulide/utils"
)

type ChatHandler struct {
	cfg      *config.Config
	claude   *services.ClaudeService
	upgrader websocket.Upgrader
}

func NewChatHandler(cfg *config.Config, claude *services.ClaudeService) *ChatHandler {
	return &ChatHandler{
		cfg:    cfg,
		claude: claude,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin:     checkWSOrigin(cfg.AllowedOrigins),
		},
	}
}

type chatMessage struct {
	Type    string `json:"type"`    // "message" | "cancel"
	Content string `json:"content"` // user message text
}

type chatResponse struct {
	Type      string          `json:"type"`                 // "stream" | "complete" | "error" | "thinking"
	Data      json.RawMessage `json:"data,omitempty"`
	SessionID string          `json:"session_id,omitempty"`
	Message   string          `json:"message,omitempty"`
}

func (h *ChatHandler) HandleWebSocket(c *gin.Context) {
	sessionID := c.Param("id")

	// Auth via query param for WebSocket
	token := c.Query("token")
	if token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Token required"})
		return
	}

	claims, err := utils.ParseToken(h.cfg.JWTSecret, token)
	if err != nil || claims.Partial {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid token"})
		return
	}

	// Verify session ownership
	var session models.ChatSession
	if err := database.DB.Where("id = ? AND user_id = ?", sessionID, claims.UserID).First(&session).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	conn, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}
	defer conn.Close()

	sessionKey := sessionID + ":" + claims.UserID.String()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			break
		}

		var msg chatMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			h.sendError(conn, "Invalid message format")
			continue
		}

		switch msg.Type {
		case "message":
			h.handleMessage(conn, &session, sessionKey, msg.Content, claims.UserID)
		case "cancel":
			h.claude.Cancel(sessionKey)
		default:
			h.sendError(conn, "Unknown message type")
		}
	}
}

func (h *ChatHandler) handleMessage(
	conn *websocket.Conn,
	session *models.ChatSession,
	sessionKey string,
	content string,
	userID uuid.UUID,
) {
	if h.claude.IsRunning(sessionKey) {
		h.sendError(conn, "Claude is already processing a message")
		return
	}

	// Save user message
	userMsg := models.Message{
		SessionID: session.ID,
		Role:      "user",
		Content:   content,
	}
	database.DB.Create(&userMsg)

	// Update session timestamp
	database.DB.Model(session).Update("updated_at", time.Now())

	ctx := context.Background()

	go func() {
		var fullResponse string

		newSessionID, err := h.claude.SendMessage(
			ctx,
			sessionKey,
			content,
			session.WorkingDirectory,
			session.ClaudeSessionID,
			func(line string) {
				fullResponse += line + "\n"
				resp := chatResponse{
					Type: "stream",
					Data: json.RawMessage(line),
				}
				data, _ := json.Marshal(resp)
				conn.WriteMessage(websocket.TextMessage, data)
			},
		)

		if err != nil {
			h.sendError(conn, "Claude error: "+err.Error())
			return
		}

		// Update claude session ID
		if newSessionID != "" && session.ClaudeSessionID != newSessionID {
			session.ClaudeSessionID = newSessionID
			database.DB.Model(session).Update("claude_session_id", newSessionID)
		}

		// Save assistant message
		assistantMsg := models.Message{
			SessionID: session.ID,
			Role:      "assistant",
			Content:   fullResponse,
		}
		database.DB.Create(&assistantMsg)

		// Auto-generate title from first message
		if session.Title == "New Chat" {
			title := content
			if len(title) > 50 {
				title = title[:50] + "..."
			}
			database.DB.Model(session).Update("title", title)
		}

		complete := chatResponse{
			Type:      "complete",
			SessionID: newSessionID,
		}
		data, _ := json.Marshal(complete)
		conn.WriteMessage(websocket.TextMessage, data)
	}()
}

func (h *ChatHandler) sendError(conn *websocket.Conn, msg string) {
	resp := chatResponse{
		Type:    "error",
		Message: msg,
	}
	data, _ := json.Marshal(resp)
	conn.WriteMessage(websocket.TextMessage, data)
}
