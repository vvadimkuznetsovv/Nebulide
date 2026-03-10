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

// claudeBaseDir returns the .claude directory (shared for all users in Docker).
func (h *ClaudeSessionsHandler) claudeBaseDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = filepath.Dir(h.cfg.ClaudeWorkingDir)
	}
	return filepath.Join(home, ".claude")
}

// workspaceSlug converts a workspace path to Claude's project slug format.
// /home/nebulide/workspace → -home-nebulide-workspace
func workspaceSlug(wsPath string) string {
	return strings.ReplaceAll(filepath.ToSlash(wsPath), "/", "-")
}

// userWorkspaceSlug returns the slug prefix for the requesting user's workspace.
func (h *ClaudeSessionsHandler) userWorkspaceSlug(c *gin.Context) string {
	username, _ := c.Get("username")
	u, _ := username.(string)
	if u != "" && u != h.cfg.AdminUsername {
		return workspaceSlug(h.cfg.GetUserWorkspaceDir(u))
	}
	return workspaceSlug(h.cfg.ClaudeWorkingDir)
}

// matchesWorkspace checks if a project slug belongs to the given workspace.
func matchesWorkspace(projectSlug, wsSlug string) bool {
	return projectSlug == wsSlug || strings.HasPrefix(projectSlug, wsSlug+"-")
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
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message,omitempty"`
}

func extractTextContent(meta jsonlMeta) string {
	if meta.Message == nil {
		return ""
	}
	// Content can be a string or array of content blocks
	var s string
	if err := json.Unmarshal(meta.Message.Content, &s); err == nil {
		return s
	}
	// Try array of blocks: [{"type":"text","text":"..."}]
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(meta.Message.Content, &blocks); err == nil {
		var parts []string
		for _, b := range blocks {
			if b.Type == "text" && b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

func truncate(s string, max int) string {
	if len(s) > max {
		return s[:max]
	}
	return s
}

type sessionInfo struct {
	SessionID    string  `json:"session_id"`
	Slug         string  `json:"slug"`
	CWD          string  `json:"cwd"`
	CreatedAt    string  `json:"created_at"`
	UpdatedAt    string  `json:"updated_at"`
	SizeMB       float64 `json:"size_mb"`
	FirstMessage string  `json:"first_message"`
	Project      string  `json:"project"` // project slug (needed for preview)
}

type projectInfo struct {
	Slug     string        `json:"slug"`
	Sessions []sessionInfo `json:"sessions"`
}

// List returns Claude CLI sessions filtered by the requesting user's workspace.
func (h *ClaudeSessionsHandler) List(c *gin.Context) {
	claudeBase := h.claudeBaseDir()
	projectsDir := filepath.Join(claudeBase, "projects")

	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"projects": []interface{}{}})
		return
	}

	wsSlug := h.userWorkspaceSlug(c)

	var projects []projectInfo

	for _, projEntry := range entries {
		if !projEntry.IsDir() {
			continue
		}

		// Filter: only include projects matching user's workspace
		if !matchesWorkspace(projEntry.Name(), wsSlug) {
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
				Project:   projEntry.Name(),
			}

			// Read first 50 lines to extract metadata
			hasConversation := false
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

				for scanner.Scan() && lineCount < 50 {
					lineCount++
					line := scanner.Text()
					if line == "" {
						continue
					}

					var meta jsonlMeta
					if err := json.Unmarshal([]byte(line), &meta); err != nil {
						continue
					}

					// Use internal sessionId (what claude --resume expects)
					if meta.SessionID != "" && si.SessionID == strings.TrimSuffix(f.Name(), ".jsonl") {
						si.SessionID = meta.SessionID
					}

					if meta.Slug != "" {
						si.Slug = meta.Slug
					}
					if meta.CWD != "" {
						si.CWD = meta.CWD
					}
					if meta.Timestamp != "" && si.CreatedAt == "" {
						si.CreatedAt = meta.Timestamp
					}

					if meta.Type == "user" {
						hasConversation = true
						if !foundFirstMsg {
							msg := extractTextContent(meta)
							if msg != "" {
								si.FirstMessage = truncate(msg, 200)
								foundFirstMsg = true
							}
						}
					}
				}
			}()

			// Skip files that have no conversation (e.g. file-history-snapshot only)
			if !hasConversation {
				continue
			}

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

// --- Session Search ---

type searchResult struct {
	SessionID    string  `json:"session_id"`
	Project      string  `json:"project"`
	Slug         string  `json:"slug"`
	UpdatedAt    string  `json:"updated_at"`
	SizeMB       float64 `json:"size_mb"`
	Snippet      string  `json:"snippet"`
	FirstMessage string  `json:"first_message"`
	CWD          string  `json:"cwd"`
}

// SearchSessions performs full-text search across all session conversations.
func (h *ClaudeSessionsHandler) SearchSessions(c *gin.Context) {
	query := strings.TrimSpace(c.Query("q"))
	if query == "" || len(query) < 2 {
		c.JSON(http.StatusOK, gin.H{"results": []interface{}{}})
		return
	}
	qLower := strings.ToLower(query)

	claudeBase := h.claudeBaseDir()
	projectsDir := filepath.Join(claudeBase, "projects")

	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"results": []interface{}{}})
		return
	}

	wsSlug := h.userWorkspaceSlug(c)
	var results []searchResult

	for _, projEntry := range entries {
		if !projEntry.IsDir() || !matchesWorkspace(projEntry.Name(), wsSlug) {
			continue
		}

		projPath := filepath.Join(projectsDir, projEntry.Name())
		files, _ := os.ReadDir(projPath)

		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}

			fullPath := filepath.Join(projPath, f.Name())
			fi, err := os.Stat(fullPath)
			if err != nil {
				continue
			}

			// Search through messages
			match := h.searchInSession(fullPath, qLower)
			if match == nil {
				continue
			}

			results = append(results, searchResult{
				SessionID:    match.sessionID,
				Project:      projEntry.Name(),
				Slug:         match.slug,
				UpdatedAt:    fi.ModTime().UTC().Format(time.RFC3339),
				SizeMB:       float64(fi.Size()) / (1024 * 1024),
				Snippet:      match.snippet,
				FirstMessage: match.firstMessage,
				CWD:          match.cwd,
			})

			// Limit results
			if len(results) >= 30 {
				break
			}
		}
		if len(results) >= 30 {
			break
		}
	}

	// Sort by updated_at descending
	sort.Slice(results, func(i, j int) bool {
		return results[i].UpdatedAt > results[j].UpdatedAt
	})

	c.JSON(http.StatusOK, gin.H{"results": results})
}

