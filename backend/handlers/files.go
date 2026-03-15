package handlers

import (
	"archive/zip"
	"crypto/md5"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/gin-gonic/gin"
	"github.com/nwaples/rardecode/v2"

	"nebulide/config"
)

type FilesHandler struct {
	cfg *config.Config
}

func NewFilesHandler(cfg *config.Config) *FilesHandler {
	return &FilesHandler{cfg: cfg}
}

// getUserDir returns the workspace directory for the current user.
// Admin gets the legacy ClaudeWorkingDir; regular users get per-user workspace.
func (h *FilesHandler) getUserDir(c *gin.Context) string {
	username, _ := c.Get("username")
	if u, ok := username.(string); ok && u != "" {
		// Check if admin (admin uses legacy workspace for backward compat)
		if u == h.cfg.AdminUsername {
			return h.cfg.ClaudeWorkingDir
		}
		return h.cfg.GetUserWorkspaceDir(u)
	}
	return h.cfg.ClaudeWorkingDir
}

type FileInfo struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	IsDir   bool   `json:"is_dir"`
	Size    int64  `json:"size"`
	ModTime string `json:"mod_time"`
}

type writeFileRequest struct {
	Path    string `json:"path" binding:"required"`
	Content string `json:"content"`
}

type mkdirRequest struct {
	Path string `json:"path" binding:"required"`
}

type renameRequest struct {
	OldPath string `json:"old_path" binding:"required"`
	NewPath string `json:"new_path" binding:"required"`
}

func (h *FilesHandler) List(c *gin.Context) {
	userDir := h.getUserDir(c)
	requestedPath := c.Query("path")
	if requestedPath == "" {
		requestedPath = userDir
	}

	fullPath, err := h.safePathWithBase(requestedPath, userDir)
	if err != nil {
		// Try shared folder before falling back
		fullPath, err = h.safePathWithBase(requestedPath, h.cfg.SharedDir)
		if err != nil {
			// Path may be from a different OS — fallback to user working dir
			requestedPath = userDir
			fullPath, err = h.safePathWithBase(requestedPath, userDir)
			if err != nil {
				c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
				return
			}
		}
	}

	entries, err := os.ReadDir(fullPath)
	if err != nil {
		// Directory doesn't exist — fallback to user working dir
		if requestedPath != userDir {
			requestedPath = userDir
			fullPath, _ = h.safePathWithBase(requestedPath, userDir)
			os.MkdirAll(fullPath, 0755)
			entries, err = os.ReadDir(fullPath)
		}
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Directory not found"})
			return
		}
	}

	files := make([]FileInfo, 0, len(entries))
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		// Skip hidden files starting with .
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		files = append(files, FileInfo{
			Name:    entry.Name(),
			Path:    filepath.Join(requestedPath, entry.Name()),
			IsDir:   entry.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime().Format("2006-01-02 15:04:05"),
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"path":  requestedPath,
		"files": files,
	})
}

func (h *FilesHandler) Read(c *gin.Context) {
	requestedPath := c.Query("path")
	if requestedPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path required"})
		return
	}

	fullPath, err := h.safePathForUser(requestedPath, c)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	info, err := os.Stat(fullPath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}

	// Limit file size to 5MB
	if info.Size() > 5*1024*1024 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "File too large (max 5MB)"})
		return
	}

	content, err := os.ReadFile(fullPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read file"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"path":    requestedPath,
		"content": string(content),
		"size":    info.Size(),
	})
}

func (h *FilesHandler) Write(c *gin.Context) {
	var req writeFileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	fullPath, err := h.safePathForUser(req.Path, c)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	dir := filepath.Dir(fullPath)
	if err := os.MkdirAll(dir, fs.ModePerm); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create directory"})
		return
	}

	if err := os.WriteFile(fullPath, []byte(req.Content), 0644); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to write file"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "File saved", "path": req.Path})
}

