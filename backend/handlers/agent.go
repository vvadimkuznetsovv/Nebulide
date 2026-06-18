package handlers

import (
	"bufio"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"nebulide/config"
	"nebulide/utils"
)

// AgentHandler bridges a browser WebSocket to a Node sidecar running the Claude
// Agent SDK (streaming output + in-app permission prompts + mode control).
type AgentHandler struct {
	cfg      *config.Config
	upgrader websocket.Upgrader
}

func NewAgentHandler(cfg *config.Config) *AgentHandler {
	return &AgentHandler{
		cfg: cfg,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			CheckOrigin:     checkWSOrigin(cfg.AllowedOrigins),
		},
	}
}

// bridgePath returns the path to the agent-bridge entrypoint.
func (h *AgentHandler) bridgePath() string {
	if p := os.Getenv("AGENT_BRIDGE_PATH"); p != "" {
		return p
	}
	return "/app/agent-bridge/index.mjs"
}

// userBaseDir returns the user's workspace root.
func (h *AgentHandler) userBaseDir(username string) string {
	if username != "" && username != h.cfg.AdminUsername {
		return h.cfg.GetUserWorkspaceDir(username)
	}
	return h.cfg.ClaudeWorkingDir
}

// resolveCwd keeps the requested cwd inside the user's allowed roots.
func (h *AgentHandler) resolveCwd(username, requested string) string {
	base := h.userBaseDir(username)
	if requested == "" {
		return base
	}
	clean := filepath.Clean(requested)
	abs, err := filepath.Abs(clean)
	if err != nil {
		return base
	}
	for _, root := range []string{base, h.cfg.ClaudeWorkingDir, h.cfg.WorkspacesRoot, h.cfg.SharedDir} {
		if root == "" {
			continue
		}
		ra, _ := filepath.Abs(root)
		if abs == ra || strings.HasPrefix(abs, ra+string(filepath.Separator)) {
			if _, err := os.Stat(abs); err == nil {
				return abs
			}
		}
	}
	return base
}

func (h *AgentHandler) HandleWebSocket(c *gin.Context) {
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

	cwd := h.resolveCwd(claims.Username, c.Query("cwd"))
	resume := c.Query("resume")
	mode := c.Query("mode")
	if mode == "" {
		mode = "default"
	}

	conn, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("[Agent] upgrade error: %v", err)
		return
	}
	defer conn.Close()

	writeErr := func(msg string) {
		data, _ := json.Marshal(map[string]string{"type": "error", "message": msg})
		conn.WriteMessage(websocket.TextMessage, data)
	}

	cmd := exec.Command("node", h.bridgePath())
	cmd.Dir = cwd
	cmd.Env = os.Environ() // inherits HOME → ~/.claude credentials (shared Claude Code login)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		writeErr("agent stdin: " + err.Error())
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		writeErr("agent stdout: " + err.Error())
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		writeErr("agent stderr: " + err.Error())
		return
	}
	if err := cmd.Start(); err != nil {
		writeErr("agent start: " + err.Error())
		return
	}
	log.Printf("[Agent] sidecar started pid=%d user=%s cwd=%s resume=%s", cmd.Process.Pid, claims.Username, cwd, resume)

	defer func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
		log.Printf("[Agent] sidecar exited user=%s", claims.Username)
	}()

	// Send the init message to start the session.
	initMsg, _ := json.Marshal(map[string]interface{}{
		"type": "init", "cwd": cwd, "resume": resume, "permissionMode": mode,
	})
	if _, err := stdin.Write(append(initMsg, '\n')); err != nil {
		writeErr("agent init: " + err.Error())
		return
	}

	// stderr → log
	go func() {
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 0, 64*1024), 256*1024)
		for sc.Scan() {
			log.Printf("[Agent:stderr] %s", sc.Text())
		}
	}()

	// sidecar stdout → WS (single writer to conn).
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 256*1024), 8*1024*1024)
		for sc.Scan() {
			line := sc.Bytes()
			if len(line) == 0 {
				continue
			}
			if err := conn.WriteMessage(websocket.TextMessage, line); err != nil {
				return
			}
		}
	}()

	// WS → sidecar stdin (forward verbatim: user/permission/set_mode/abort).
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if !json.Valid(raw) {
			continue
		}
		if _, err := stdin.Write(append(raw, '\n')); err != nil {
			break
		}
	}
	_ = stdin.Close()
	<-done
}
