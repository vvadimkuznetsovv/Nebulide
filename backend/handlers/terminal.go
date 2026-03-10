package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"nebulide/config"
	"nebulide/services"
	"nebulide/utils"
)

const (
	wsPingInterval = 30 * time.Second
	wsPongTimeout  = 45 * time.Second
)

type TerminalHandler struct {
	cfg      *config.Config
	terminal *services.TerminalService
	upgrader websocket.Upgrader
}

func NewTerminalHandler(cfg *config.Config, terminal *services.TerminalService) *TerminalHandler {
	return &TerminalHandler{
		cfg:      cfg,
		terminal: terminal,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin:     checkWSOrigin(cfg.AllowedOrigins),
		},
	}
}

type terminalMessage struct {
	Type string `json:"type"` // "input" | "resize"
	Data string `json:"data,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
}

// wsWriter wraps a websocket.Conn to implement io.Writer.
// Used by pumpOutput (in services/terminal.go) to forward PTY output.
type wsWriter struct {
	conn *websocket.Conn
	mu   sync.Mutex // websocket.Conn is not concurrency-safe for writes
}

func (w *wsWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	err := w.conn.WriteMessage(websocket.BinaryMessage, p)
	if err != nil {
		return 0, err
	}
	return len(p), nil
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

	instanceID := c.Query("instanceId")
	if instanceID == "" {
		instanceID = "default"
	}
	sessionKey := "term:" + claims.UserID.String() + ":" + instanceID

	log.Printf("[Terminal] NEW WS connection: remote=%s instanceId=%q sessionKey=%s",
		c.Request.RemoteAddr, instanceID, sessionKey)

	conn, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("[Terminal] WS upgrade error: %v (key=%s)", err, sessionKey)
		return
	}
	defer func() {
		log.Printf("[Terminal] WS conn closed (defer): key=%s", sessionKey)
		conn.Close()
	}()

	// Per-user workspace directory
	workDir := h.cfg.ClaudeWorkingDir
	if claims.Username != h.cfg.AdminUsername {
		workDir = h.cfg.GetUserWorkspaceDir(claims.Username)
	}

	// Non-admin users get sandboxed shell (mount namespace isolation on Linux)
	sandboxed := claims.Username != h.cfg.AdminUsername

	// Build extra env vars for the terminal session
	extraEnv := map[string]string{}

	// Generate TG_SEND_TOKEN — a scoped 30-day JWT restricted to telegram/send endpoint only
	tgToken, tgErr := utils.GenerateScopedToken(h.cfg.JWTSecret, claims.UserID, claims.Username, "tg-send", 30*24*time.Hour)
	if tgErr == nil {
		extraEnv["TG_SEND_TOKEN"] = tgToken
	}

	// Reuse existing shell or create new one.
	// Shell lives independently of WebSocket — survives reconnections.
	log.Printf("[Terminal] calling GetOrCreate key=%s dir=%s sandboxed=%v user=%s", sessionKey, workDir, sandboxed, claims.Username)
	termSession, err := h.terminal.GetOrCreate(sessionKey, workDir, sandboxed, claims.Username, extraEnv)
	if err != nil {
		log.Printf("[Terminal] failed to create session: %v (key=%s)", err, sessionKey)
		conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","message":"Failed to create terminal"}`))
		return
	}

	// Register this WS as an output destination for the persistent PTY reader.
	// pumpOutput broadcasts to all writers via multiWriter.
	// Multiple devices on the same workspace share one PTY.
	writer := &wsWriter{conn: conn}
	log.Printf("[Terminal] calling AddWriter key=%s", sessionKey)
	termSession.AddWriter(writer, conn)
	log.Printf("[Terminal] AddWriter done key=%s", sessionKey)

	// Ping/pong keepalive — detect dead clients, prevent proxy timeouts.
	// WriteControl is concurrency-safe (doesn't conflict with pumpOutput writes).
	conn.SetReadDeadline(time.Now().Add(wsPongTimeout))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(wsPongTimeout))
		return nil
	})
	go func() {
		ticker := time.NewTicker(wsPingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
					return
				}
			case <-termSession.Done:
				return
			}
		}
	}()

	// Close WS when shell exits (e.g. Ctrl+D / exit) so frontend gets onclose and reconnects.
	// If admin killed the session, send close code 4001 to prevent frontend auto-reconnect.
	go func() {
		<-termSession.Done
		if termSession.Killed {
			log.Printf("[Terminal] admin-killed, sending 4001 key=%s", sessionKey)
			conn.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(4001, "admin-killed"), time.Now().Add(time.Second))
		}
		log.Printf("[Terminal] shell exited, closing WS key=%s", sessionKey)
		conn.Close()
	}()

	// WS → PTY (stdin + control messages)
	log.Printf("[Terminal] WS→PTY loop START key=%s", sessionKey)
	for {
		msgType, raw, err := conn.ReadMessage()
		if err != nil {
			log.Printf("[Terminal] WS→PTY loop STOP (read err: %v) key=%s", err, sessionKey)
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
			log.Printf("[Terminal] JSON unmarshal error: %v (key=%s)", err, sessionKey)
			continue
		}

		switch msg.Type {
		case "input":
			termSession.Pty.Write([]byte(msg.Data))
		case "resize":
			log.Printf("[Terminal] resize rows=%d cols=%d key=%s", msg.Rows, msg.Cols, sessionKey)
			h.terminal.Resize(sessionKey, msg.Rows, msg.Cols)
		}
	}

	// Unregister this writer — other devices may still be connected.
	termSession.RemoveWriter(writer)

	log.Printf("[Terminal] handler EXIT key=%s", sessionKey)
	// Session stays alive — shell persists for reconnection.
}

// KillTerminal allows a user to kill their own terminal session(s) by instanceId.
// Uses prefix match because the actual session key includes "@ws:{sessionId}" suffix.
func (h *TerminalHandler) KillTerminal(c *gin.Context) {
	userID, _ := c.Get("user_id")
	instanceID := c.Param("instanceId")
	if instanceID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "instanceId required"})
		return
	}

	prefix := "term:" + userID.(uuid.UUID).String() + ":" + instanceID
	killed := h.terminal.KillSessionsByPrefix(prefix)

	log.Printf("[Terminal] user killed %d sessions prefix=%s", killed, prefix)
	c.JSON(http.StatusOK, gin.H{"killed": killed})
}
