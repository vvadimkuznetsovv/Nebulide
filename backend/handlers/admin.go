package handlers

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"nebulide/config"
	"nebulide/database"
	"nebulide/models"
	"nebulide/services"
)

type AdminHandler struct {
	cfg      *config.Config
	terminal *services.TerminalService
}

func NewAdminHandler(cfg *config.Config, terminal *services.TerminalService) *AdminHandler {
	return &AdminHandler{cfg: cfg, terminal: terminal}
}

// requireAdmin checks if the current user is an admin. Returns false and sends 403 if not.
func requireAdmin(c *gin.Context) bool {
	userID, _ := c.Get("user_id")
	var user models.User
	if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return false
	}
	if !user.IsAdmin {
		c.JSON(http.StatusForbidden, gin.H{"error": "Admin access required"})
		return false
	}
	return true
}

// ── Users ──

type userListItem struct {
	ID               uuid.UUID `json:"id"`
	Username         string    `json:"username"`
	IsAdmin          bool      `json:"is_admin"`
	CreatedAt        string    `json:"created_at"`
	WorkspaceSizeBytes int64   `json:"workspace_size_bytes"`
	ActivePTYCount   int       `json:"active_pty_count"`
}

func (h *AdminHandler) ListUsers(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}

	var users []models.User
	database.DB.Order("created_at ASC").Find(&users)

	items := make([]userListItem, 0, len(users))
	for _, u := range users {
		wsDir := h.userWorkspaceDir(u.Username)
		size := dirSize(wsDir)
		ptyCount := h.terminal.CountUserSessions(u.ID.String())

		items = append(items, userListItem{
			ID:                 u.ID,
			Username:           u.Username,
			IsAdmin:            u.IsAdmin,
			CreatedAt:          u.CreatedAt.Format("2006-01-02 15:04:05"),
			WorkspaceSizeBytes: size,
			ActivePTYCount:     ptyCount,
		})
	}

	c.JSON(http.StatusOK, items)
}

func (h *AdminHandler) GetUser(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}

	id := c.Param("id")
	var user models.User
	if err := database.DB.First(&user, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}

	wsDir := h.userWorkspaceDir(user.Username)
	size := dirSize(wsDir)
	fileCount := dirFileCount(wsDir)
	ptyCount := h.terminal.CountUserSessions(user.ID.String())

	c.JSON(http.StatusOK, gin.H{
		"id":                   user.ID,
		"username":             user.Username,
		"is_admin":             user.IsAdmin,
		"totp_enabled":         user.TOTPEnabled,
		"created_at":           user.CreatedAt.Format("2006-01-02 15:04:05"),
		"workspace_size_bytes": size,
		"workspace_file_count": fileCount,
		"active_pty_count":     ptyCount,
	})
}

func (h *AdminHandler) DeleteUser(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}

	id := c.Param("id")
	var user models.User
	if err := database.DB.First(&user, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}

	if user.IsAdmin {
		c.JSON(http.StatusForbidden, gin.H{"error": "Cannot delete admin user"})
		return
	}

	// Kill all PTY sessions
	h.terminal.KillUserSessions(user.ID.String())

	// Cascade delete from DB
	uid := user.ID
	database.DB.Where("session_id IN (SELECT id FROM chat_sessions WHERE user_id = ?)", uid).Delete(&models.Message{})
	database.DB.Where("user_id = ?", uid).Delete(&models.ChatSession{})
	database.DB.Where("user_id = ?", uid).Delete(&models.WorkspaceSession{})
	database.DB.Where("user_id = ?", uid).Delete(&models.RefreshToken{})
	database.DB.Delete(&user)

	// Remove workspace directory
	wsDir := h.userWorkspaceDir(user.Username)
	os.RemoveAll(wsDir)

	c.JSON(http.StatusOK, gin.H{"message": "User deleted", "username": user.Username})
}

// ── Terminals ──

func (h *AdminHandler) ListTerminals(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}

	id := c.Param("id")
	sessions := h.terminal.ListUserSessions(id)
	c.JSON(http.StatusOK, sessions)
}

func (h *AdminHandler) KillTerminal(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}

	userID := c.Param("id")
	instanceID := c.Param("instanceId")
	sessionKey := "term:" + userID + ":" + instanceID

	if h.terminal.KillSession(sessionKey) {
		c.JSON(http.StatusOK, gin.H{"message": "Terminal killed"})
	} else {
		c.JSON(http.StatusNotFound, gin.H{"error": "Terminal session not found"})
	}
}

// ── Workspace ──

func (h *AdminHandler) WorkspaceStats(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}

	id := c.Param("id")
	var user models.User
	if err := database.DB.First(&user, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}

	wsDir := h.userWorkspaceDir(user.Username)
	c.JSON(http.StatusOK, gin.H{
		"path":       wsDir,
		"size_bytes": dirSize(wsDir),
		"file_count": dirFileCount(wsDir),
	})
}

func (h *AdminHandler) DeleteWorkspace(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}

	id := c.Param("id")
	var user models.User
	if err := database.DB.First(&user, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}

	if user.IsAdmin {
		c.JSON(http.StatusForbidden, gin.H{"error": "Cannot delete admin workspace"})
		return
	}

	wsDir := h.userWorkspaceDir(user.Username)

	// Kill PTY sessions first (they use workspace dir)
	h.terminal.KillUserSessions(user.ID.String())

	// Remove contents but keep the directory
	entries, err := os.ReadDir(wsDir)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return
	}
	for _, entry := range entries {
		os.RemoveAll(filepath.Join(wsDir, entry.Name()))
	}

	c.JSON(http.StatusOK, gin.H{"message": "Workspace cleared", "username": user.Username})
}

