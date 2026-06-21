package handlers

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"nebulide/config"
)

// cachedSession caches the parsed sessionInfo for a JSONL file keyed by path.
// Valid while modTime+size are unchanged (sessions are append-only).
type cachedSession struct {
	modTime time.Time
	size    int64
	skip    bool // file has no conversation — excluded from listing
	info    sessionInfo
}

type ClaudeSessionsHandler struct {
	cfg     *config.Config
	cacheMu sync.RWMutex
	cache   map[string]cachedSession
}

func NewClaudeSessionsHandler(cfg *config.Config) *ClaudeSessionsHandler {
	return &ClaudeSessionsHandler{cfg: cfg, cache: make(map[string]cachedSession)}
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
// Claude Code names its project dirs by replacing EVERY non-alphanumeric char
// with '-' (not just '/'). Example: "/home/nebulide/workspace/.nebulide_chats"
// → "-home-nebulide-workspace--nebulide-chats". The old version replaced only
// '/', so any cwd containing '.', '_', space, etc. mapped to a NON-EXISTENT dir
// → the session JSONL was never found → fallback grabbed another terminal's
// newest session (wrong history). Must match Claude's slugification exactly.
var slugNonAlnumRe = regexp.MustCompile(`[^a-zA-Z0-9]`)

func workspaceSlug(wsPath string) string {
	p := filepath.ToSlash(wsPath)
	// Windows: claude приводит БУКВУ ДИСКА к нижнему регистру в слаге проекта
	// ("C:/Users/..." → "c--Users-..."). Без этого слаг бэкенда ("C--...") не совпадает
	// с реальной папкой claude ("c--...") → JSONL сессии не находится → чат пустой.
	// На Linux пути без буквы диска — ветка не срабатывает, поведение прежнее.
	if len(p) >= 2 && p[1] == ':' {
		p = strings.ToLower(p[:1]) + p[1:]
	}
	return slugNonAlnumRe.ReplaceAllString(p, "-")
}

// slugToPath tries to convert a Claude project slug back to a filesystem path.
// The slug is created by replacing "/" with "-", so we reverse the process.
// Checks if the path exists on disk. Returns empty string if not found.
func slugToPath(slug string) string {
	candidate := strings.ReplaceAll(slug, "-", "/")
	if _, err := os.Stat(candidate); err == nil {
		return candidate
	}
	return ""
}

// deriveResumeCWD determines the correct directory for `claude --resume`.
// Priority: 1) project slug → path (most reliable, matches where claude was invoked)
//           2) cwd from JSONL metadata (fallback)
func deriveResumeCWD(projectSlug, metadataCWD string) string {
	if p := slugToPath(projectSlug); p != "" {
		return p
	}
	return metadataCWD
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
	SessionID   string `json:"sessionId"`
	Slug        string `json:"slug"`
	Type        string `json:"type"`
	Timestamp   string `json:"timestamp"`
	CWD         string `json:"cwd"`
	UUID        string `json:"uuid"`
	ParentUUID  string `json:"parentUuid"`
	IsSidechain bool   `json:"isSidechain"` // true = Task/subagent thread (skip in main view)
	CustomTitle string `json:"customTitle"` // type == "custom-title": user-assigned session/branch name
	Message     *struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message,omitempty"`
}

// extractCustomTitles scans the tail of a JSONL file for custom-title records
// ({"type":"custom-title","customTitle":"...","sessionId":"..."}). Claude CLI
// re-appends them throughout the file, so the tail almost always contains the
// latest one per sessionId; last record wins (renames). Returns sessionId → title.
func extractCustomTitles(fullPath string, fileSize int64) map[string]string {
	const tailSize = 64 * 1024
	file, err := os.Open(fullPath)
	if err != nil {
		return nil
	}
	defer file.Close()

	offset := int64(0)
	if fileSize > tailSize {
		offset = fileSize - tailSize
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return nil
	}

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	if offset > 0 {
		scanner.Scan() // discard partial first line
	}

	var titles map[string]string
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.Contains(line, `"custom-title"`) {
			continue
		}
		var rec struct {
			Type        string `json:"type"`
			CustomTitle string `json:"customTitle"`
			SessionID   string `json:"sessionId"`
		}
		if json.Unmarshal([]byte(line), &rec) != nil || rec.Type != "custom-title" || rec.CustomTitle == "" {
			continue
		}
		if titles == nil {
			titles = map[string]string{}
		}
		titles[rec.SessionID] = rec.CustomTitle
	}
	return titles
}

var cmdNameRe = regexp.MustCompile(`(?s)<command-name>\s*(.*?)\s*</command-name>`)
var cmdArgsRe = regexp.MustCompile(`(?s)<command-args>\s*(.*?)\s*</command-args>`)
var cmdStdoutRe = regexp.MustCompile(`(?s)<local-command-stdout>\s*(.*?)\s*</local-command-stdout>`)

