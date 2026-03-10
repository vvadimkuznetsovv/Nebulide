package services

import "sync"

// PresenceService tracks which users have active browser connections
// (via sync WebSocket). Used to determine terminal status in admin panel.
type PresenceService struct {
	mu    sync.RWMutex
	conns map[string]int // userID → active sync WS connection count
}

func NewPresenceService() *PresenceService {
	return &PresenceService{conns: make(map[string]int)}
}

// Connect increments the connection count for a user.
// Called when a sync WebSocket connects.
func (p *PresenceService) Connect(userID string) {
	p.mu.Lock()
	p.conns[userID]++
	p.mu.Unlock()
}

// Disconnect decrements the connection count for a user.
// Called when a sync WebSocket disconnects.
func (p *PresenceService) Disconnect(userID string) {
	p.mu.Lock()
	p.conns[userID]--
	if p.conns[userID] <= 0 {
		delete(p.conns, userID)
	}
	p.mu.Unlock()
}

// IsOnline returns true if the user has at least one active browser connection.
func (p *PresenceService) IsOnline(userID string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.conns[userID] > 0
}