func (h *FilesHandler) Upload(c *gin.Context) {
	c.Request.ParseMultipartForm(1 << 30) // 1GB limit

	file, header, err := c.Request.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No file provided"})
		return
	}
	defer file.Close()

	// Destination directory (default: user workspace /uploads)
	destDir := c.Query("dir")
	userDir := h.getUserDir(c)
	if destDir == "" {
		destDir = filepath.Join(userDir, "uploads")
	}

	fullDir, err := h.safePathForUser(destDir, c)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	if err := os.MkdirAll(fullDir, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create directory"})
		return
	}

	// Use provided filename or original
	fileName := header.Filename
	fullPath := filepath.Join(fullDir, fileName)

	// Prevent overwrite — add suffix if exists
	if _, err := os.Stat(fullPath); err == nil {
		ext := filepath.Ext(fileName)
		base := strings.TrimSuffix(fileName, ext)
		for i := 1; ; i++ {
			fullPath = filepath.Join(fullDir, fmt.Sprintf("%s_%d%s", base, i, ext))
			if _, err := os.Stat(fullPath); os.IsNotExist(err) {
				break
			}
		}
	}

	out, err := os.Create(fullPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create file"})
		return
	}
	defer out.Close()

	if _, err := io.Copy(out, file); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to write file"})
		return
	}

	// Return the logical path (relative to user dir or shared dir)
	logicalPath := fullPath
	if rel, err := filepath.Rel(userDir, fullPath); err == nil && !strings.HasPrefix(rel, "..") {
		logicalPath = filepath.Join(userDir, rel)
	}
	c.JSON(http.StatusOK, gin.H{"path": filepath.ToSlash(logicalPath)})
}

func (h *FilesHandler) Delete(c *gin.Context) {
	requestedPath := c.Query("path")
	if requestedPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path required"})
		return
	}

	fullPath, err := h.safePathForUser(requestedPath, c)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	// Protect root directories from deletion (workspace, shared folder)
	absPath, _ := filepath.Abs(fullPath)
	protectedRoots := []string{h.getUserDir(c), h.cfg.SharedDir, h.cfg.ClaudeWorkingDir, h.cfg.WorkspacesRoot}
	for _, root := range protectedRoots {
		absRoot, _ := filepath.Abs(root)
		if absPath == absRoot {
			c.JSON(http.StatusForbidden, gin.H{"error": "Cannot delete root directory"})
			return
		}
	}

	if err := os.RemoveAll(fullPath); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Deleted", "path": requestedPath})
}

func (h *FilesHandler) Mkdir(c *gin.Context) {
	var req mkdirRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	fullPath, err := h.safePathForUser(req.Path, c)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	if err := os.MkdirAll(fullPath, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create directory"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Directory created", "path": req.Path})
}

func (h *FilesHandler) Rename(c *gin.Context) {
	var req renameRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	fullOldPath, err := h.safePathForUser(req.OldPath, c)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	fullNewPath, err := h.safePathForUser(req.NewPath, c)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	if _, err := os.Stat(fullOldPath); os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "Source not found"})
		return
	}

	// Auto-rename on conflict: file.json → file (2).json, file (3).json, etc.
	if _, err := os.Stat(fullNewPath); err == nil {
		dir := filepath.Dir(fullNewPath)
		ext := filepath.Ext(fullNewPath)
		base := strings.TrimSuffix(filepath.Base(fullNewPath), ext)
		for i := 2; i < 100; i++ {
			candidate := filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, i, ext))
			if _, err := os.Stat(candidate); os.IsNotExist(err) {
				fullNewPath = candidate
				// Update req.NewPath so the response reflects the actual name
				req.NewPath = filepath.Dir(req.NewPath) + "/" + fmt.Sprintf("%s (%d)%s", base, i, ext)
				break
			}
		}
	}

	if err := os.Rename(fullOldPath, fullNewPath); err != nil {
		// Cross-device move (e.g. workspace → shared folder on different Docker volume):
		// os.Rename returns EXDEV — fall back to copy + delete.
		if isCrossDevice(err) {
			info, statErr := os.Stat(fullOldPath)
			if statErr != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to move"})
				return
			}
			var copyErr error
			if info.IsDir() {
				copyErr = copyDir(fullOldPath, fullNewPath)
			} else {
				copyErr = copyFileOnDisk(fullOldPath, fullNewPath)
			}
			if copyErr != nil {
				os.RemoveAll(fullNewPath) // cleanup partial copy
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to move"})
				return
			}
			os.RemoveAll(fullOldPath)
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to rename"})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{"message": "Renamed", "old_path": req.OldPath, "new_path": req.NewPath})
}

