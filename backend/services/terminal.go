package services

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	gopty "github.com/aymanbagabas/go-pty"
)

const scrollbackDir = "/tmp/terminal-scrollback"

// sanitizeKey makes a session key safe for use as a filename.
func sanitizeKey(key string) string {
	r := strings.NewReplacer("/", "_", "\\", "_", ":", "_", " ", "_", "%", "_")
	return r.Replace(key)
}

func scrollbackPath(sessionKey string) string {
	return filepath.Join(scrollbackDir, sanitizeKey(sessionKey)+".buf")
}

// ── multiWriter: broadcasts PTY output to all connected WebSocket clients ──

const replayBufCap = 65536 // 64KB ring buffer for late joiners

type multiWriter struct {
	mu      sync.Mutex
	writers map[io.Writer]io.Closer

	// replayBuf stores the last N bytes of PTY output so that new
	// connections see the current prompt / recent output.
	replayBuf []byte

	// Persistent scrollback: file path and dirty flag for periodic flush.
	filePath string
	dirty    bool
	stopCh   chan struct{}
}

func newMultiWriter(filePath string) *multiWriter {
	os.MkdirAll(scrollbackDir, 0755)

	mw := &multiWriter{
		writers:  make(map[io.Writer]io.Closer),
		filePath: filePath,
		stopCh:   make(chan struct{}),
	}

	// Load existing scrollback from disk (survives container restart)
	if data, err := os.ReadFile(filePath); err == nil && len(data) > 0 {
		if len(data) > replayBufCap {
			data = data[len(data)-replayBufCap:]
		}
		mw.replayBuf = data
		log.Printf("[TerminalService] loaded scrollback %d bytes from %s", len(data), filePath)
	}

	// Periodic flush to disk every 5 seconds
	go mw.flushLoop()

	return mw
}

func (mw *multiWriter) flushLoop() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			mw.flushToDisk()
		case <-mw.stopCh:
			mw.flushToDisk() // final flush
			return
		}
	}
}

func (mw *multiWriter) flushToDisk() {
	mw.mu.Lock()
	if !mw.dirty || len(mw.replayBuf) == 0 {
		mw.mu.Unlock()
		return
	}
	buf := make([]byte, len(mw.replayBuf))
	copy(buf, mw.replayBuf)
	mw.dirty = false
	mw.mu.Unlock()

	if err := os.WriteFile(mw.filePath, buf, 0644); err != nil {
		log.Printf("[TerminalService] scrollback flush error: %v", err)
	}
}

// Write sends data to all connected writers and appends to the replay buffer.
// Dead writers are removed automatically.
func (mw *multiWriter) Write(p []byte) (int, error) {
	mw.mu.Lock()
	defer mw.mu.Unlock()

	// Append to replay buffer (ring: keep last replayBufCap bytes)
	mw.replayBuf = append(mw.replayBuf, p...)
	if len(mw.replayBuf) > replayBufCap {
		mw.replayBuf = mw.replayBuf[len(mw.replayBuf)-replayBufCap:]
	}
	mw.dirty = true

	for w, closer := range mw.writers {
		if _, err := w.Write(p); err != nil {
			closer.Close()
			delete(mw.writers, w)
		}
	}
	return len(p), nil
}

// daQueryRe matches Device Attributes queries (\e[c, \e[0c, \e[>c, etc.)
// that bash/readline sends on startup. If replayed to xterm on reconnect,
// xterm responds with \e[?1;2c which goes to PTY stdin → bash displays "1;2c".
var daQueryRe = regexp.MustCompile(`\x1b\[[\d>]*c`)

// Add registers a new writer. Flushes the replay buffer to it so the client
// sees the current terminal state (prompt, recent output).
func (mw *multiWriter) Add(w io.Writer, closer io.Closer) {
	mw.mu.Lock()
	defer mw.mu.Unlock()

	// Replay recent output to the new connection, stripping DA queries
	// to prevent xterm from auto-responding with \e[?1;2c → "1;2c" in terminal
	if len(mw.replayBuf) > 0 {
		cleaned := daQueryRe.ReplaceAll(mw.replayBuf, nil)
		// Also strip any literal "1;2c" remnants from previous DA responses
		cleaned = bytes.ReplaceAll(cleaned, []byte("1;2c"), nil)
		if len(cleaned) > 0 {
			w.Write(cleaned)
		}
		log.Printf("[TerminalService] replay %d bytes (cleaned %d DA/remnant bytes)", len(mw.replayBuf), len(mw.replayBuf)-len(cleaned))
	}

	mw.writers[w] = closer
}