// normalizeSlashCommand сворачивает обёртку слэш-команды из JSONL в человекочитаемый вид.
// Claude пишет команду как <command-name>/x</command-name>…<command-args>y</command-args>,
// её результат — <local-command-stdout>…</local-command-stdout>, плюс служебный
// <local-command-caveat> (инструкция модели). Иначе чат рендерит сырой XML, а оптимистичный
// пузырь («/x y») не сматчивается по тексту и ВИСИТ. Возвращаем «/x y» (+ результат отдельной
// строкой), caveat выкидываем. Обрабатываем и сообщение-только-stdout (без command-name).
func normalizeSlashCommand(s string) string {
	if !strings.Contains(s, "<command-name>") && !strings.Contains(s, "<local-command-stdout>") {
		return s
	}
	cmd := ""
	if m := cmdNameRe.FindStringSubmatch(s); m != nil {
		if name := strings.TrimSpace(m[1]); name != "" {
			if !strings.HasPrefix(name, "/") {
				name = "/" + name
			}
			cmd = name
			if a := cmdArgsRe.FindStringSubmatch(s); a != nil {
				if args := strings.TrimSpace(a[1]); args != "" {
					cmd += " " + args
				}
			}
		}
	}
	out := ""
	if m := cmdStdoutRe.FindStringSubmatch(s); m != nil {
		out = strings.TrimSpace(m[1])
	}
	switch {
	case cmd != "" && out != "":
		return cmd + "\n" + out
	case cmd != "":
		return cmd
	case out != "":
		return out
	}
	return s
}

