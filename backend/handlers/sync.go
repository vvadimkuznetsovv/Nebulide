package handlers

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"nebulide/config"
	"nebulide/database"
	"nebulide/utils"
)

type SyncHandler struct {
	cfg      *config.Config
	upgrader websocket.Upgrader
}

func NewSyncHandler(cfg *config.Config) *SyncHandler {
	return &SyncHandler{
		cfg: cfg,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin:     checkWSOrigin(cfg.AllowedOrigins),
		},
	}
}

// HandleWebSocket subscribes to Redis pub/sub for the authenticated user
// and forwards events to the connected WebSocket client.
func (h *SyncHandler) HandleWebSocket(c *gin.Context) {
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

	conn, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("[Sync] WS upgrade error: %v", err)
		return
	}
	defer conn.Close()

	if database.RDB == nil {
		log.Printf("[Sync] Redis not available, closing WS")
		conn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "sync unavailable"))
		return
	}

	channel := "ws:user:" + claims.UserID.String()
	log.Printf("[Sync] Subscribing to %s", channel)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pubsub := database.RDB.Subscribe(ctx, channel)
	defer pubsub.Close()

	// Ping/pong keepalive
	conn.SetReadDeadline(time.Now().Add(45 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(45 * time.Second))
		return nil
	})

	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
					cancel()
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	// Redis → WS: forward pub/sub messages to client
	go func() {
		ch := pubsub.Channel()
		for {
			select {
			case msg, ok := <-ch:
				if !ok {
					cancel()
					return
				}
				if err := conn.WriteMessage(websocket.TextMessage, []byte(msg.Payload)); err != nil {
					cancel()
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	// WS → /dev/null: just keep the read loop alive to detect disconnects
	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			break
		}
	}

	log.Printf("[Sync] Client disconnected from %s", channel)
}
