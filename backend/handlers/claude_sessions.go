package handlers

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"nebulide/config"
)

type ClaudeSessionsHandler struct {
	cfg *config.Config
}

func NewClaudeSessionsHandler(cfg *config.Config) *ClaudeSessionsHandler {
	return &ClaudeSessionsHandler{cfg: cfg}
}

// claudeDir returns the .claude directory path for the current user.
func (h *ClaudeSessionsHandler) claudeDir(c *gin.Context) string {
	// Terminal sets HOME=workingDir; Claude stores sessions under $HOME/.claude
	// On Docker the process HOME is typically /root or /home/nebulide
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		// Fallback to workspace parent
		home = filepath.Dir(h.cfg.ClaudeWorkingDir)
	}

	// Per-user: check if user has their own workspace with .claude inside
	username, _ := c.Get("username")
	if u, ok := username.(string); ok && u != "" && u != h.cfg.AdminUsername {
		userDir := h.cfg.GetUserWorkspaceDir(u)
		candidate := filepath.Join(userDir, ".claude")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		return "" // non-admin without .claude dir — no sessions to show
	}

	return filepath.Join(home, ".claude")
}

var slugRe = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// --- JSONL metadata extraction ---

type jsonlMeta struct {
	SessionID string `json:"sessionId"`
	Slug      string `json:"slug"`
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	CWD       string `json:"cwd"`
	Message   *struct {
		Role    string `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message,omitempty"`
}

func extractFirstMessage(meta jsonlMeta) string {
	if meta.Message == nil || meta.Message.Role != "user" {
		return ""
	}
	// Content can be a string or array of content blocks
	var s string
	if err := json.Unmarshal(meta.Message.Content, &s); err == nil {
		if len(s) > 200 {
			s = s[:200]
		}
		return s
	}
	// Try array of blocks: [{"type":"text","text":"..."}]
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(meta.Message.Content, &blocks); err == nil {
		for _, b := range blocks {
			if b.Type == "text" && b.Text != "" {
				t := b.Text
				if len(t) > 200 {
					t = t[:200]
				}
				return t
			}
		}
	}
	return ""
}

type sessionInfo struct {
	SessionID    string  `json:"session_id"`
	Slug         string  `json:"slug"`
	CWD          string  `json:"cwd"`
	CreatedAt    string  `json:"created_at"`
	UpdatedAt    string  `json:"updated_at"`
	SizeMB       float64 `json:"size_mb"`
	FirstMessage string  `json:"first_message"`
}

type projectInfo struct {
	Slug     string        `json:"slug"`
	Sessions []sessionInfo `json:"sessions"`
}

// List returns all Claude CLI sessions grouped by project.
func (h *ClaudeSessionsHandler) List(c *gin.Context) {
	claudeBase := h.claudeDir(c)
	if claudeBase == "" {
		c.JSON(http.StatusOK, gin.H{"projects": []interface{}{}})
		return
	}
	projectsDir := filepath.Join(claudeBase, "projects")

	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"projects": []interface{}{}})
		return
	}

	var projects []projectInfo

	for _, projEntry := range entries {
		if !projEntry.IsDir() {
			continue
		}
		projPath := filepath.Join(projectsDir, projEntry.Name())
		files, err := os.ReadDir(projPath)
		if err != nil {
			continue
		}

		var sessions []sessionInfo
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}

			fullPath := filepath.Join(projPath, f.Name())
			fi, err := os.Stat(fullPath)
			if err != nil {
				continue
			}

			si := sessionInfo{
				SessionID: strings.TrimSuffix(f.Name(), ".jsonl"),
				SizeMB:    float64(fi.Size()) / (1024 * 1024),
				UpdatedAt: fi.ModTime().UTC().Format(time.RFC3339),
			}

			// Read first 30 lines to extract metadata
			func() {
				file, err := os.Open(fullPath)
				if err != nil {
					return
				}
				defer file.Close()

				scanner := bufio.NewScanner(file)
				scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)
				lineCount := 0
				foundFirstMsg := false

				for scanner.Scan() && lineCount < 30 {
					lineCount++
					line := scanner.Text()
					if line == "" {
						continue
					}

					var meta jsonlMeta
					if err := json.Unmarshal([]byte(line), &meta); err != nil {
						continue
					}

					if meta.SessionID != "" && si.SessionID == strings.TrimSuffix(f.Name(), ".jsonl") {
						// Keep the file-based session ID but capture metadata
						if meta.Slug != "" {
							si.Slug = meta.Slug
						}
						if meta.CWD != "" {
							si.CWD = meta.CWD
						}
						if meta.Timestamp != "" && si.CreatedAt == "" {
							si.CreatedAt = meta.Timestamp
						}
					}

					if !foundFirstMsg && meta.Type == "user" {
						msg := extractFirstMessage(meta)
						if msg != "" {
							si.FirstMessage = msg
							foundFirstMsg = true
						}
					}
				}
			}()

			if si.CreatedAt == "" {
				si.CreatedAt = si.UpdatedAt
			}

			sessions = append(sessions, si)
		}

		if len(sessions) == 0 {
			continue
		}

		// Sort sessions by updated_at descending
		sort.Slice(sessions, func(i, j int) bool {
			return sessions[i].UpdatedAt > sessions[j].UpdatedAt
		})

		projects = append(projects, projectInfo{
			Slug:     projEntry.Name(),
			Sessions: sessions,
		})
	}

	// Sort projects by most recent session
	sort.Slice(projects, func(i, j int) bool {
		if len(projects[i].Sessions) == 0 {
			return false
		}
		if len(projects[j].Sessions) == 0 {
			return true
		}
		return projects[i].Sessions[0].UpdatedAt > projects[j].Sessions[0].UpdatedAt
	})

	c.JSON(http.StatusOK, gin.H{"projects": projects})
}