// ReadRaw serves binary files with proper Content-Type (for PDF/DOCX preview in iframe)
func (h *FilesHandler) ReadRaw(c *gin.Context) {
	requestedPath := c.Query("path")
	if requestedPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path required"})
		return
	}

	fullPath, err := h.safePathForUser(requestedPath, c)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	info, err := os.Stat(fullPath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}

	if info.Size() > 50*1024*1024 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "File too large (max 50MB)"})
		return
	}

	ext := strings.ToLower(filepath.Ext(fullPath))
	contentTypes := map[string]string{
		".pdf":  "application/pdf",
		".doc":  "application/msword",
		".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".png":  "image/png",
		".gif":  "image/gif",
		".webp": "image/webp",
		".svg":  "image/svg+xml",
		".bmp":  "image/bmp",
		".ico":  "image/x-icon",
	}
	contentType, ok := contentTypes[ext]
	if !ok {
		contentType = "application/octet-stream"
	}

	c.Header("Content-Type", contentType)
	// Images are safe (rendered via <img> which blocks scripts) — no CSP sandbox needed
	isImage := ext == ".jpg" || ext == ".jpeg" || ext == ".png" || ext == ".gif" ||
		ext == ".webp" || ext == ".svg" || ext == ".bmp" || ext == ".ico"
	if !isImage {
		// Sandbox file preview — block scripts in PDFs/etc from accessing page context (localStorage tokens)
		c.Header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:")
	}
	filename := filepath.Base(fullPath)
	sanitized := strings.Map(func(r rune) rune {
		if r == '"' || r == '\\' || r == '\n' || r == '\r' {
			return '_'
		}
		return r
	}, filename)
	c.Header("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, sanitized))
	c.File(fullPath)
}

// ConvertToPDF converts a DOCX file to PDF using LibreOffice and serves the result.
// Uses caching based on file modification time to avoid re-conversion.
func (h *FilesHandler) ConvertToPDF(c *gin.Context) {
	requestedPath := c.Query("path")
	if requestedPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path required"})
		return
	}

	fullPath, err := h.safePathForUser(requestedPath, c)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	ext := strings.ToLower(filepath.Ext(fullPath))
	if ext != ".docx" && ext != ".doc" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Only .docx/.doc files supported"})
		return
	}

	info, err := os.Stat(fullPath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}

	if info.Size() > 50*1024*1024 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "File too large (max 50MB)"})
		return
	}

	// Cache key based on file path + mod time
	cacheDir := "/tmp/nebulide-pdf-cache"
	os.MkdirAll(cacheDir, 0755)
	cacheKey := md5Hash(fullPath + info.ModTime().String())
	cachedPdf := filepath.Join(cacheDir, cacheKey+".pdf")

	// Check cache
	if _, err := os.Stat(cachedPdf); err == nil {
		servePDF(c, cachedPdf, filepath.Base(fullPath))
		return
	}

	// Convert using LibreOffice
	tmpDir, err := os.MkdirTemp("", "lo-convert-*")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create temp dir"})
		return
	}
	defer os.RemoveAll(tmpDir)

	cmd := exec.Command("libreoffice", "--headless", "--norestore", "--convert-to", "pdf", "--outdir", tmpDir, fullPath)
	cmd.Env = append(os.Environ(), "HOME=/tmp")
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Conversion failed: %s", string(output))})
		return
	}

	// Find generated PDF
	baseName := strings.TrimSuffix(filepath.Base(fullPath), filepath.Ext(fullPath)) + ".pdf"
	generatedPdf := filepath.Join(tmpDir, baseName)
	if _, err := os.Stat(generatedPdf); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Converted PDF not found"})
		return
	}

	// Move to cache
	if err := copyFileContents(generatedPdf, cachedPdf); err != nil {
		// Serve from tmp if cache write fails
		servePDF(c, generatedPdf, filepath.Base(fullPath))
		return
	}

	servePDF(c, cachedPdf, filepath.Base(fullPath))
}

