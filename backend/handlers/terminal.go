package handlers

import (
	"encoding/json"
	"io"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"clauder/config"
	"clauder/services"
	"clauder/utils"
)

var termUpgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

type TerminalHandler struct {
	cfg      *config.Config
	terminal *services.TerminalService
}

func NewTerminalHandler(cfg *config.Config, terminal *services.TerminalService) *TerminalHandler {
	return &TerminalHandler{cfg: cfg, terminal: terminal}
}

type terminalMessage struct {
	Type string `json:"type"` // "input" | "resize"
	Data string `json:"data,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
}

func (h *TerminalHandler) HandleWebSocket(c *gin.Context) {
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

	conn, err := termUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("Terminal WebSocket upgrade error: %v", err)
		return
	}
	defer conn.Close()

	sessionKey := "term:" + claims.UserID.String()

	termSession, err := h.terminal.Create(sessionKey, h.cfg.ClaudeWorkingDir)
	if err != nil {
		log.Printf("Failed to create terminal: %v", err)
		conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","message":"Failed to create terminal"}`))
		return
	}
	defer h.terminal.Remove(sessionKey)

	// PTY → WebSocket (stdout)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := termSession.Pty.Read(buf)
			if err != nil {
				if err != io.EOF {
					log.Printf("PTY read error: %v", err)
				}
				conn.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, "Terminal closed"))
				return
			}
			if err := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); err != nil {
				return
			}
		}
	}()

	// WebSocket → PTY (stdin)
	for {
		msgType, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}

		if msgType == websocket.BinaryMessage {
			// Raw terminal input
			termSession.Pty.Write(raw)
			continue
		}

		// JSON control messages
		var msg terminalMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "input":
			termSession.Pty.Write([]byte(msg.Data))
		case "resize":
			h.terminal.Resize(sessionKey, msg.Rows, msg.Cols)
		}
	}
}