// Remove unregisters a writer (called when WS disconnects).
func (mw *multiWriter) Remove(w io.Writer) {
	mw.mu.Lock()
	defer mw.mu.Unlock()
	delete(mw.writers, w)
}

// Count returns the number of currently connected writers.
func (mw *multiWriter) Count() int {
	mw.mu.Lock()
	defer mw.mu.Unlock()
	return len(mw.writers)
}

// Stop stops the flush loop and performs a final flush.
func (mw *multiWriter) Stop() {
	select {
	case <-mw.stopCh:
	default:
		close(mw.stopCh)
	}
}

// DeleteFile removes the scrollback file from disk.
func (mw *multiWriter) DeleteFile() {
	os.Remove(mw.filePath)
}

// ── TerminalService ──

type TerminalService struct {
	sessions map[string]*TerminalSession
	mu       sync.RWMutex

	// OnChildExited is called when a claude-* terminal's child process exits
	// (e.g. user pressed Ctrl+C). Parameters: userID, instanceID.
	OnChildExited func(userID, instanceID string)

	// OnChildStarted is called when a claude-* terminal gains a child process
	// (e.g. user ran `claude` command). Parameters: userID, instanceID.
	OnChildStarted func(userID, instanceID string)
}

type TerminalSession struct {
	Pty  gopty.Pty
	Cmd  *gopty.Cmd
	Done chan struct{}

	mw *multiWriter // broadcasts PTY output to all attached WS connections

	// Last known PTY dimensions — used to deduplicate resize calls.
	mu       sync.Mutex
	lastCols uint16
	lastRows uint16

	// Killed is set when admin explicitly kills this session.
	// WS handler checks this to send close code 4001 (prevent frontend reconnect).
	Killed bool

	// OrphanSince tracks when the session last had zero WebSocket writers.
	// Sessions with no writers for >orphanTimeout are reaped.
	// Zero value means at least one writer is connected.
	OrphanSince time.Time
}

func NewTerminalService() *TerminalService {
	ts := &TerminalService{
		sessions: make(map[string]*TerminalSession),
	}
	go ts.reapLoop()
	go ts.childWatchLoop()
	return ts
}

// reapLoop periodically removes dead terminal sessions and logs status.
// Live sessions are NEVER killed — they persist until the shell process exits.
func (s *TerminalService) reapLoop() {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		s.mu.Lock()
		var reaped []string
		var status []string
		for key, sess := range s.sessions {
			if !sess.IsAlive() {
				sess.CloseKeepScrollback()
				delete(s.sessions, key)
				reaped = append(reaped, key)
				status = append(status, fmt.Sprintf("  %s [dead, reaped]", key))
				continue
			}
			// Log status of live sessions
			writers := sess.WriterCount()
			sess.mu.Lock()
			orphanSince := sess.OrphanSince
			sess.mu.Unlock()
			if !orphanSince.IsZero() {
				status = append(status, fmt.Sprintf("  %s [alive, 0 writers, orphaned %v ago]", key, now.Sub(orphanSince).Round(time.Second)))
			} else {
				status = append(status, fmt.Sprintf("  %s [alive, %d writer(s)]", key, writers))
			}
		}
		s.mu.Unlock()
		if len(reaped) > 0 {
			log.Printf("[TerminalService] reaped %d dead sessions: %v", len(reaped), reaped)
		}
		if len(status) > 0 {
			log.Printf("[TerminalService] status: %d sessions\n%s", len(status), strings.Join(status, "\n"))
		}
	}
}