func servePDF(c *gin.Context, pdfPath, origName string) {
	pdfName := strings.TrimSuffix(origName, filepath.Ext(origName)) + ".pdf"
	c.Header("Content-Type", "application/pdf")
	c.Header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:")
	c.Header("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, pdfName))
	c.File(pdfPath)
}

func copyFileContents(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func md5Hash(s string) string {
	h := md5.Sum([]byte(s))
	return fmt.Sprintf("%x", h)
}

// ---------- Copy ----------

type copyRequest struct {
	Source      string `json:"source" binding:"required"`
	Destination string `json:"destination" binding:"required"`
}

func (h *FilesHandler) Copy(c *gin.Context) {
	var req copyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	fullSrc, err := h.safePathForUser(req.Source, c)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	fullDest, err := h.safePathForUser(req.Destination, c)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	srcInfo, err := os.Stat(fullSrc)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Source not found"})
		return
	}

	if _, err := os.Stat(fullDest); err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "Destination already exists"})
		return
	}

	if srcInfo.IsDir() {
		err = copyDir(fullSrc, fullDest)
	} else {
		err = copyFileOnDisk(fullSrc, fullDest)
	}

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to copy"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Copied", "path": req.Destination})
}

// isCrossDevice checks if an error is EXDEV (cross-device link).
func isCrossDevice(err error) bool {
	var linkErr *os.LinkError
	if errors.As(err, &linkErr) {
		return linkErr.Err == syscall.EXDEV
	}
	return false
}

func copyFileOnDisk(src, dst string) error {
	os.MkdirAll(filepath.Dir(dst), 0755)
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func copyDir(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		return copyFileOnDisk(path, target)
	})
}

// ---------- Download (attachment) ----------

// Download serves a file as attachment (browser download).
// For directories, creates a zip archive on-the-fly.
func (h *FilesHandler) Download(c *gin.Context) {
	requestedPath := c.Query("path")
	if requestedPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path required"})
		return
	}

	fullPath, err := h.safePathForUser(requestedPath, c)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	info, err := os.Stat(fullPath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Not found"})
		return
	}

	baseName := filepath.Base(fullPath)

	if !info.IsDir() {
		// Single file — serve as attachment
		c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, sanitizeFilename(baseName)))
		c.File(fullPath)
		return
	}

	// Directory — stream as zip
	c.Header("Content-Type", "application/zip")
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.zip"`, sanitizeFilename(baseName)))
	c.Status(http.StatusOK)

	zw := zip.NewWriter(c.Writer)
	defer zw.Close()

	filepath.WalkDir(fullPath, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, _ := filepath.Rel(fullPath, path)
		if rel == "." {
			return nil
		}
		if d.IsDir() {
			_, err := zw.Create(rel + "/")
			return err
		}
		w, err := zw.Create(rel)
		if err != nil {
			return err
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(w, f)
		return err
	})
}

func sanitizeFilename(name string) string {
	return strings.Map(func(r rune) rune {
		if r == '"' || r == '\\' || r == '\n' || r == '\r' {
			return '_'
		}
		return r
	}, name)
}

// safePath ensures the requested path is within the allowed working directory
// ---------- Search ----------

type SearchMatch struct {
	LineNumber int    `json:"line_number"`
	Content    string `json:"content"`
}

type SearchResult struct {
	Path    string        `json:"path"`
	IsDir   bool          `json:"is_dir"`
	Matches []SearchMatch `json:"matches,omitempty"`
}