// --- Plans ---

type planInfo struct {
	Slug      string `json:"slug"`
	Title     string `json:"title"`
	UpdatedAt string `json:"updated_at"`
	Size      int64  `json:"size"`
}

func (h *ClaudeSessionsHandler) ListPlans(c *gin.Context) {
	claudeBase := h.claudeDir(c)
	if claudeBase == "" {
		c.JSON(http.StatusOK, gin.H{"plans": []interface{}{}})
		return
	}
	plansDir := filepath.Join(claudeBase, "plans")

	entries, err := os.ReadDir(plansDir)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"plans": []interface{}{}})
		return
	}

	var plans []planInfo

	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}

		slug := strings.TrimSuffix(e.Name(), ".md")
		fullPath := filepath.Join(plansDir, e.Name())

		fi, err := os.Stat(fullPath)
		if err != nil {
			continue
		}

		title := slug
		// Read first few lines to extract title (# heading)
		func() {
			f, err := os.Open(fullPath)
			if err != nil {
				return
			}
			defer f.Close()

			scanner := bufio.NewScanner(f)
			for i := 0; i < 5 && scanner.Scan(); i++ {
				line := strings.TrimSpace(scanner.Text())
				if strings.HasPrefix(line, "# ") {
					title = strings.TrimPrefix(line, "# ")
					return
				}
			}
		}()

		plans = append(plans, planInfo{
			Slug:      slug,
			Title:     title,
			UpdatedAt: fi.ModTime().UTC().Format(time.RFC3339),
			Size:      fi.Size(),
		})
	}

	sort.Slice(plans, func(i, j int) bool {
		return plans[i].UpdatedAt > plans[j].UpdatedAt
	})

	c.JSON(http.StatusOK, gin.H{"plans": plans})
}

func (h *ClaudeSessionsHandler) ReadPlan(c *gin.Context) {
	slug := c.Param("slug")
	if !slugRe.MatchString(slug) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid slug"})
		return
	}

	claudeBase := h.claudeDir(c)
	if claudeBase == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "Plan not found"})
		return
	}
	fullPath := filepath.Join(claudeBase, "plans", slug+".md")

	fi, err := os.Stat(fullPath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Plan not found"})
		return
	}

	if fi.Size() > 1<<20 { // 1MB limit
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "Plan too large"})
		return
	}

	f, err := os.Open(fullPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read plan"})
		return
	}
	defer f.Close()

	content, err := io.ReadAll(f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read plan"})
		return
	}

	// Extract title
	title := slug
	for _, line := range strings.SplitN(string(content), "\n", 5) {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "# ") {
			title = strings.TrimPrefix(line, "# ")
			break
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"slug":    slug,
		"title":   title,
		"content": string(content),
	})
}