type searchMatch struct {
	sessionID    string
	slug         string
	snippet      string
	firstMessage string
	cwd          string
}

func (h *ClaudeSessionsHandler) searchInSession(filePath, qLower string) *searchMatch {
	file, err := os.Open(filePath)
	if err != nil {
		return nil
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)

	var sessionID, slug, cwd, firstMessage string
	lineCount := 0

	for scanner.Scan() {
		lineCount++
		line := scanner.Text()
		if line == "" {
			continue
		}

		var meta jsonlMeta
		if err := json.Unmarshal([]byte(line), &meta); err != nil {
			continue
		}

		if meta.SessionID != "" && sessionID == "" {
			sessionID = meta.SessionID
		}
		if meta.Slug != "" && slug == "" {
			slug = meta.Slug
		}
		if meta.CWD != "" && cwd == "" {
			cwd = meta.CWD
		}

		if meta.Type == "user" || meta.Type == "assistant" {
			text := extractTextContent(meta)
			if text == "" {
				continue
			}

			// Capture first user message (like List does)
			if meta.Type == "user" && firstMessage == "" {
				firstMessage = truncate(text, 200)
			}

			textLower := strings.ToLower(text)
			idx := strings.Index(textLower, qLower)
			if idx >= 0 {
				// Build snippet: ~40 chars before match, match, ~60 chars after
				start := idx - 40
				if start < 0 {
					start = 0
				}
				end := idx + len(qLower) + 60
				if end > len(text) {
					end = len(text)
				}
				snippet := ""
				if start > 0 {
					snippet = "..."
				}
				snippet += text[start:end]
				if end < len(text) {
					snippet += "..."
				}

				if sessionID == "" {
					sessionID = strings.TrimSuffix(filepath.Base(filePath), ".jsonl")
				}

				return &searchMatch{
					sessionID:    sessionID,
					slug:         slug,
					snippet:      snippet,
					firstMessage: firstMessage,
					cwd:          cwd,
				}
			}
		}

		// Don't scan more than 2000 lines per file for performance
		if lineCount > 2000 {
			break
		}
	}
	return nil
}

// --- Session Preview ---

type sessionMessage struct {
	Role      string `json:"role"`
	Content   string `json:"content"`
	Timestamp string `json:"timestamp,omitempty"`
}

