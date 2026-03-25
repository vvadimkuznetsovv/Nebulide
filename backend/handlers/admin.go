package handlers

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"os/exec"
	"time"

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
	presence *services.PresenceService
}

func NewAdminHandler(cfg *config.Config, terminal *services.TerminalService, presence *services.PresenceService) *AdminHandler {
	return &AdminHandler{cfg: cfg, terminal: terminal, presence: presence}
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

func (h *AdminHandler) ListUserSessions(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	id := c.Param("id")
	var sessions []models.WorkspaceSession
	database.DB.Where("user_id = ?", id).Order("updated_at DESC").Find(&sessions)
	c.JSON(http.StatusOK, sessions)
}

func (h *AdminHandler) DeleteUserSession(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	userID := c.Param("id")
	sessionID := c.Param("sessionId")
	result := database.DB.Where("id = ? AND user_id = ?", sessionID, userID).Delete(&models.WorkspaceSession{})
	if result.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
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

type terminalDetail struct {
	SessionKey  string  `json:"session_key"`
	InstanceID  string  `json:"instance_id"`
	Alive       bool    `json:"alive"`
	PID         int     `json:"pid"`
	MemoryRSS   int64   `json:"memory_rss_bytes"`
	CPUPercent  float64 `json:"cpu_percent"`
	Command     string  `json:"command"`
	WriterCount int     `json:"writer_count"`
	Status      string  `json:"status"` // "active" | "hidden" | "offline"
}

func (h *AdminHandler) ListTerminals(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}

	id := c.Param("id")
	allSessions := h.terminal.ListSessionsWithPID()
	prefix := "term:" + id + ":"
	var result []terminalDetail
	var pids []int
	for _, s := range allSessions {
		if !strings.HasPrefix(s.Key, prefix) {
			continue
		}
		td := terminalDetail{
			SessionKey:  s.Key,
			InstanceID:  s.InstanceID,
			Alive:       s.Alive,
			PID:         s.PID,
			WriterCount: s.WriterCount,
		}
		if runtime.GOOS == "linux" && s.PID > 0 {
			td.MemoryRSS, td.Command = readProcInfo(s.PID)
			pids = append(pids, s.PID)
		}
		result = append(result, td)
	}
	// Single CPU measurement for all user's terminal processes
	if len(pids) > 0 {
		_, procCPU := measureAllCPU(pids)
		for i := range result {
			if cpu, ok := procCPU[result[i].PID]; ok {
				result[i].CPUPercent = cpu
			}
		}
	}
	// Compute terminal status: active / hidden / offline
	userOnline := h.presence.IsOnline(id)
	for i := range result {
		switch {
		case result[i].WriterCount > 0:
			result[i].Status = "active"
		case userOnline:
			result[i].Status = "hidden"
		default:
			result[i].Status = "offline"
		}
	}
	if result == nil {
		result = []terminalDetail{}
	}
	c.JSON(http.StatusOK, result)
}

func (h *AdminHandler) KillTerminal(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}

	userID := c.Param("id")
	instanceID := c.Param("instanceId")
	force := c.Query("force") == "true"

	if !force {
		if h.presence.IsOnline(userID) {
			c.JSON(http.StatusConflict, gin.H{"error": "User is currently online"})
			return
		}
	}

	prefix := "term:" + userID + ":" + instanceID
	var killed int
	if force {
		killed = h.terminal.KillSessionsByPrefix(prefix)
	} else {
		killed, _ = h.terminal.AdminKillSessionsByPrefix(prefix)
	}
	if killed > 0 {
		c.JSON(http.StatusOK, gin.H{"message": "Terminal killed", "killed": killed})
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
	PID         int     `json:"pid"`
	UserID      string  `json:"user_id"`
	Username    string  `json:"username"`
	SessionKey  string  `json:"session_key"`
	InstanceID  string  `json:"instance_id"`
	Alive       bool    `json:"alive"`
	CPUPercent  float64 `json:"cpu_percent"`
	MemoryRSS   int64   `json:"memory_rss_bytes"`
	Command     string  `json:"command"`
	WriterCount int     `json:"writer_count"`
	Status      string  `json:"status"` // "active", "hidden", "offline"
}

type monitoringResponse struct {
	System    systemInfo    `json:"system"`
	Processes []processInfo `json:"processes"`
}

type systemInfo struct {
	CPUCount    int     `json:"cpu_count"`
	CPUPercent  float64 `json:"cpu_percent"`
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

	// System info (non-CPU)
	cpuCount := runtime.NumCPU()
	if runtime.GOOS == "linux" {
		if n := countCPUCores(); n > 0 {
			cpuCount = n
		}
	}
	sys := systemInfo{
		CPUCount:   cpuCount,
		GoRoutines: runtime.NumGoroutine(),
	}

	// Collect PIDs for CPU measurement
	var pids []int
	for _, s := range sessions {
		if runtime.GOOS == "linux" && s.PID > 0 {
			pids = append(pids, s.PID)
		}
	}

	// Single 500ms measurement window for ALL CPU (system + per-process)
	var procCPU map[int]float64
	if runtime.GOOS == "linux" {
		sys.CPUPercent, procCPU = measureAllCPU(pids)
		sys.MemTotal, sys.MemUsed, sys.MemPercent = readMemInfo()
		sys.DiskTotal, sys.DiskUsed, sys.DiskPercent = readDiskInfo("/")
	}

	// Build process list
	processes := make([]processInfo, 0, len(sessions))
	for _, s := range sessions {
		username := userMap[s.UserID]
		if username == "" {
			username = s.UserID
		}
		status := "offline"
		if s.WriterCount > 0 {
			status = "active"
		} else if s.Alive {
			status = "hidden"
		}
		pi := processInfo{
			PID:         s.PID,
			UserID:      s.UserID,
			Username:    username,
			SessionKey:  s.Key,
			InstanceID:  s.InstanceID,
			Alive:       s.Alive,
			WriterCount: s.WriterCount,
			Status:      status,
		}
		if runtime.GOOS == "linux" && s.PID > 0 {
			pi.MemoryRSS, pi.Command = readProcInfo(s.PID)
			pi.CPUPercent = procCPU[s.PID]
		}
		processes = append(processes, pi)
	}

	c.JSON(http.StatusOK, monitoringResponse{
		System:    sys,
		Processes: processes,
	})
}

// KillProcess kills a process by PID (admin only, force kill).
func (h *AdminHandler) KillProcess(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	pidStr := c.Param("pid")
	pid, err := strconv.Atoi(pidStr)
	if err != nil || pid <= 1 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid PID"})
		return
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Process not found"})
		return
	}
	if err := proc.Signal(syscall.SIGKILL); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to kill: %v", err)})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Process killed", "pid": pid})
}

