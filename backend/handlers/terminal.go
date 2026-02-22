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
		log.Printf("Terminal WS upgrade error: %v", err)
		return
	}
	defer conn.Close()

	sessionKey := "term:" + claims.UserID.String()

	// Reuse existing shell or create new one.
	// Shell lives independently of WebSocket — survives reconnections.
	termSession, err := h.terminal.GetOrCreate(sessionKey, h.cfg.ClaudeWorkingDir)
	if err != nil {
		log.Printf("Terminal: failed to create: %v (key=%s)", err, sessionKey)
		conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","message":"Failed to create terminal"}`))
		return
	}

	// Close previous WebSocket (if any) so only one reader is active.
	// Old PTY→WS goroutine will fail on WriteMessage and stop.
	termSession.Attach(conn)

	log.Printf("Terminal: WS attached key=%s", sessionKey)

	// PTY → WebSocket (stdout)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := termSession.Pty.Read(buf)
			if err != nil {
				if err != io.EOF {
					log.Printf("Terminal: PTY read error: %v (key=%s)", err, sessionKey)
				}
				conn.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, "Shell exited"))
				return
			}
			if err := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); err != nil {
				return // WS closed (reconnection or tab closed) — stop reading
			}
		}
	}()

	// WebSocket → PTY (stdin)
	for {
		msgType, raw, err := conn.ReadMessage()
		if err != nil {
			log.Printf("Terminal: WS closed key=%s: %v", sessionKey, err)
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

	// Session stays alive — shell persists for reconnection.
	// Only killed when shell exits or Create is called explicitly.
}