func extractTextContent(meta jsonlMeta) string {
	if meta.Message == nil {
		return ""
	}
	// Content can be a string or array of content blocks
	var s string
	if err := json.Unmarshal(meta.Message.Content, &s); err == nil {
		return normalizeSlashCommand(s)
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

// chatBlock is one piece of a rich message: plain text, a tool invocation,
// or a tool result. Used by the chat-view wrapper (TailSession).
type chatBlock struct {
	Kind      string          `json:"kind"` // "text" | "thinking" | "tool_use" | "tool_result"
	Text      string          `json:"text,omitempty"`        // text / thinking
	Name      string          `json:"name,omitempty"`        // tool_use
	Input     json.RawMessage `json:"input,omitempty"`       // tool_use
	ToolUseID string          `json:"tool_use_id,omitempty"` // tool_use / tool_result
	Content   string          `json:"content,omitempty"`     // tool_result
	IsError   bool            `json:"is_error,omitempty"`    // tool_result
}

type richMessage struct {
	UUID       string      `json:"uuid"`
	ParentUUID string      `json:"parent_uuid,omitempty"`
	Role       string      `json:"role"` // "user" | "assistant"
	Blocks     []chatBlock `json:"blocks"`
	Timestamp  string      `json:"timestamp,omitempty"`
}

// toolResultText flattens a tool_result content value (string or array of
// {type:"text",text} blocks) into a single string.
func toolResultText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err == nil {
		var parts []string
		for _, b := range blocks {
			if b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

// extractBlocks parses a message's content into rich blocks (text, tool_use,
// tool_result). Content may be a string (→ one text block) or an array.
func extractBlocks(meta jsonlMeta) []chatBlock {
	if meta.Message == nil {
		return nil
	}
	var s string
	if err := json.Unmarshal(meta.Message.Content, &s); err == nil {
		s = normalizeSlashCommand(strings.TrimSpace(s))
		if s == "" {
			return nil
		}
		return []chatBlock{{Kind: "text", Text: truncate(s, 16000)}}
	}
	var raw []json.RawMessage
	if err := json.Unmarshal(meta.Message.Content, &raw); err != nil {
		return nil
	}
	var blocks []chatBlock
	for _, item := range raw {
		var bt struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(item, &bt) != nil {
			continue
		}
		switch bt.Type {
		case "text":
			var b struct {
				Text string `json:"text"`
			}
			if json.Unmarshal(item, &b) == nil && strings.TrimSpace(b.Text) != "" {
				blocks = append(blocks, chatBlock{Kind: "text", Text: truncate(b.Text, 16000)})
			}
		case "thinking":
			var b struct {
				Thinking string `json:"thinking"`
			}
			if json.Unmarshal(item, &b) == nil && strings.TrimSpace(b.Thinking) != "" {
				blocks = append(blocks, chatBlock{Kind: "thinking", Text: truncate(b.Thinking, 16000)})
			}
		case "tool_use":
			var b struct {
				ID    string          `json:"id"`
				Name  string          `json:"name"`
				Input json.RawMessage `json:"input"`
			}
			if json.Unmarshal(item, &b) == nil {
				if len(b.Input) > 8000 {
					b.Input = nil // oversized tool input — drop to keep payload small
				}
				blocks = append(blocks, chatBlock{Kind: "tool_use", ToolUseID: b.ID, Name: b.Name, Input: b.Input})
			}
		case "tool_result":
			var b struct {
				ToolUseID string          `json:"tool_use_id"`
				Content   json.RawMessage `json:"content"`
				IsError   bool            `json:"is_error"`
			}
			if json.Unmarshal(item, &b) == nil {
				blocks = append(blocks, chatBlock{
					Kind:      "tool_result",
					ToolUseID: b.ToolUseID,
					Content:   truncate(toolResultText(b.Content), 8000),
					IsError:   b.IsError,
				})
			}
		}
	}
	return blocks
}

func truncate(s string, max int) string {
	if len(s) > max {
		return s[:max]
	}
	return s
}

// countBranches scans a JSONL file and counts conversation branches (leaf nodes).
// Reads up to maxLines lines (0 = unlimited). Returns 1 for linear conversations.
func countBranches(fullPath string, maxLines int) int {
	file, err := os.Open(fullPath)
	if err != nil {
		return 1
	}
	defer file.Close()

	// Collect all UUIDs and which UUIDs are referenced as parents
	allUUIDs := map[string]bool{}
	hasChildren := map[string]bool{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)
	lineCount := 0

	for scanner.Scan() {
		if maxLines > 0 && lineCount >= maxLines {
			break
		}
		lineCount++
		line := scanner.Text()
		if line == "" {
			continue
		}
		var meta struct {
			UUID       string `json:"uuid"`
			ParentUUID string `json:"parentUuid"`
			Type       string `json:"type"`
		}
		if err := json.Unmarshal([]byte(line), &meta); err != nil || meta.UUID == "" {
			continue
		}
		// Only count user/assistant messages (not system records)
		if meta.Type != "user" && meta.Type != "assistant" {
			continue
		}
		allUUIDs[meta.UUID] = true
		if meta.ParentUUID != "" {
			hasChildren[meta.ParentUUID] = true
		}
	}

	// Count leaf nodes (nodes that are not parents of anyone)
	leaves := 0
	for uuid := range allUUIDs {
		if !hasChildren[uuid] {
			leaves++
		}
	}
	if leaves <= 1 {
		return 1
	}
	return leaves
}

type sessionInfo struct {
	SessionID    string  `json:"session_id"`
	Slug         string  `json:"slug"`
	Name         string  `json:"name,omitempty"` // user-assigned title (custom-title record)
	CWD          string  `json:"cwd"`
	CreatedAt    string  `json:"created_at"`
	UpdatedAt    string  `json:"updated_at"`
	SizeMB       float64 `json:"size_mb"`
	FirstMessage string  `json:"first_message"`
	Project      string  `json:"project"`      // project slug (needed for preview)
	BranchCount  int     `json:"branch_count"` // number of conversation branches (>1 = has branches)
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
	seenPaths := map[string]bool{}
	var scannedDirs []string

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
		scannedDirs = append(scannedDirs, projPath)

		var sessions []sessionInfo
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}

			fullPath := filepath.Join(projPath, f.Name())
			seenPaths[fullPath] = true
			fi, err := os.Stat(fullPath)
			if err != nil {
				continue
			}

			// Cache hit: file unchanged since last parse (append-only JSONL)
			h.cacheMu.RLock()
			ce, cached := h.cache[fullPath]
			h.cacheMu.RUnlock()
			if cached && ce.modTime.Equal(fi.ModTime()) && ce.size == fi.Size() {
				if !ce.skip {
					sessions = append(sessions, ce.info)
				}
				continue
			}

			fileBaseID := strings.TrimSuffix(f.Name(), ".jsonl")
			si := sessionInfo{
				SessionID: fileBaseID,
				SizeMB:    float64(fi.Size()) / (1024 * 1024),
				UpdatedAt: fi.ModTime().UTC().Format(time.RFC3339),
				Project:   projEntry.Name(),
			}

			// Read first 50 lines to extract metadata
			hasConversation := false
			titles := map[string]string{}
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

					if meta.Type == "custom-title" && meta.CustomTitle != "" {
						titles[meta.SessionID] = meta.CustomTitle
						continue
					}

					// Use internal sessionId (what claude --resume expects)
					if meta.SessionID != "" && si.SessionID == fileBaseID {
						si.SessionID = meta.SessionID
					}

					if meta.Slug != "" {
						si.Slug = meta.Slug
					}
					if meta.CWD != "" && si.CWD == "" {
						si.CWD = meta.CWD // first occurrence = initial invocation dir
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
				h.cacheMu.Lock()
				h.cache[fullPath] = cachedSession{modTime: fi.ModTime(), size: fi.Size(), skip: true}
				h.cacheMu.Unlock()
				continue
			}

			if si.CreatedAt == "" {
				si.CreatedAt = si.UpdatedAt
			}

			// Override cwd with path derived from project slug (more reliable for --resume)
			si.CWD = deriveResumeCWD(projEntry.Name(), si.CWD)

			// Count branches (limit to 500 lines for large files to avoid slow parsing)
			maxLines := 0
			if fi.Size() > 1024*1024 { // >1MB
				maxLines = 500
			}
			si.BranchCount = countBranches(fullPath, maxLines)

			// Custom titles live deep in the file — the tail has the latest ones (wins over head)
			for id, t := range extractCustomTitles(fullPath, fi.Size()) {
				titles[id] = t
			}
			if t, ok := titles[si.SessionID]; ok {
				si.Name = t
			} else if t, ok := titles[fileBaseID]; ok {
				si.Name = t
			}

			h.cacheMu.Lock()
			h.cache[fullPath] = cachedSession{modTime: fi.ModTime(), size: fi.Size(), info: si}
			h.cacheMu.Unlock()

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

	// Prune cache entries for files deleted from the scanned projects.
	// Only scanned dirs — other users' workspaces must keep their entries.
	h.cacheMu.Lock()
	for p := range h.cache {
		if seenPaths[p] {
			continue
		}
		for _, dir := range scannedDirs {
			if strings.HasPrefix(p, dir+string(filepath.Separator)) {
				delete(h.cache, p)
				break
			}
		}
	}
	h.cacheMu.Unlock()

	c.JSON(http.StatusOK, gin.H{"projects": projects})
}

// --- Session Search ---

type searchResult struct {
	SessionID    string  `json:"session_id"`
	Project      string  `json:"project"`
	Slug         string  `json:"slug"`
	Name         string  `json:"name,omitempty"`
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

			// Search through custom titles (session/branch names) + messages
			titles := extractCustomTitles(fullPath, fi.Size())
			match := h.searchInSession(fullPath, qLower, titles)
			if match == nil {
				continue
			}

			var name string
			if t, ok := titles[match.sessionID]; ok {
				name = t
			} else if t, ok := titles[strings.TrimSuffix(f.Name(), ".jsonl")]; ok {
				name = t
			}

			results = append(results, searchResult{
				SessionID:    match.sessionID,
				Project:      projEntry.Name(),
				Slug:         match.slug,
				Name:         name,
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

func (h *ClaudeSessionsHandler) searchInSession(filePath, qLower string, titles map[string]string) *searchMatch {
	file, err := os.Open(filePath)
	if err != nil {
		return nil
	}
	defer file.Close()

	// Custom title (session/branch name) match — snippet is the title itself
	titleHit := ""
	for _, t := range titles {
		if strings.Contains(strings.ToLower(t), qLower) {
			titleHit = t
			break
		}
	}

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

			// Title matched — metadata collected, no need to scan content
			if titleHit != "" && sessionID != "" && firstMessage != "" {
				return &searchMatch{
					sessionID:    sessionID,
					slug:         slug,
					snippet:      titleHit,
					firstMessage: firstMessage,
					cwd:          cwd,
				}
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

	// Title matched but scan ended before full metadata was collected
	if titleHit != "" {
		if sessionID == "" {
			sessionID = strings.TrimSuffix(filepath.Base(filePath), ".jsonl")
		}
		return &searchMatch{
			sessionID:    sessionID,
			slug:         slug,
			snippet:      titleHit,
			firstMessage: firstMessage,
			cwd:          cwd,
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

	h.cacheMu.Lock()
	delete(h.cache, fullPath)
	h.cacheMu.Unlock()

	c.JSON(http.StatusOK, gin.H{"message": "Session deleted"})
}

// --- Rename Session ---

type renameSessionRequest struct {
	Name string `json:"name" binding:"required"`
}

// RenameSession sets a session's display name by appending a custom-title record
// to its JSONL file — the same mechanism Claude CLI uses for renames (last record
// per sessionId wins). The record's sessionId is the session's internal id, which
// is what List/Search match against to populate Name.
func (h *ClaudeSessionsHandler) RenameSession(c *gin.Context) {
	project := c.Param("project")
	sessionFile := c.Param("sessionFile")

	if !slugRe.MatchString(project) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid project"})
		return
	}

	var req renameSessionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Name is required"})
		return
	}
	if len([]rune(name)) > 200 {
		name = string([]rune(name)[:200])
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
	candidate := filepath.Join(projDir, sessionFile+".jsonl")
	if _, err := os.Stat(candidate); err == nil {
		fullPath = candidate
	} else {
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

	// Build a valid custom-title JSONL line (json.Marshal escapes the title safely).
	rec := struct {
		Type        string `json:"type"`
		CustomTitle string `json:"customTitle"`
		SessionID   string `json:"sessionId"`
	}{Type: "custom-title", CustomTitle: name, SessionID: sessionFile}
	line, err := json.Marshal(rec)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to encode title"})
		return
	}

	f, err := os.OpenFile(fullPath, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to open session"})
		return
	}
	if _, err := f.Write(append(line, '\n')); err != nil {
		f.Close()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to write title"})
		return
	}
	f.Close()

	h.cacheMu.Lock()
	delete(h.cache, fullPath)
	h.cacheMu.Unlock()

	c.JSON(http.StatusOK, gin.H{"message": "Session renamed", "name": name})
}

// --- Chat-view wrapper: live resolution + incremental tail ---

// newestJSONLInDir returns the base filename (no .jsonl) of the most recently
// modified .jsonl in dir, plus its modtime. ("", zero) if none.
func newestJSONLInDir(dir string) (string, time.Time) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", time.Time{}
	}
	var bestBase string
	var bestMT time.Time
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().After(bestMT) {
			bestMT = info.ModTime()
			bestBase = strings.TrimSuffix(e.Name(), ".jsonl")
		}
	}
	return bestBase, bestMT
}

// sessionFileBySessionID scans a project dir for the .jsonl whose internal
// sessionId matches sid (checks filename first). Returns base name or "".
func sessionFileBySessionID(projDir, sid string) string {
	if _, err := os.Stat(filepath.Join(projDir, sid+".jsonl")); err == nil {
		return sid
	}
	entries, err := os.ReadDir(projDir)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		fp := filepath.Join(projDir, e.Name())
		file, err := os.Open(fp)
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)
		found := false
		for i := 0; i < 5 && scanner.Scan(); i++ {
			var meta jsonlMeta
			if json.Unmarshal([]byte(scanner.Text()), &meta) == nil && meta.SessionID == sid {
				found = true
				break
			}
		}
		file.Close()
		if found {
			return strings.TrimSuffix(e.Name(), ".jsonl")
		}
	}
	return ""
}

// ResolveLive maps a running terminal → its live Claude session JSONL.
// Priority: 1) hook-tracked sessionId+cwd (exact), 2) frontend cwd hint
// (newest .jsonl in that project dir), 3) newest .jsonl across the user's
// whole workspace (handles `cd` into subdirs without hooks).
func (h *ClaudeSessionsHandler) ResolveLive(c *gin.Context) {
	instanceID := c.Query("instanceId")
	cwdHint := c.Query("cwd")
	sessionHint := c.Query("sessionId") // exact session opened via --resume (frontend knows the id)
	wsSlug := h.userWorkspaceSlug(c)
	projectsDir := filepath.Join(h.claudeBaseDir(), "projects")

	hookSid, hookCwd, hookOk := GetLiveSession(instanceID)
	log.Printf("[ResolveLive] instance=%s cwd=%q hint=%s wsSlug=%s hook(ok=%v sid=%s cwd=%q)",
		instanceID, cwdHint, sessionHint, wsSlug, hookOk, hookSid, hookCwd)

	respond := func(tier, project, sessionFile, sessionID, cwd string) {
		log.Printf("[ResolveLive] → %s project=%s file=%s sid=%s", tier, project, sessionFile, sessionID)
		c.JSON(http.StatusOK, gin.H{
			"project":      project,
			"session_file": sessionFile,
			"session_id":   sessionID,
			"cwd":          cwd,
			"active":       true,
		})
	}

	// 1) Hook-tracked exact session (authoritative — instance match is proof, so
	// NOT gated by matchesWorkspace: the hook reported this instance's real session).
	//
	// НО: если пользователь ЯВНО открыл ДРУГУЮ сессию в ДРУГОЙ папке (sessionHint задан,
	// отличается от хука, и cwdHint ≠ hookCwd) — хук УСТАРЕЛ для этого открытия
	// (переиспользованный терминал: старый claude не закрылся чисто → SessionEnd не очистил
	// карту, а новый --resume ещё не выстрелил хуком). Тогда пропускаем tier1 и отдаём явный
	// hint (tier 1.5). Форк в ТОЙ ЖЕ папке (hook новее) — по-прежнему выигрывает (cwd совпадает).
	staleHook := sessionHint != "" && sessionHint != hookSid &&
		cwdHint != "" && workspaceSlug(cwdHint) != workspaceSlug(hookCwd)
	if hookOk && hookSid != "" && hookCwd != "" && !staleHook {
		slug := workspaceSlug(hookCwd)
		if file := sessionFileBySessionID(filepath.Join(projectsDir, slug), hookSid); file != "" {
			respond("tier1-hook", slug, file, hookSid, hookCwd)
			return
		}
		log.Printf("[ResolveLive] tier1 miss: dir=%s sid=%s not found on disk", slug, hookSid)
	} else if staleHook {
		log.Printf("[ResolveLive] tier1 SKIP (stale hook for другой папки): hookSid=%s hookCwd=%q hint=%s cwd=%q",
			hookSid, hookCwd, sessionHint, cwdHint)
	}

	// 1.5) Explicit sessionId hint (opened via --resume) — exact session, before
	// weak fallbacks. Hook-tracked (tier 1) still wins so a fork to a new session
	// id corrects this. Search the cwd slug first, then all workspace project dirs.
	if sessionHint != "" {
		if cwdHint != "" {
			slug := workspaceSlug(cwdHint)
			if file := sessionFileBySessionID(filepath.Join(projectsDir, slug), sessionHint); file != "" {
				respond("tier1.5-hint", slug, file, sessionHint, cwdHint)
				return
			}
		}
		// scan every project dir for the exact hinted session id (explicit = authoritative)
		if entries, err := os.ReadDir(projectsDir); err == nil {
			for _, e := range entries {
				if !e.IsDir() {
					continue
				}
				if file := sessionFileBySessionID(filepath.Join(projectsDir, e.Name()), sessionHint); file != "" {
					respond("tier1.5-hint-scan", e.Name(), file, sessionHint, cwdHint)
					return
				}
			}
		}
	}

	// 2) Frontend-provided cwd hint → newest .jsonl in that project dir.
	if cwdHint != "" {
		slug := workspaceSlug(cwdHint)
		if matchesWorkspace(slug, wsSlug) {
			if file, _ := newestJSONLInDir(filepath.Join(projectsDir, slug)); file != "" {
				respond("tier2-cwd", slug, file, "", cwdHint)
				return
			}
		}
	}

	// 3) Newest .jsonl across all of the user's workspace projects.
	entries, err := os.ReadDir(projectsDir)
	if err == nil {
		var bestProj, bestFile string
		var bestMT time.Time
		for _, e := range entries {
			if !e.IsDir() || !matchesWorkspace(e.Name(), wsSlug) {
				continue
			}
			if base, mt := newestJSONLInDir(filepath.Join(projectsDir, e.Name())); base != "" && mt.After(bestMT) {
				bestMT, bestProj, bestFile = mt, e.Name(), base
			}
		}
		if bestFile != "" {
			respond("tier3-newest", bestProj, bestFile, "", "")
			return
		}
	}

	log.Printf("[ResolveLive] → NOT FOUND instance=%s", instanceID)
	c.JSON(http.StatusNotFound, gin.H{"error": "No live session found"})
}

// TailSession returns rich messages appended after byte `offset`. The JSONL is
// append-only, so the frontend keeps an offset and only ever gets new messages
// (stable, no repaint). A trailing partial line (mid-write) is never consumed.
func (h *ClaudeSessionsHandler) TailSession(c *gin.Context) {
	project := c.Param("project")
	sessionFile := c.Param("sessionFile")

	if !slugRe.MatchString(project) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid project"})
		return
	}
	wsSlug := h.userWorkspaceSlug(c)
	if !matchesWorkspace(project, wsSlug) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	var offset int64
	if v := c.Query("offset"); v != "" {
		if parsed, err := strconv.ParseInt(v, 10, 64); err == nil && parsed >= 0 {
			offset = parsed
		}
	}

	projDir := filepath.Join(h.claudeBaseDir(), "projects", project)
	fullPath := filepath.Join(projDir, sessionFile+".jsonl")
	if _, err := os.Stat(fullPath); err != nil {
		if base := sessionFileBySessionID(projDir, sessionFile); base != "" {
			fullPath = filepath.Join(projDir, base+".jsonl")
		}
	}

	fi, err := os.Stat(fullPath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}
	size := fi.Size()

	// File shrank/rotated (offset past EOF) → restart from the beginning.
	if offset > size {
		offset = 0
	}
	if offset == size {
		c.JSON(http.StatusOK, gin.H{"messages": []richMessage{}, "offset": size, "size": size, "eof": true})
		return
	}

	f, err := os.Open(fullPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to open session"})
		return
	}
	defer f.Close()
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Seek failed"})
		return
	}

	const maxRead = 24 * 1024 * 1024 // 24MB per call
	data, _ := io.ReadAll(io.LimitReader(f, maxRead))

	// Only consume up to the last complete line (newline-terminated).
	nl := bytes.LastIndexByte(data, '\n')
	if nl < 0 {
		c.JSON(http.StatusOK, gin.H{"messages": []richMessage{}, "offset": offset, "size": size, "eof": offset >= size})
		return
	}
	complete := data[:nl+1]
	newOffset := offset + int64(nl+1)

	msgs := make([]richMessage, 0, 32)
	sessionID := ""
	title := ""

	newScanner := func() *bufio.Scanner {
		s := bufio.NewScanner(bytes.NewReader(complete))
		s.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		return s
	}

	if offset == 0 {
		// Full load → reconstruct the ACTIVE branch: path from the newest
		// non-sidechain message up to the root via parentUuid. This drops
		// abandoned branches (rewind) and Task subagent threads (sidechains).
		parentByUUID := make(map[string]string)
		sidechainByUUID := make(map[string]bool)
		msgByUUID := make(map[string]richMessage)
		tip, tipIdx := "", -1
		i := 0
		scanner := newScanner()
		for scanner.Scan() {
			line := scanner.Text()
			i++
			if line == "" {
				continue
			}
			var meta jsonlMeta
			if json.Unmarshal([]byte(line), &meta) != nil {
				continue
			}
			if meta.Type == "custom-title" && meta.CustomTitle != "" {
				title = meta.CustomTitle
				continue
			}
			if meta.SessionID != "" {
				sessionID = meta.SessionID
			}
			if meta.UUID != "" {
				parentByUUID[meta.UUID] = meta.ParentUUID
				sidechainByUUID[meta.UUID] = meta.IsSidechain
			}
			if meta.Type != "user" && meta.Type != "assistant" {
				continue
			}
			blocks := extractBlocks(meta)
			if len(blocks) == 0 {
				continue
			}
			if meta.UUID == "" {
				msgs = append(msgs, richMessage{Role: meta.Type, Blocks: blocks, Timestamp: meta.Timestamp})
				continue
			}
			msgByUUID[meta.UUID] = richMessage{UUID: meta.UUID, ParentUUID: meta.ParentUUID, Role: meta.Type, Blocks: blocks, Timestamp: meta.Timestamp}
			if !meta.IsSidechain {
				tip, tipIdx = meta.UUID, i
			}
		}
		_ = tipIdx
		if tip != "" {
			var path []richMessage
			seen := make(map[string]bool)
			for u := tip; u != "" && !seen[u]; u = parentByUUID[u] {
				seen[u] = true
				if sidechainByUUID[u] {
					continue
				}
				if m, ok := msgByUUID[u]; ok {
					path = append(path, m)
				}
			}
			for j := len(path) - 1; j >= 0; j-- { // reverse: root → tip
				msgs = append(msgs, path[j])
			}
		}
	} else {
		// Incremental append (linear). Frontend detects rewinds via parent_uuid
		// discontinuity and re-requests a full reload.
		scanner := newScanner()
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				continue
			}
			var meta jsonlMeta
			if json.Unmarshal([]byte(line), &meta) != nil {
				continue
			}
			if meta.Type == "custom-title" && meta.CustomTitle != "" {
				title = meta.CustomTitle
				continue
			}
			if meta.SessionID != "" {
				sessionID = meta.SessionID
			}
			if meta.IsSidechain || (meta.Type != "user" && meta.Type != "assistant") {
				continue
			}
			blocks := extractBlocks(meta)
			if len(blocks) == 0 {
				continue
			}
			msgs = append(msgs, richMessage{UUID: meta.UUID, ParentUUID: meta.ParentUUID, Role: meta.Type, Blocks: blocks, Timestamp: meta.Timestamp})
		}
	}

	// Keep payloads bounded on a huge first load — return the most recent.
	const maxMsgs = 3000
	if len(msgs) > maxMsgs {
		msgs = msgs[len(msgs)-maxMsgs:]
	}

	c.JSON(http.StatusOK, gin.H{
		"messages":   msgs,
		"offset":     newOffset,
		"size":       size,
		"session_id": sessionID,
		"name":       title,
		"eof":        newOffset >= size,
	})
}