// readProcInfo reads RSS and command from /proc/{pid} (no CPU — handled by measureAllCPU).
func readProcInfo(pid int) (rss int64, command string) {
	statm, err := os.ReadFile(fmt.Sprintf("/proc/%d/statm", pid))
	if err == nil {
		fields := strings.Fields(string(statm))
		if len(fields) >= 2 {
			if pages, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
				rss = pages * 4096
			}
		}
	}
	cmdline, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err == nil {
		command = strings.ReplaceAll(strings.TrimRight(string(cmdline), "\x00"), "\x00", " ")
		if len(command) > 120 {
			command = command[:120] + "..."
		}
	}
	return
}

// measureAllCPU takes a single 500ms snapshot to measure system CPU and per-process CPU simultaneously.
// Returns system CPU% and a map of pid → CPU%.
func measureAllCPU(pids []int) (sysCPU float64, procCPU map[int]float64) {
	procCPU = make(map[int]float64)
	numCPU := float64(runtime.NumCPU())

	// Read system idle/total from /proc/stat
	readSystem := func() (idle, total int64, ok bool) {
		data, err := os.ReadFile("/proc/stat")
		if err != nil {
			return 0, 0, false
		}
		firstLine := strings.SplitN(string(data), "\n", 2)[0]
		fields := strings.Fields(firstLine)
		if len(fields) < 5 {
			return 0, 0, false
		}
		var sum int64
		for _, f := range fields[1:] {
			v, _ := strconv.ParseInt(f, 10, 64)
			sum += v
		}
		idleVal, _ := strconv.ParseInt(fields[4], 10, 64)
		return idleVal, sum, true
	}

	// Read process utime+stime from /proc/{pid}/stat
	readProc := func(pid int) (int64, bool) {
		stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if err != nil {
			return 0, false
		}
		s := string(stat)
		idx := strings.LastIndex(s, ") ")
		if idx < 0 {
			return 0, false
		}
		fields := strings.Fields(s[idx+2:])
		if len(fields) < 13 {
			return 0, false
		}
		utime, _ := strconv.ParseInt(fields[11], 10, 64)
		stime, _ := strconv.ParseInt(fields[12], 10, 64)
		return utime + stime, true
	}

	// Snapshot T1: system + all processes
	idle1, total1, sysOK1 := readSystem()
	procT1 := make(map[int]int64)
	for _, pid := range pids {
		if t, ok := readProc(pid); ok {
			procT1[pid] = t
		}
	}

	time.Sleep(500 * time.Millisecond)

	// Snapshot T2: system + all processes
	idle2, total2, sysOK2 := readSystem()

	// System CPU%
	if sysOK1 && sysOK2 && total2 != total1 {
		sysCPU = (1 - float64(idle2-idle1)/float64(total2-total1)) * 100
	}

	// Per-process CPU%
	sysDelta := float64(total2 - total1)
	if sysDelta > 0 {
		for _, pid := range pids {
			t1, has1 := procT1[pid]
			if !has1 {
				continue
			}
			t2, ok := readProc(pid)
			if !ok {
				continue
			}
			procCPU[pid] = float64(t2-t1) / sysDelta * 100 * numCPU
		}
	}

	return
}

// readDiskInfo reads disk usage via `df` command (works in Docker/Linux).
func readDiskInfo(path string) (total, used int64, percent float64) {
	out, err := exec.Command("df", "-B1", path).Output()
	if err != nil {
		return
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) < 2 {
		return
	}
	fields := strings.Fields(lines[1])
	if len(fields) < 4 {
		return
	}
	total, _ = strconv.ParseInt(fields[1], 10, 64)
	used, _ = strconv.ParseInt(fields[2], 10, 64)
	if total > 0 {
		percent = float64(used) / float64(total) * 100
	}
	return
}

// countCPUCores counts physical CPU cores from /proc/cpuinfo.
func countCPUCores() int {
	data, err := os.ReadFile("/proc/cpuinfo")
	if err != nil {
		return 0
	}
	count := 0
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "processor") {
			count++
		}
	}
	return count
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
