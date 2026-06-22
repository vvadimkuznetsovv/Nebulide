package handlers

import (
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

// SkillsHandler manages per-user Claude Code skills.
//
// STORAGE MODEL: per-app-user skills are PROJECT skills living under
// {userWorkspace}/.claude/skills/<name>/SKILL.md. Read-only "claude" skills are
// the bundled/plugin and personal skills under the server's home ~/.claude.
type SkillsHandler struct {
	cfg *config.Config
}

func NewSkillsHandler(cfg *config.Config) *SkillsHandler {
	return &SkillsHandler{cfg: cfg}
}

// skillSlugRe matches characters NOT allowed in a skill slug.
var skillSlugRe = regexp.MustCompile(`[^a-z0-9-]+`)

// skillFrontmatterDescRe extracts the `description:` value from YAML frontmatter.
var skillFrontmatterDescRe = regexp.MustCompile(`^\s*description:\s*(.*)$`)

type ownSkill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	UpdatedAt   string `json:"updated_at"`
}

type claudeSkill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Source      string `json:"source"` // "plugin" | "personal"
}

// ownSkillsDir returns the per-user skills directory: {base}/.claude/skills.
// Admin uses the legacy ClaudeWorkingDir, regular users their per-user workspace
// (mirrors handlers/terminal.go workDir resolution).
func (h *SkillsHandler) ownSkillsDir(c *gin.Context) string {
	username := c.GetString("username")
	base := h.cfg.ClaudeWorkingDir
	if username != "" && username != h.cfg.AdminUsername {
		base = h.cfg.GetUserWorkspaceDir(username)
	}
	return filepath.Join(base, ".claude", "skills")
}

// slugifySkill normalizes a desired skill name into a filesystem-safe slug.
// lowercase, spaces→'-', only [a-z0-9-], collapse repeats, trim leading/trailing '-'.
// Returns "" if the result is empty or contains traversal sequences.
func slugifySkill(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	s = strings.ReplaceAll(s, " ", "-")
	s = strings.ReplaceAll(s, "_", "-")
	s = skillSlugRe.ReplaceAllString(s, "-")
	// Collapse multiple dashes
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	s = strings.Trim(s, "-")
	if s == "" || s == "." || s == ".." {
		return ""
	}
	return s
}

// skillPath builds the absolute path to a skill dir for a slug and verifies it
// stays inside ownDir (defense-in-depth against traversal). Returns ("", false)
// if the slug is invalid or escapes the sandbox.
func skillPath(ownDir, slug string) (string, bool) {
	if slug == "" || strings.ContainsAny(slug, `/\`) || strings.Contains(slug, "..") {
		return "", false
	}
	full := filepath.Join(ownDir, slug)
	// Ensure resolved path is still within ownDir.
	rel, err := filepath.Rel(ownDir, full)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || strings.Contains(rel, "..") {
		return "", false
	}
	return full, true
}

// parseSkillDescription reads SKILL.md and returns the `description:` value from
// the leading YAML frontmatter (between the first pair of `---` fences). Returns
// "" if there is no frontmatter or no description line. No external deps.
func parseSkillDescription(skillMdPath string) string {
	f, err := os.Open(skillMdPath)
	if err != nil {
		return ""
	}
	defer f.Close()
	// Read at most 64KB — frontmatter lives at the top.
	buf := make([]byte, 64*1024)
	n, _ := io.ReadFull(f, buf)
	if n == 0 {
		return ""
	}
	return parseFrontmatterDescription(string(buf[:n]))
}

// parseFrontmatterDescription scans the leading `---` … `---` block of a markdown
// document and returns the `description:` value, or "" if absent.
func parseFrontmatterDescription(content string) string {
	content = strings.ReplaceAll(content, "\r\n", "\n")
	if !strings.HasPrefix(content, "---\n") {
		return ""
	}
	lines := strings.Split(content, "\n")
	for i := 1; i < len(lines); i++ {
		line := lines[i]
		if strings.TrimSpace(line) == "---" {
			break // end of frontmatter
		}
		if m := skillFrontmatterDescRe.FindStringSubmatch(line); m != nil {
			return strings.TrimSpace(strings.Trim(strings.TrimSpace(m[1]), `"'`))
		}
	}
	return ""
}

