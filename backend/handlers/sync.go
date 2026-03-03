package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"nebulide/config"
	"nebulide/database"
	"nebulide/utils"
)

// ---------- types ----------

type syncClientMsg struct {
	Type       string `json:"type"`                  // device_register | heartbeat | force_takeover
	DeviceID   string `json:"device_id,omitempty"`
	DeviceType string `json:"device_type,omitempty"` // phone | tablet | desktop
	SessionID  string `json:"session_id,omitempty"`  // workspace session UUID
}

type syncServerMsg struct {
	Type      string    `json:"type"`                 // register_ok | workspace_locked | workspace_unlocked | force_disconnected
	SessionID string    `json:"session_id,omitempty"`
	LockedBy  *LockInfo `json:"locked_by,omitempty"`
}

// LockInfo describes the device currently holding a workspace lock.
// Exported so workspace_sessions.go can reuse it.
type LockInfo struct {
	DeviceID    string `json:"device_id"`
	DeviceType  string `json:"device_type"`
	UserID      string `json:"user_id"`
	ConnectedAt string `json:"connected_at"`
}

// ---------- handler ----------

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

// HandleWebSocket is a bidirectional sync channel.
// It subscribes to Redis pub/sub for the user AND processes client messages
// for device registration, heartbeat and lock management.
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

	userID := claims.UserID.String()
	channel := "ws:user:" + userID
	log.Printf("[Sync] Subscribing to %s", channel)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pubsub := database.RDB.Subscribe(ctx, channel)
	defer pubsub.Close()

	// --- connection state ---
	var (
		deviceID        string
		deviceType      string
		activeSessionID string
		mu              sync.Mutex // protects conn writes
	)

	sendJSON := func(msg syncServerMsg) {
		mu.Lock()
		defer mu.Unlock()
		conn.WriteJSON(msg)
	}

	// --- ping / pong keepalive ---
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
				mu.Lock()
				err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
				mu.Unlock()
				if err != nil {
					cancel()
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	// --- lock heartbeat goroutine (refreshes Redis TTL every 15s) ---
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if activeSessionID != "" && deviceID != "" {
					result := h.refreshLock(ctx, activeSessionID, deviceID)
					if result != lockOK {
						log.Printf("[Sync] goroutine refreshLock: sessionID=%s deviceID=%s result=%d", activeSessionID, deviceID, result)
					}
					switch result {
					case lockExpired:
						sendJSON(syncServerMsg{
							Type:      "workspace_unlocked",
							SessionID: activeSessionID,
						})
					case lockStolen:
						// Another device took over — stop heartbeating.
						// force_disconnected already sent via pub/sub.
						activeSessionID = ""
					}
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	// --- Redis → WS: forward pub/sub messages ---
	go func() {
		ch := pubsub.Channel()
		for {
			select {
			case msg, ok := <-ch:
				if !ok {
					cancel()
					return
				}
				log.Printf("[Sync] pubsub→WS: deviceID=%s payload=%s", deviceID, msg.Payload)
				mu.Lock()
				err := conn.WriteMessage(websocket.TextMessage, []byte(msg.Payload))
				mu.Unlock()
				if err != nil {
					cancel()
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	// --- WS read loop: process client messages ---
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var msg syncClientMsg
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "device_register":
			deviceID = msg.DeviceID
			deviceType = msg.DeviceType
			log.Printf("[Sync] device_register: deviceID=%s type=%s sessionID=%s userID=%s", deviceID, deviceType, msg.SessionID, userID)

			if msg.SessionID == "" {
				log.Printf("[Sync] device_register: no sessionID, skipping lock")
				sendJSON(syncServerMsg{Type: "register_ok"})
				continue
			}

			// Release old lock if switching workspaces
			if activeSessionID != "" && activeSessionID != msg.SessionID {
				h.releaseLock(ctx, activeSessionID, deviceID)
				h.publishLockEvent(userID, "workspace_unlocked", activeSessionID, nil)
			}

			existing, lockErr := h.acquireLock(ctx, msg.SessionID, userID, deviceID, deviceType)
			log.Printf("[Sync] acquireLock: sessionID=%s deviceID=%s err=%v existing=%+v", msg.SessionID, deviceID, lockErr, existing)
			if lockErr != nil {
				// Another device holds the lock — check priority
				dt := strings.ToLower(existing.DeviceType)
				isMobileHolder := dt == "phone" || dt == "tablet"
				log.Printf("[Sync] lock conflict: holder=%s holderType=%s isMobileHolder=%v", existing.DeviceID, existing.DeviceType, isMobileHolder)

				if isMobileHolder {
					// Mobile holds lock → block new device (mobile priority)
					activeSessionID = msg.SessionID
					log.Printf("[Sync] mobile priority: blocking new device %s", deviceID)
					sendJSON(syncServerMsg{
						Type:      "workspace_locked",
						SessionID: msg.SessionID,
						LockedBy:  existing,
					})
				} else {
					// Desktop holds lock → auto-takeover (last-device-wins)
					log.Printf("[Sync] desktop holder: auto-takeover by %s", deviceID)
					info := h.forceTakeover(ctx, msg.SessionID, userID, deviceID, deviceType)
					activeSessionID = msg.SessionID
					sendJSON(syncServerMsg{Type: "register_ok", SessionID: msg.SessionID})
					h.publishLockEvent(userID, "force_disconnected", msg.SessionID, info)
				}
			} else {
				activeSessionID = msg.SessionID
				log.Printf("[Sync] lock acquired: sessionID=%s deviceID=%s", msg.SessionID, deviceID)
				sendJSON(syncServerMsg{Type: "register_ok", SessionID: msg.SessionID})
				h.publishLockEvent(userID, "workspace_locked", msg.SessionID, existing)
			}

		case "heartbeat":
			if activeSessionID != "" && deviceID != "" {
				result := h.refreshLock(ctx, activeSessionID, deviceID)
				log.Printf("[Sync] heartbeat refreshLock: sessionID=%s deviceID=%s result=%d", activeSessionID, deviceID, result)
				switch result {
				case lockExpired:
					sendJSON(syncServerMsg{
						Type:      "workspace_unlocked",
						SessionID: activeSessionID,
					})
				case lockStolen:
					activeSessionID = ""
				}
			}

		case "force_takeover":
			if msg.SessionID != "" && deviceID != "" {
				info := h.forceTakeover(ctx, msg.SessionID, userID, deviceID, deviceType)
				activeSessionID = msg.SessionID
				sendJSON(syncServerMsg{Type: "register_ok", SessionID: msg.SessionID})
				h.publishLockEvent(userID, "force_disconnected", msg.SessionID, info)
			}
		}
	}

	// --- cleanup: release lock on disconnect ---
	if activeSessionID != "" && deviceID != "" {
		log.Printf("[Sync] cleanup: releasing lock sessionID=%s deviceID=%s", activeSessionID, deviceID)
		h.releaseLock(context.Background(), activeSessionID, deviceID)
		h.publishLockEvent(userID, "workspace_unlocked", activeSessionID, nil)
	}

	log.Printf("[Sync] Client disconnected from %s device=%s", channel, deviceID)
}

// ---------- Redis lock helpers ----------

func lockKey(sessionID string) string {
	return "workspace_lock:" + sessionID
}

// acquireLock tries to acquire an exclusive lock.
// Returns our lockInfo on success, or the existing holder's lockInfo + error.
func (h *SyncHandler) acquireLock(ctx context.Context, sessionID, userID, deviceID, deviceType string) (*LockInfo, error) {
	key := lockKey(sessionID)
	info := LockInfo{
		DeviceID:    deviceID,
		DeviceType:  deviceType,
		UserID:      userID,
		ConnectedAt: time.Now().UTC().Format(time.RFC3339),
	}
	data, _ := json.Marshal(info)

	ok, err := database.RDB.SetNX(ctx, key, string(data), 45*time.Second).Result()
	if err != nil {
		return nil, err
	}
	if ok {
		return &info, nil
	}

	// Lock exists — check if same device (reconnect / another tab)
	existing, err := database.RDB.Get(ctx, key).Result()
	if err != nil {
		return nil, fmt.Errorf("workspace_locked")
	}
	var existingInfo LockInfo
	if err := json.Unmarshal([]byte(existing), &existingInfo); err != nil {
		return nil, fmt.Errorf("workspace_locked")
	}

	if existingInfo.DeviceID == deviceID {
		database.RDB.Expire(ctx, key, 45*time.Second)
		return &info, nil
	}

	return &existingInfo, fmt.Errorf("workspace_locked")
}

// lockRefreshResult distinguishes between lock states for heartbeat handling.
type lockRefreshResult int

const (
	lockOK      lockRefreshResult = iota
	lockExpired                   // key doesn't exist (TTL expired)
	lockStolen                    // lock exists but belongs to another device
)

// refreshLock renews the TTL if we still own the lock.
func (h *SyncHandler) refreshLock(ctx context.Context, sessionID, deviceID string) lockRefreshResult {
	key := lockKey(sessionID)
	existing, err := database.RDB.Get(ctx, key).Result()
	if err != nil {
		return lockExpired
	}
	var info LockInfo
	if err := json.Unmarshal([]byte(existing), &info); err != nil {
		return lockExpired
	}
	if info.DeviceID != deviceID {
		return lockStolen
	}
	database.RDB.Expire(ctx, key, 45*time.Second)
	return lockOK
}

// releaseLock atomically deletes the lock only if we still own it.
func (h *SyncHandler) releaseLock(ctx context.Context, sessionID, deviceID string) {
	key := lockKey(sessionID)
	script := `
		local data = redis.call('GET', KEYS[1])
		if data then
			local info = cjson.decode(data)
			if info.device_id == ARGV[1] then
				return redis.call('DEL', KEYS[1])
			end
		end
		return 0
	`
	database.RDB.Eval(ctx, script, []string{key}, deviceID)
}

// forceTakeover unconditionally sets the lock, evicting the previous owner.
func (h *SyncHandler) forceTakeover(ctx context.Context, sessionID, userID, deviceID, deviceType string) *LockInfo {
	key := lockKey(sessionID)
	info := LockInfo{
		DeviceID:    deviceID,
		DeviceType:  deviceType,
		UserID:      userID,
		ConnectedAt: time.Now().UTC().Format(time.RFC3339),
	}
	data, _ := json.Marshal(info)
	database.RDB.Set(ctx, key, string(data), 45*time.Second)
	return &info
}

// GetLockInfo reads the current lock for a workspace session. Returns nil if unlocked.
func GetLockInfo(ctx context.Context, sessionID string) *LockInfo {
	if database.RDB == nil {
		return nil
	}
	data, err := database.RDB.Get(ctx, lockKey(sessionID)).Result()
	if err != nil {
		return nil
	}
	var info LockInfo
	if err := json.Unmarshal([]byte(data), &info); err != nil {
		return nil
	}
	return &info
}

func (h *SyncHandler) publishLockEvent(userID, eventType, sessionID string, info *LockInfo) {
	if database.RDB == nil {
		return
	}
	event := map[string]interface{}{
		"type":       eventType,
		"session_id": sessionID,
	}
	if info != nil {
		event["locked_by"] = info
	}
	data, _ := json.Marshal(event)
	log.Printf("[Sync] publishLockEvent: event=%s sessionID=%s channel=ws:user:%s info=%+v", eventType, sessionID, userID, info)
	database.RDB.Publish(context.Background(), "ws:user:"+userID, string(data))
}