// ReadSession reads a session JSONL and returns the conversation messages.
func (h *ClaudeSessionsHandler) ReadSession(c *gin.Context) {
	project := c.Param("project")
	sessionFile := c.Param("sessionFile")

	if !slugRe.MatchString(project) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid project"})
		return
	}

	// Security: only allow access to user's own workspace projects
	wsSlug := h.userWorkspaceSlug(c)
	if !matchesWorkspace(project, wsSlug) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	claudeBase := h.claudeBaseDir()
	// Find JSONL file — sessionFile could be internal sessionId or filename
	projDir := filepath.Join(claudeBase, "projects", project)

	// Try to find file by internal sessionId (grep through files)
	var fullPath string
	files, err := os.ReadDir(projDir)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Project not found"})
		return
	}

	// First try exact filename match
	candidate := filepath.Join(projDir, sessionFile+".jsonl")
	if _, err := os.Stat(candidate); err == nil {
		fullPath = candidate
	} else {
		// Search by internal sessionId in files
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			fp := filepath.Join(projDir, f.Name())
			file, err := os.Open(fp)
			if err != nil {
				continue
			}
			scanner := bufio.NewScanner(file)
			scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)
			for i := 0; i < 5 && scanner.Scan(); i++ {
				var meta jsonlMeta
				if json.Unmarshal([]byte(scanner.Text()), &meta) == nil && meta.SessionID == sessionFile {
					fullPath = fp
					break
				}
			}
			file.Close()
			if fullPath != "" {
				break
			}
		}
	}

	if fullPath == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	fi, err := os.Stat(fullPath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}
	if fi.Size() > 50<<20 { // 50MB limit
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "Session too large"})
		return
	}

	file, err := os.Open(fullPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read session"})
		return
	}
	defer file.Close()

	var messages []sessionMessage
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20) // 1MB line buffer

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		var meta jsonlMeta
		if err := json.Unmarshal([]byte(line), &meta); err != nil {
			continue
		}

		if meta.Type == "user" || meta.Type == "assistant" {
			text := extractTextContent(meta)
			if text != "" {
				messages = append(messages, sessionMessage{
					Role:      meta.Type,
					Content:   truncate(text, 5000),
					Timestamp: meta.Timestamp,
				})
			}
		}

		// Limit to 100 messages for preview
		if len(messages) >= 100 {
			break
		}
	}

	c.JSON(http.StatusOK, gin.H{"messages": messages})
}

// --- Delete Session ---

// DeleteSession deletes a Claude session JSONL file.
func (h *ClaudeSessionsHandler) DeleteSession(c *gin.Context) {
	project := c.Param("project")
	sessionFile := c.Param("sessionFile")

	if !slugRe.MatchString(project) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid project"})
		return
	}

	// Security: only allow access to user's own workspace projects
	wsSlug := h.userWorkspaceSlug(c)
	if !matchesWorkspace(project, wsSlug) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	claudeBase := h.claudeBaseDir()
	projDir := filepath.Join(claudeBase, "projects", project)

	// Find JSONL file — sessionFile could be internal sessionId or filename UUID
	var fullPath string

	// First try exact filename match
	candidate := filepath.Join(projDir, sessionFile+".jsonl")
	if _, err := os.Stat(candidate); err == nil {
		fullPath = candidate
	} else {
		// Search by internal sessionId in files
		files, err := os.ReadDir(projDir)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Project not found"})
			return
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			fp := filepath.Join(projDir, f.Name())
			file, err := os.Open(fp)
			if err != nil {
				continue
			}
			scanner := bufio.NewScanner(file)
			scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)
			for i := 0; i < 5 && scanner.Scan(); i++ {
				var meta jsonlMeta
				if json.Unmarshal([]byte(scanner.Text()), &meta) == nil && meta.SessionID == sessionFile {
					fullPath = fp
					break
				}
			}
			file.Close()
			if fullPath != "" {
				break
			}
		}
	}

	if fullPath == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	if err := os.Remove(fullPath); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete session"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Session deleted"})
}

// --- Plans ---

type planInfo struct {
	Slug      string `json:"slug"`
	Title     string `json:"title"`
	UpdatedAt string `json:"updated_at"`
	Size      int64  `json:"size"`
}

func (h *ClaudeSessionsHandler) ListPlans(c *gin.Context) {
	claudeBase := h.claudeBaseDir()
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

	claudeBase := h.claudeBaseDir()
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