// List handles GET /api/skills.
func (h *SkillsHandler) List(c *gin.Context) {
	ownDir := h.ownSkillsDir(c)

	own := make([]ownSkill, 0)
	if entries, err := os.ReadDir(ownDir); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			skillMd := filepath.Join(ownDir, e.Name(), "SKILL.md")
			info, err := os.Stat(skillMd)
			if err != nil {
				continue // no SKILL.md — not a skill
			}
			own = append(own, ownSkill{
				Name:        e.Name(),
				Description: parseSkillDescription(skillMd),
				UpdatedAt:   info.ModTime().UTC().Format(time.RFC3339),
			})
		}
	}
	sort.Slice(own, func(i, j int) bool { return own[i].Name < own[j].Name })

	// Read-only "claude" skills: bundled/plugin + personal under ~/.claude.
	claude := make([]claudeSkill, 0)
	seen := make(map[string]bool)
	home, herr := os.UserHomeDir()
	if herr == nil && home != "" {
		claudeBase := filepath.Join(home, ".claude")

		// 1) Plugin skills: ~/.claude/plugins/**/skills/<name>/SKILL.md
		pluginsRoot := filepath.Join(claudeBase, "plugins")
		_ = filepath.WalkDir(pluginsRoot, func(path string, d os.DirEntry, err error) error {
			if err != nil || d == nil || d.IsDir() {
				return nil
			}
			if d.Name() != "SKILL.md" {
				return nil
			}
			// .../skills/<name>/SKILL.md → name = parent dir, must be under a "skills" dir
			nameDir := filepath.Dir(path)
			if filepath.Base(filepath.Dir(nameDir)) != "skills" {
				return nil
			}
			name := filepath.Base(nameDir)
			if name == "" || seen[name] {
				return nil
			}
			seen[name] = true
			claude = append(claude, claudeSkill{
				Name:        name,
				Description: parseSkillDescription(path),
				Source:      "plugin",
			})
			return nil
		})

		// 2) Personal skills: ~/.claude/skills/<name>/SKILL.md
		personalRoot := filepath.Join(claudeBase, "skills")
		if pentries, err := os.ReadDir(personalRoot); err == nil {
			for _, e := range pentries {
				if !e.IsDir() {
					continue
				}
				name := e.Name()
				if seen[name] {
					continue
				}
				skillMd := filepath.Join(personalRoot, name, "SKILL.md")
				if _, err := os.Stat(skillMd); err != nil {
					continue
				}
				seen[name] = true
				claude = append(claude, claudeSkill{
					Name:        name,
					Description: parseSkillDescription(skillMd),
					Source:      "personal",
				})
			}
		}
	}
	sort.Slice(claude, func(i, j int) bool { return claude[i].Name < claude[j].Name })

	c.JSON(http.StatusOK, gin.H{"own": own, "claude": claude})
}

// Upload handles POST /api/skills/upload (multipart: file=*.md, name=<desired>).
func (h *SkillsHandler) Upload(c *gin.Context) {
	c.Request.ParseMultipartForm(8 << 20) // 8MB limit

	name := c.Request.FormValue("name")
	slug := slugifySkill(name)
	if slug == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid skill name"})
		return
	}

	file, _, err := c.Request.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No file provided"})
		return
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, 8<<20))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read upload"})
		return
	}

	ownDir := h.ownSkillsDir(c)
	skillDir, ok := skillPath(ownDir, slug)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid skill name"})
		return
	}

	// 409 if the skill already exists.
	if _, err := os.Stat(skillDir); err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "Skill already exists"})
		return
	}

	// If no leading YAML frontmatter, wrap the content with a minimal one.
	body := string(data)
	if !strings.HasPrefix(strings.ReplaceAll(body, "\r\n", "\n"), "---\n") {
		body = "---\ndescription: " + name + "\n---\n\n" + body
		data = []byte(body)
	}

	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create skill directory"})
		return
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), data, 0o644); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to write skill"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"name": slug})
}

type skillRenameRequest struct {
	OldName string `json:"old_name" binding:"required"`
	NewName string `json:"new_name" binding:"required"`
}

// Rename handles POST /api/skills/rename (JSON old_name/new_name).
func (h *SkillsHandler) Rename(c *gin.Context) {
	var req skillRenameRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	oldSlug := slugifySkill(req.OldName)
	newSlug := slugifySkill(req.NewName)
	if newSlug == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid new skill name"})
		return
	}

	ownDir := h.ownSkillsDir(c)
	oldDir, ok1 := skillPath(ownDir, oldSlug)
	newDir, ok2 := skillPath(ownDir, newSlug)
	if !ok1 || !ok2 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid skill name"})
		return
	}

	if _, err := os.Stat(oldDir); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Skill not found"})
		return
	}
	if _, err := os.Stat(newDir); err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "Skill already exists"})
		return
	}

	if err := os.Rename(oldDir, newDir); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to rename skill"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"name": newSlug})
}

// Delete handles DELETE /api/skills?name=<slug>.
func (h *SkillsHandler) Delete(c *gin.Context) {
	slug := slugifySkill(c.Query("name"))
	ownDir := h.ownSkillsDir(c)
	skillDir, ok := skillPath(ownDir, slug)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid skill name"})
		return
	}

	if _, err := os.Stat(skillDir); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Skill not found"})
		return
	}
	if err := os.RemoveAll(skillDir); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete skill"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Read handles GET /api/skills/read?name=<slug> — returns SKILL.md contents.
func (h *SkillsHandler) Read(c *gin.Context) {
	slug := slugifySkill(c.Query("name"))
	ownDir := h.ownSkillsDir(c)
	skillDir, ok := skillPath(ownDir, slug)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid skill name"})
		return
	}

	skillMd := filepath.Join(skillDir, "SKILL.md")
	info, err := os.Stat(skillMd)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Skill not found"})
		return
	}
	// Limit file size to 1MB (like files.Read).
	if info.Size() > 1*1024*1024 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "File too large (max 1MB)"})
		return
	}

	content, err := os.ReadFile(skillMd)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read skill"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"content": string(content)})
}