// childWatchLoop checks every 5 seconds if claude-* terminals lost their child
// processes (e.g. user pressed Ctrl+C). When detected, calls OnChildExited
// so the frontend can remove the pet.
func (s *TerminalService) childWatchLoop() {
	prevState := make(map[string]bool) // session key → had children last check
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		s.mu.RLock()
		for key, sess := range s.sessions {
			if !strings.Contains(key, "claude-") || !sess.IsAlive() {
				continue
			}
			hasChildren := sess.HasChildProcesses()
			had := prevState[key]
			if had && !hasChildren && s.OnChildExited != nil {
				uid, iid := parseSessionKey(key)
				log.Printf("[TerminalService] child exited: key=%s uid=%s iid=%s", key, uid, iid)
				go s.OnChildExited(uid, iid)
			}
			if !had && hasChildren && s.OnChildStarted != nil {
				uid, iid := parseSessionKey(key)
				log.Printf("[TerminalService] child started: key=%s uid=%s iid=%s", key, uid, iid)
				go s.OnChildStarted(uid, iid)
			}
			prevState[key] = hasChildren
		}
		// Cleanup stale entries for removed sessions
		for key := range prevState {
			if _, exists := s.sessions[key]; !exists {
				delete(prevState, key)
			}
		}
		s.mu.RUnlock()
	}
}

func defaultShell() string {
	if runtime.GOOS == "windows" {
		// On Windows, ignore $SHELL — it's set by Git Bash/MINGW to a Unix-style
		// path (e.g. /usr/bin/bash) that ConPTY cannot execute.
		// Must resolve absolute path — go-pty resolves relative to cmd.Dir on Windows.
		if ps, err := exec.LookPath("pwsh.exe"); err == nil {
			return ps
		}
		if ps, err := exec.LookPath("powershell.exe"); err == nil {
			return ps
		}
		return "powershell.exe"
	}
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	// Try bash first, then ash (Alpine default), then sh
	for _, sh := range []string{"bash", "ash", "sh"} {
		if p, err := exec.LookPath(sh); err == nil {
			return p
		}
	}
	return "/bin/sh"
}

// GetOrCreate returns an existing alive session or creates a new one.
// If sandboxed is true (Linux only), the shell runs in an isolated mount namespace
// where other users' workspaces are hidden behind tmpfs.
func (s *TerminalService) GetOrCreate(sessionKey string, workingDir string, sandboxed bool, username string, extraEnv map[string]string) (*TerminalSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	log.Printf("[TerminalService] GetOrCreate key=%s totalSessions=%d", sessionKey, len(s.sessions))

	// Reuse existing session if shell is still running
	if existing, ok := s.sessions[sessionKey]; ok {
		alive := existing.IsAlive()
		log.Printf("[TerminalService] found existing session key=%s alive=%v", sessionKey, alive)
		if alive {
			return existing, nil
		}
		// Shell is dead — clean up but keep scrollback for replay into new session.
		log.Printf("[TerminalService] dead session, recreating key=%s", sessionKey)
		existing.CloseKeepScrollback()
		delete(s.sessions, sessionKey)
	} else {
		// No in-memory session — scrollback file may exist from a previous
		// container. Keep it so terminal output survives deploys/restarts.
		// DA queries stripped in multiWriter.Add() prevent 1;2c on replay.
		log.Printf("[TerminalService] no existing session, creating new key=%s", sessionKey)
	}

	return s.createLocked(sessionKey, workingDir, sandboxed, username, extraEnv)
}

// Create always creates a new session, closing any existing one.
func (s *TerminalService) Create(sessionKey string, workingDir string, sandboxed bool, username string, extraEnv map[string]string) (*TerminalSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if existing, ok := s.sessions[sessionKey]; ok {
		existing.CloseKeepScrollback()
		delete(s.sessions, sessionKey)
	}

	return s.createLocked(sessionKey, workingDir, sandboxed, username, extraEnv)
}