// SearchFiles recursively searches files by name or content.
// Query params: q (required), type (name|content, default content), include, exclude
func (h *FilesHandler) SearchFiles(c *gin.Context) {
	query := c.Query("q")
	if query == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Query required"})
		return
	}

	searchType := c.DefaultQuery("type", "content")
	includeGlob := c.Query("include")
	excludeGlob := c.Query("exclude")

	userDir := h.getUserDir(c)
	basePath, err := h.safePathWithBase(userDir, userDir)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	queryLower := strings.ToLower(query)
	var results []SearchResult
	totalMatches := 0
	maxFiles := 100
	maxMatches := 500

	// Directories to skip
	skipDirs := map[string]bool{
		".git": true, "node_modules": true, "__pycache__": true,
		".next": true, "dist": true, "build": true, ".cache": true,
		"vendor": true, ".venv": true, "venv": true,
	}

	filepath.WalkDir(basePath, func(path string, d fs.DirEntry, err error) error {
		if err != nil || len(results) >= maxFiles || totalMatches >= maxMatches {
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		name := d.Name()

		// Skip hidden files/dirs
		if strings.HasPrefix(name, ".") && path != basePath {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		// Skip known heavy directories
		if d.IsDir() && skipDirs[name] {
			return filepath.SkipDir
		}

		// Compute relative path for display
		relPath, _ := filepath.Rel(basePath, path)
		displayPath := filepath.Join(userDir, relPath)

		// Apply include/exclude globs (on filename)
		if includeGlob != "" {
			matched, _ := filepath.Match(includeGlob, name)
			if !matched {
				if d.IsDir() {
					return nil // don't skip dirs — children may match
				}
				return nil
			}
		}
		if excludeGlob != "" {
			matched, _ := filepath.Match(excludeGlob, name)
			if matched {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
		}

		if searchType == "name" {
			// Search by filename
			if strings.Contains(strings.ToLower(name), queryLower) {
				results = append(results, SearchResult{
					Path:  displayPath,
					IsDir: d.IsDir(),
				})
				totalMatches++
			}
		} else {
			// Search by content — skip directories and large/binary files
			if d.IsDir() {
				return nil
			}

			info, err := d.Info()
			if err != nil || info.Size() > 1024*1024 { // Skip > 1MB
				return nil
			}

			data, err := os.ReadFile(path)
			if err != nil {
				return nil
			}

			// Skip binary files (check first 512 bytes for null bytes)
			checkLen := len(data)
			if checkLen > 512 {
				checkLen = 512
			}
			for i := 0; i < checkLen; i++ {
				if data[i] == 0 {
					return nil // binary file
				}
			}

			content := string(data)
			contentLower := strings.ToLower(content)

			if !strings.Contains(contentLower, queryLower) {
				return nil
			}

			lines := strings.Split(content, "\n")
			var matches []SearchMatch
			for i, line := range lines {
				if totalMatches >= maxMatches {
					break
				}
				if strings.Contains(strings.ToLower(line), queryLower) {
					// Truncate long lines
					displayLine := line
					if len(displayLine) > 200 {
						displayLine = displayLine[:200] + "..."
					}
					matches = append(matches, SearchMatch{
						LineNumber: i + 1,
						Content:    displayLine,
					})
					totalMatches++
				}
			}

			if len(matches) > 0 {
				results = append(results, SearchResult{
					Path:    displayPath,
					Matches: matches,
				})
			}
		}

		return nil
	})

	c.JSON(http.StatusOK, gin.H{"results": results})
}

// Extract unpacks a zip or rar archive into the same directory.
func (h *FilesHandler) Extract(c *gin.Context) {
	var req struct {
		Path string `json:"path" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	fullPath, err := h.safePathForUser(req.Path, c)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	info, err := os.Stat(fullPath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}
	if info.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Cannot extract a directory"})
		return
	}

	// Determine archive type
	ext := strings.ToLower(filepath.Ext(fullPath))
	destDir := filepath.Dir(fullPath)

	// Use archive name as subfolder to avoid cluttering parent
	baseName := strings.TrimSuffix(filepath.Base(fullPath), filepath.Ext(fullPath))
	extractDir := filepath.Join(destDir, baseName)

	// If folder already exists, add suffix
	if _, err := os.Stat(extractDir); err == nil {
		for i := 2; ; i++ {
			extractDir = filepath.Join(destDir, fmt.Sprintf("%s(%d)", baseName, i))
			if _, err := os.Stat(extractDir); os.IsNotExist(err) {
				break
			}
		}
	}

	// Verify extractDir stays within sandbox
	if _, err := h.safePathForUser(extractDir, c); err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	switch ext {
	case ".zip":
		if err := extractZip(fullPath, extractDir); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to extract: " + err.Error()})
			return
		}
	case ".rar":
		if err := extractRar(fullPath, extractDir); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to extract: " + err.Error()})
			return
		}
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported archive format. Supported: .zip, .rar"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Extracted", "path": extractDir})
}

func extractZip(archivePath, destDir string) error {
	r, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer r.Close()

	for _, f := range r.File {
		// Prevent zip slip
		target := filepath.Join(destDir, f.Name)
		if !strings.HasPrefix(filepath.Clean(target), filepath.Clean(destDir)+string(os.PathSeparator)) && filepath.Clean(target) != filepath.Clean(destDir) {
			continue
		}

		if f.FileInfo().IsDir() {
			os.MkdirAll(target, 0755)
			continue
		}

		os.MkdirAll(filepath.Dir(target), 0755)
		outFile, err := os.Create(target)
		if err != nil {
			return err
		}

		rc, err := f.Open()
		if err != nil {
			outFile.Close()
			return err
		}

		_, err = io.Copy(outFile, io.LimitReader(rc, 500*1024*1024)) // 500MB per file limit
		rc.Close()
		outFile.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func extractRar(archivePath, destDir string) error {
	r, err := rardecode.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer r.Close()

	for {
		header, err := r.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}

		target := filepath.Join(destDir, header.Name)
		// Prevent path traversal
		if !strings.HasPrefix(filepath.Clean(target), filepath.Clean(destDir)+string(os.PathSeparator)) && filepath.Clean(target) != filepath.Clean(destDir) {
			continue
		}

		if header.IsDir {
			os.MkdirAll(target, 0755)
			continue
		}

		os.MkdirAll(filepath.Dir(target), 0755)
		outFile, err := os.Create(target)
		if err != nil {
			return err
		}

		_, err = io.Copy(outFile, io.LimitReader(r, 500*1024*1024))
		outFile.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func (h *FilesHandler) safePath(requestedPath string) (string, error) {
	return h.safePathWithBase(requestedPath, h.cfg.ClaudeWorkingDir)
}

func (h *FilesHandler) safePathForUser(requestedPath string, c *gin.Context) (string, error) {
	if r, err := h.safePathWithBase(requestedPath, h.getUserDir(c)); err == nil {
		return r, nil
	}
	// Fallback: allow access to shared folder
	return h.safePathWithBase(requestedPath, h.cfg.SharedDir)
}

func (h *FilesHandler) safePathWithBase(requestedPath string, baseDir string) (string, error) {
	// Clean and resolve the path
	cleaned := filepath.Clean(requestedPath)

	// If it's a relative path, join with base dir
	if !filepath.IsAbs(cleaned) {
		cleaned = filepath.Join(baseDir, cleaned)
	}

	// Resolve to absolute
	absPath, err := filepath.Abs(cleaned)
	if err != nil {
		return "", err
	}

	// Resolve symlinks to prevent symlink-based sandbox escape.
	// A user could create a symlink workspace/escape -> /etc and bypass the prefix check.
	// EvalSymlinks only works if the path exists; for new files, resolve the parent.
	resolved := absPath
	if r, err := filepath.EvalSymlinks(absPath); err == nil {
		resolved = r
	} else if r, err := filepath.EvalSymlinks(filepath.Dir(absPath)); err == nil {
		resolved = filepath.Join(r, filepath.Base(absPath))
	}

	// Ensure it's within allowed directory
	allowedBase, err := filepath.Abs(baseDir)
	if err != nil {
		return "", err
	}
	// Also resolve symlinks in the base directory itself
	if r, err := filepath.EvalSymlinks(allowedBase); err == nil {
		allowedBase = r
	}

	// Must be exactly the base or a child path (with separator).
	// Without the separator check, /workspaces/alice would match /workspaces/alicebob.
	if resolved != allowedBase && !strings.HasPrefix(resolved, allowedBase+string(filepath.Separator)) {
		return "", fs.ErrPermission
	}

	return absPath, nil
}