// --- List Branches ---

type branchDetail struct {
	BranchID     string `json:"branch_id"`
	Name         string `json:"name,omitempty"` // custom-title of the branch's sessionId
	FirstMessage string `json:"first_message"`
	MessageCount int    `json:"message_count"`
	CreatedAt    string `json:"created_at"`
	ParentMsgID  string `json:"parent_msg_id"`
}

// ListBranches parses a session JSONL and returns distinct conversation branches.
func (h *ClaudeSessionsHandler) ListBranches(c *gin.Context) {
	project := c.Param("project")
	sessionFile := c.Param("sessionFile")

	if !slugRe.MatchString(project) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid project"})
		return
	}

	wsSlug := h.userWorkspaceSlug(c)
	if !matchesWorkspace(project, wsSlug) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	claudeBase := h.claudeBaseDir()
	projDir := filepath.Join(claudeBase, "projects", project)

	// Find JSONL file
	var fullPath string
	candidate := filepath.Join(projDir, sessionFile+".jsonl")
	if _, err := os.Stat(candidate); err == nil {
		fullPath = candidate
	} else {
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

	fi, err := os.Stat(fullPath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}
	if fi.Size() > 100<<20 {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "Session too large"})
		return
	}

	file, err := os.Open(fullPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read session"})
		return
	}
	defer file.Close()

	// Build message tree
	type msgNode struct {
		uuid       string
		parentUUID string
		msgType    string // user, assistant
		text       string
		timestamp  string
		sessionID  string
		children   []string
	}

	nodes := map[string]*msgNode{}
	titles := map[string]string{} // sessionId → custom title (branch names)
	var rootUUIDs []string
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		var meta jsonlMeta
		if err := json.Unmarshal([]byte(line), &meta); err != nil {
			continue
		}
		if meta.Type == "custom-title" && meta.CustomTitle != "" {
			titles[meta.SessionID] = meta.CustomTitle // last record wins
			continue
		}
		if meta.UUID == "" {
			continue
		}
		if meta.Type != "user" && meta.Type != "assistant" {
			continue
		}
		text := extractTextContent(meta)
		n := &msgNode{
			uuid:       meta.UUID,
			parentUUID: meta.ParentUUID,
			msgType:    meta.Type,
			text:       text,
			timestamp:  meta.Timestamp,
			sessionID:  meta.SessionID,
		}
		nodes[meta.UUID] = n
		if meta.ParentUUID == "" {
			rootUUIDs = append(rootUUIDs, meta.UUID)
		}
	}

	// Link children
	for _, n := range nodes {
		if n.parentUUID != "" {
			if parent, ok := nodes[n.parentUUID]; ok {
				parent.children = append(parent.children, n.uuid)
			}
		}
	}

	// Find leaf nodes (nodes with no children)
	var leafUUIDs []string
	for uuid, n := range nodes {
		if len(n.children) == 0 && n.msgType != "" {
			_ = n
			leafUUIDs = append(leafUUIDs, uuid)
		}
	}

	// For each leaf, trace back to find the branch point and first user message on this branch
	var branches []branchDetail
	for _, leafUUID := range leafUUIDs {
		// Walk back to root, counting messages
		msgCount := 0
		var branchParent string
		// Collect path from leaf to root
		var path []string
		current := leafUUID
		for current != "" {
			n := nodes[current]
			if n == nil {
				break
			}
			path = append(path, current)
			msgCount++
			// Find the deepest branch point (closest to leaf)
			if n.parentUUID != "" {
				parent := nodes[n.parentUUID]
				if parent != nil && len(parent.children) > 1 && branchParent == "" {
					branchParent = n.parentUUID
				}
			}
			current = n.parentUUID
		}

		// Find the first user message AFTER the branch point (unique to this branch).
		// Walk from branch point toward leaf (reverse of path order).
		var firstUserMsg, firstTimestamp string
		foundBranchPoint := branchParent == "" // if no branch point, take first user msg overall
		for i := len(path) - 1; i >= 0; i-- {
			n := nodes[path[i]]
			if n == nil {
				continue
			}
			if !foundBranchPoint {
				if n.parentUUID == branchParent {
					foundBranchPoint = true
				}
			}
			if foundBranchPoint && n.msgType == "user" && n.text != "" {
				firstUserMsg = n.text
				firstTimestamp = n.timestamp
				break
			}
		}

		// Fallback: if no user message found after branch point, use leaf's timestamp
		if firstTimestamp == "" {
			leaf := nodes[leafUUID]
			if leaf != nil {
				firstTimestamp = leaf.timestamp
			}
		}

		// Branch name: custom-title whose sessionId matches the leaf's sessionId
		// (forked branches get their own sessionId in appended records)
		branchName := ""
		if leaf := nodes[leafUUID]; leaf != nil && leaf.sessionID != "" {
			branchName = titles[leaf.sessionID]
		}

		branches = append(branches, branchDetail{
			BranchID:     leafUUID,
			Name:         branchName,
			FirstMessage: truncate(firstUserMsg, 200),
			MessageCount: msgCount,
			CreatedAt:    firstTimestamp,
			ParentMsgID:  branchParent,
		})
	}

	// Sort branches by created_at
	sort.Slice(branches, func(i, j int) bool {
		return branches[i].CreatedAt < branches[j].CreatedAt
	})

	c.JSON(http.StatusOK, gin.H{"branches": branches})
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