func (s *TerminalService) createLocked(sessionKey string, workingDir string, sandboxed bool, username string, extraEnv map[string]string) (*TerminalSession, error) {
	shell := defaultShell()
	log.Printf("[TerminalService] createLocked shell=%s dir=%s sandboxed=%v user=%s key=%s", shell, workingDir, sandboxed, username, sessionKey)

	// Verify working directory exists, fall back to /tmp
	if _, err := os.Stat(workingDir); err != nil {
		log.Printf("Terminal: dir %s not found, fallback /tmp", workingDir)
		workingDir = os.TempDir()
	}

	p, err := gopty.New()
	if err != nil {
		return nil, err
	}

	// On Linux with sandboxing, use sandboxed-shell wrapper that creates an
	// isolated mount namespace hiding other users' workspaces.
	var cmd *gopty.Cmd
	if sandboxed && runtime.GOOS == "linux" {
		sandboxScript := "/usr/local/bin/sandboxed-shell"
		if _, err := os.Stat(sandboxScript); err == nil {
			log.Printf("[TerminalService] using sandboxed shell for user=%s key=%s", username, sessionKey)
			cmd = p.Command(sandboxScript, workingDir, username)
			cmd.Dir = workingDir
		} else {
			log.Printf("[TerminalService] sandboxed-shell not found, falling back to direct shell key=%s", sessionKey)
			cmd = p.Command(shell)
			cmd.Dir = workingDir
		}
	} else {
		cmd = p.Command(shell)
		cmd.Dir = workingDir
	}

	// Build environment: ensure critical vars exist for shell init
	env := os.Environ()
	has := make(map[string]bool)
	for _, e := range env {
		if i := strings.IndexByte(e, '='); i > 0 {
			has[e[:i]] = true
		}
	}
	if !has["HOME"] {
		env = append(env, "HOME="+workingDir)
	}
	if !has["USER"] {
		env = append(env, "USER=root")
	}
	if !has["SHELL"] {
		env = append(env, "SHELL="+shell)
	}
	if !has["PATH"] {
		env = append(env, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	}
	env = append(env, "TERM=xterm-256color", "COLORTERM=truecolor")

	// Per-user bash history: persists across deploys in workspace directory.
	// All terminals of the same user share one history file.
	histFile := filepath.Join(workingDir, ".nebulide_history")
	env = append(env, "HISTFILE="+histFile, "HISTSIZE=10000", "HISTFILESIZE=20000")
	// Flush history after every command so arrow-up works across sessions/reconnects.
	// PROMPT_COMMAND runs after each interactive command in bash.
	env = append(env, "PROMPT_COMMAND=history -a; history -r")

	for k, v := range extraEnv {
		env = append(env, k+"="+v)
	}
	cmd.Env = env

	if err := cmd.Start(); err != nil {
		p.Close()
		log.Printf("[TerminalService] cmd.Start failed: %v key=%s", err, sessionKey)
		return nil, err
	}

	session := &TerminalSession{
		Pty:         p,
		Cmd:         cmd,
		Done:        make(chan struct{}),
		mw:          newMultiWriter(scrollbackPath(sessionKey)),
		OrphanSince: time.Now(), // starts orphaned until a WebSocket connects
	}

	log.Printf("[TerminalService] shell started pid=%d key=%s", cmd.Process.Pid, sessionKey)

	// Single persistent PTY reader — survives WS reconnections.
	// Writes to multiWriter which broadcasts to all attached clients.
	go session.pumpOutput(sessionKey)

	// Monitor process exit
	go func() {
		if err := cmd.Wait(); err != nil {
			log.Printf("[TerminalService] shell exited with error: %v (key=%s)", err, sessionKey)
		} else {
			log.Printf("[TerminalService] shell exited normally (key=%s)", sessionKey)
		}
		// Close PTY to unblock pumpOutput's Read()
		p.Close()
	}()

	s.sessions[sessionKey] = session
	log.Printf("[TerminalService] session stored key=%s totalSessions=%d", sessionKey, len(s.sessions))
	return session, nil
}

// pumpOutput is the single goroutine that reads PTY output and broadcasts it
// to all attached writers via multiWriter. It runs for the entire lifetime of
// the shell process.
func (ts *TerminalSession) pumpOutput(sessionKey string) {
	log.Printf("[TerminalService] pumpOutput START key=%s", sessionKey)
	buf := make([]byte, 4096)
	for {
		n, err := ts.Pty.Read(buf)
		if err != nil {
			if err != io.EOF {
				log.Printf("[TerminalService] pumpOutput PTY read error: %v key=%s", err, sessionKey)
			}
			break
		}
		// Broadcast to all connected WebSocket clients (and buffer in replayBuf)
		ts.mw.Write(buf[:n])
	}
	log.Printf("[TerminalService] pumpOutput STOP key=%s", sessionKey)
	close(ts.Done)
}

func (s *TerminalService) Get(sessionKey string) (*TerminalSession, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	session, ok := s.sessions[sessionKey]
	return session, ok
}

func (s *TerminalService) Remove(sessionKey string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if session, ok := s.sessions[sessionKey]; ok {
		session.Close()
		delete(s.sessions, sessionKey)
	}
}

func (s *TerminalService) Resize(sessionKey string, rows, cols uint16) error {
	// Reject invalid dimensions — FitAddon can propose 0×0 or tiny values
	// during panel transitions / hide, which causes garbled prompt output.
	if rows < 2 || cols < 2 {
		log.Printf("[TerminalService] Resize IGNORED invalid dims rows=%d cols=%d key=%s", rows, cols, sessionKey)
		return nil
	}

	s.mu.RLock()
	session, ok := s.sessions[sessionKey]
	s.mu.RUnlock()

	if !ok {
		return nil
	}

	// Deduplicate: skip if dimensions haven't changed (avoids shell re-rendering prompt)
	session.mu.Lock()
	if session.lastCols == cols && session.lastRows == rows {
		session.mu.Unlock()
		return nil
	}
	session.lastCols = cols
	session.lastRows = rows
	session.mu.Unlock()

	return session.Pty.Resize(int(cols), int(rows))
}

// HasChildProcesses returns true if the shell has child processes running
// (e.g. claude CLI). Uses platform-specific /proc check on Linux.
func (ts *TerminalSession) HasChildProcesses() bool {
	if ts.Cmd == nil || ts.Cmd.Process == nil {
		return false
	}
	return hasChildProcesses(ts.Cmd.Process.Pid)
}

// IsAlive returns true if the shell process is still running.
func (ts *TerminalSession) IsAlive() bool {
	select {
	case <-ts.Done:
		return false
	default:
		return true
	}
}

// AddWriter registers a new WS connection to receive PTY output.
// The replay buffer is flushed to the new writer so it sees current terminal state.
func (ts *TerminalSession) AddWriter(w io.Writer, closer io.Closer) {
	log.Printf("[TerminalService] AddWriter: registering %p", w)
	ts.mw.Add(w, closer)
	// Clear orphan timer — a client is connected
	ts.mu.Lock()
	ts.OrphanSince = time.Time{}
	ts.mu.Unlock()
}

// RemoveWriter unregisters a WS connection (called on disconnect).
func (ts *TerminalSession) RemoveWriter(w io.Writer) {
	log.Printf("[TerminalService] RemoveWriter: removing %p", w)
	ts.mw.Remove(w)
	// If no writers left, start orphan timer
	if ts.mw.Count() == 0 {
		ts.mu.Lock()
		ts.OrphanSince = time.Now()
		ts.mu.Unlock()
		log.Printf("[TerminalService] session orphaned (0 writers)")
	}
}

// WriterCount returns the number of active WebSocket connections to this session.
func (ts *TerminalSession) WriterCount() int {
	return ts.mw.Count()
}

// Close terminates the session and deletes its scrollback file.
// Used when user explicitly closes a terminal.
func (ts *TerminalSession) Close() {
	ts.mw.Stop()
	ts.mw.DeleteFile()
	ts.killProcessTree()
}

// killProcessTree kills the shell and all its child processes.
// Platform-specific: see terminal_kill_unix.go / terminal_kill_windows.go.
func (ts *TerminalSession) killProcessTree() {
	if ts.Cmd != nil && ts.Cmd.Process != nil {
		killProcessGroup(ts.Cmd.Process.Pid)
	}
	if ts.Pty != nil {
		ts.Pty.Close()
	}
}

// CloseKeepScrollback terminates the session but keeps the scrollback file.
// Used when shell dies or container restarts — scrollback survives for replay.
func (ts *TerminalSession) CloseKeepScrollback() {
	ts.mw.Stop()
	if ts.Cmd != nil && ts.Cmd.Process != nil {
		killProcessGroup(ts.Cmd.Process.Pid)
	}
	if ts.Pty != nil {
		ts.Pty.Close()
	}
}

// ── Admin management methods ──

// SessionInfo holds metadata about a terminal session for admin listing.
type SessionInfo struct {
	Key         string `json:"session_key"`
	UserID      string `json:"user_id"`
	InstanceID  string `json:"instance_id"`
	Alive       bool   `json:"alive"`
	HasChildren bool   `json:"has_children"` // shell has child processes (e.g. claude running inside)
}

// parseSessionKey splits "term:{userID}:{instanceId}" into parts.
func parseSessionKey(key string) (userID, instanceID string) {
	parts := strings.SplitN(key, ":", 3)
	if len(parts) == 3 {
		return parts[1], parts[2]
	}
	return "", ""
}

// ListSessions returns info about all active terminal sessions.
// Dead sessions are auto-reaped before returning.
func (s *TerminalService) ListSessions() []SessionInfo {
	s.mu.Lock()
	for key, sess := range s.sessions {
		if !sess.IsAlive() {
			sess.Close()
			delete(s.sessions, key)
		}
	}
	s.mu.Unlock()

	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]SessionInfo, 0, len(s.sessions))
	for key, sess := range s.sessions {
		uid, iid := parseSessionKey(key)
		result = append(result, SessionInfo{
			Key:        key,
			UserID:     uid,
			InstanceID: iid,
			Alive:      sess.IsAlive(),
		})
	}
	return result
}