// ── Stats ──

func (h *AdminHandler) Stats(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}

	var userCount int64
	database.DB.Model(&models.User{}).Count(&userCount)

	var pendingInvites int64
	database.DB.Model(&models.Invite{}).Where("used_by IS NULL").Count(&pendingInvites)

	allSessions := h.terminal.ListSessions()
	activePTY := 0
	for _, s := range allSessions {
		if s.Alive {
			activePTY++
		}
	}

	// Total workspace size
	var totalSize int64
	var users []models.User
	database.DB.Find(&users)
	for _, u := range users {
		totalSize += dirSize(h.userWorkspaceDir(u.Username))
	}

	c.JSON(http.StatusOK, gin.H{
		"total_users":          userCount,
		"total_workspaces_size": totalSize,
		"active_pty_count":     activePTY,
		"invites_pending":      pendingInvites,
	})
}

// ── Monitoring ──

type processInfo struct {
	PID        int     `json:"pid"`
	Username   string  `json:"username"`
	SessionKey string  `json:"session_key"`
	InstanceID string  `json:"instance_id"`
	Alive      bool    `json:"alive"`
	CPUPercent float64 `json:"cpu_percent"`
	MemoryRSS  int64   `json:"memory_rss_bytes"`
	Command    string  `json:"command"`
}

type monitoringResponse struct {
	System    systemInfo    `json:"system"`
	Processes []processInfo `json:"processes"`
}

type systemInfo struct {
	CPUCount    int     `json:"cpu_count"`
	GoRoutines  int     `json:"goroutines"`
	MemTotal    int64   `json:"mem_total_bytes"`
	MemUsed     int64   `json:"mem_used_bytes"`
	MemPercent  float64 `json:"mem_percent"`
	DiskTotal   int64   `json:"disk_total_bytes"`
	DiskUsed    int64   `json:"disk_used_bytes"`
	DiskPercent float64 `json:"disk_percent"`
}

func (h *AdminHandler) Monitoring(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}

	// Map user_id → username
	var users []models.User
	database.DB.Select("id", "username").Find(&users)
	userMap := make(map[string]string)
	for _, u := range users {
		userMap[u.ID.String()] = u.Username
	}

	// Get all terminal sessions with PIDs
	sessions := h.terminal.ListSessionsWithPID()
	processes := make([]processInfo, 0, len(sessions))

	for _, s := range sessions {
		username := userMap[s.UserID]
		if username == "" {
			username = s.UserID
		}

		pi := processInfo{
			PID:        s.PID,
			Username:   username,
			SessionKey: s.Key,
			InstanceID: s.InstanceID,
			Alive:      s.Alive,
		}

		// Read process stats from /proc on Linux
		if runtime.GOOS == "linux" && s.PID > 0 {
			pi.MemoryRSS, pi.Command = readProcStats(s.PID)
		}

		processes = append(processes, pi)
	}

	// System info
	sys := systemInfo{
		CPUCount:   runtime.NumCPU(),
		GoRoutines: runtime.NumGoroutine(),
	}

	if runtime.GOOS == "linux" {
		sys.MemTotal, sys.MemUsed, sys.MemPercent = readMemInfo()
	}

	c.JSON(http.StatusOK, monitoringResponse{
		System:    sys,
		Processes: processes,
	})
}

// readProcStats reads RSS and command from /proc/{pid}.
func readProcStats(pid int) (rss int64, command string) {
	// RSS from /proc/{pid}/statm (resident pages)
	statm, err := os.ReadFile(fmt.Sprintf("/proc/%d/statm", pid))
	if err == nil {
		fields := strings.Fields(string(statm))
		if len(fields) >= 2 {
			if pages, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
				rss = pages * 4096
			}
		}
	}

	// Command from /proc/{pid}/cmdline
	cmdline, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err == nil {
		command = strings.ReplaceAll(strings.TrimRight(string(cmdline), "\x00"), "\x00", " ")
		if len(command) > 120 {
			command = command[:120] + "..."
		}
	}
	return
}

// readMemInfo reads system memory from /proc/meminfo.
func readMemInfo() (total, used int64, percent float64) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return
	}
	var memTotal, memAvailable int64
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		val, _ := strconv.ParseInt(fields[1], 10, 64)
		val *= 1024 // kB → bytes
		switch fields[0] {
		case "MemTotal:":
			memTotal = val
		case "MemAvailable:":
			memAvailable = val
		}
	}
	total = memTotal
	used = memTotal - memAvailable
	if memTotal > 0 {
		percent = float64(used) / float64(memTotal) * 100
	}
	return
}

// ── Helpers ──

func (h *AdminHandler) userWorkspaceDir(username string) string {
	if username == h.cfg.AdminUsername {
		return h.cfg.ClaudeWorkingDir
	}
	return h.cfg.GetUserWorkspaceDir(username)
}

func dirSize(path string) int64 {
	var size int64
	filepath.Walk(path, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !info.IsDir() {
			size += info.Size()
		}
		return nil
	})
	return size
}

func dirFileCount(path string) int {
	count := 0
	filepath.Walk(path, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !info.IsDir() {
			count++
		}
		return nil
	})
	return count
}
