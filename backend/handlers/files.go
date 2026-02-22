package handlers

import (
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"

	"clauder/config"
)

type FilesHandler struct {
	cfg *config.Config
}

func NewFilesHandler(cfg *config.Config) *FilesHandler {
	return &FilesHandler{cfg: cfg}
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
	requestedPath := c.Query("path")
	if requestedPath == "" {
		requestedPath = h.cfg.ClaudeWorkingDir
	}

	fullPath, err := h.safePath(requestedPath)
	if err != nil {
		// Path may be from a different OS — fallback to configured working dir
		requestedPath = h.cfg.ClaudeWorkingDir
		fullPath, err = h.safePath(requestedPath)
		if err != nil {
			c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
			return
		}
	}

	entries, err := os.ReadDir(fullPath)
	if err != nil {
		// Directory doesn't exist — fallback to configured working dir
		if requestedPath != h.cfg.ClaudeWorkingDir {
			requestedPath = h.cfg.ClaudeWorkingDir
			fullPath, _ = h.safePath(requestedPath)
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

	fullPath, err := h.safePath(requestedPath)
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

	fullPath, err := h.safePath(req.Path)
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

func (h *FilesHandler) Delete(c *gin.Context) {
	requestedPath := c.Query("path")
	if requestedPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path required"})
		return
	}

	fullPath, err := h.safePath(requestedPath)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
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

	fullPath, err := h.safePath(req.Path)
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

	fullOldPath, err := h.safePath(req.OldPath)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	fullNewPath, err := h.safePath(req.NewPath)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	if _, err := os.Stat(fullOldPath); os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "Source not found"})
		return
	}

	if _, err := os.Stat(fullNewPath); err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "Target already exists"})
		return
	}

	if err := os.Rename(fullOldPath, fullNewPath); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to rename"})
		return
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

	fullPath, err := h.safePath(requestedPath)
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
	}
	contentType, ok := contentTypes[ext]
	if !ok {
		contentType = "application/octet-stream"
	}

	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, filepath.Base(fullPath)))
	c.File(fullPath)
}

// safePath ensures the requested path is within the allowed working directory
func (h *FilesHandler) safePath(requestedPath string) (string, error) {
	// Clean and resolve the path
	cleaned := filepath.Clean(requestedPath)

	// If it's a relative path, join with working dir
	if !filepath.IsAbs(cleaned) {
		cleaned = filepath.Join(h.cfg.ClaudeWorkingDir, cleaned)
	}

	// Resolve to absolute
	absPath, err := filepath.Abs(cleaned)
	if err != nil {
		return "", err
	}

	// Ensure it's within allowed directory
	allowedBase, err := filepath.Abs(h.cfg.ClaudeWorkingDir)
	if err != nil {
		return "", err
	}

	if !strings.HasPrefix(absPath, allowedBase) {
		return "", fs.ErrPermission
	}

	return absPath, nil
}