// ListUserSessions returns terminal sessions for a specific user.
func (s *TerminalService) ListUserSessions(userID string) []SessionInfo {
	prefix := "term:" + userID + ":"
	s.mu.RLock()
	defer s.mu.RUnlock()
	var result []SessionInfo
	for key, sess := range s.sessions {
		if strings.HasPrefix(key, prefix) {
			_, iid := parseSessionKey(key)
			result = append(result, SessionInfo{
				Key:         key,
				UserID:      userID,
				InstanceID:  iid,
				Alive:       sess.IsAlive(),
				HasChildren: sess.HasChildProcesses(),
			})
		}
	}
	return result
}

// KillSessionsByPrefix terminates all sessions whose key starts with prefix.
// Returns the number of killed sessions.
func (s *TerminalService) KillSessionsByPrefix(prefix string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for key, sess := range s.sessions {
		if strings.HasPrefix(key, prefix) {
			sess.Close()
			delete(s.sessions, key)
			count++
		}
	}
	return count
}

// AdminKillSessionsByPrefix is like KillSessionsByPrefix but sets the Killed flag
// so WS handlers send close code 4001 (prevents frontend auto-reconnect).
// Sessions with active WebSocket writers (browser open) are skipped.
// Returns (killed count, blocked count).
func (s *TerminalService) AdminKillSessionsByPrefix(prefix string) (int, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	killed, blocked := 0, 0
	for key, sess := range s.sessions {
		if strings.HasPrefix(key, prefix) {
			if sess.WriterCount() > 0 {
				blocked++
				continue
			}
			sess.Killed = true
			sess.Close()
			delete(s.sessions, key)
			killed++
		}
	}
	return killed, blocked
}

// KillSession terminates a specific terminal session by key.
func (s *TerminalService) KillSession(sessionKey string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[sessionKey]
	if !ok {
		return false
	}
	session.Close()
	delete(s.sessions, sessionKey)
	return true
}

// KillUserSessions terminates all terminal sessions for a user.
func (s *TerminalService) KillUserSessions(userID string) int {
	prefix := "term:" + userID + ":"
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for key, sess := range s.sessions {
		if strings.HasPrefix(key, prefix) {
			sess.Close()
			delete(s.sessions, key)
			count++
		}
	}
	return count
}

// CountUserSessions returns the number of active sessions for a user.
func (s *TerminalService) CountUserSessions(userID string) int {
	prefix := "term:" + userID + ":"
	s.mu.RLock()
	defer s.mu.RUnlock()
	count := 0
	for key, sess := range s.sessions {
		if strings.HasPrefix(key, prefix) && sess.IsAlive() {
			count++
		}
	}
	return count
}

// SessionProcessInfo holds PID + session metadata for monitoring.
type SessionProcessInfo struct {
	Key         string `json:"session_key"`
	UserID      string `json:"user_id"`
	InstanceID  string `json:"instance_id"`
	Alive       bool   `json:"alive"`
	PID         int    `json:"pid"`
	WriterCount int    `json:"writer_count"`
	HasChildren bool   `json:"has_children"`
}

// ListSessionsWithPID returns all sessions with their process PIDs.
// Does NOT reap dead sessions — reapLoop handles that separately.
func (s *TerminalService) ListSessionsWithPID() []SessionProcessInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]SessionProcessInfo, 0, len(s.sessions))
	for key, sess := range s.sessions {
		uid, iid := parseSessionKey(key)
		pid := 0
		if sess.Cmd != nil && sess.Cmd.Process != nil {
			pid = sess.Cmd.Process.Pid
		}
		result = append(result, SessionProcessInfo{
			Key:         key,
			UserID:      uid,
			InstanceID:  iid,
			Alive:       sess.IsAlive(),
			PID:         pid,
			WriterCount: sess.WriterCount(),
			HasChildren: sess.HasChildProcesses(),
		})
	}
	return result
}
