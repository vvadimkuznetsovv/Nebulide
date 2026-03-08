package handlers

import (
	"archive/zip"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"

	"nebulide/config"
	"nebulide/database"
	"nebulide/models"
	"nebulide/services"
	"nebulide/utils"
)

type TelegramHandler struct {
	cfg *config.Config
	bot *services.TelegramBot
}

func NewTelegramHandler(cfg *config.Config, bot *services.TelegramBot) *TelegramHandler {
	return &TelegramHandler{cfg: cfg, bot: bot}
}

type sendFileRequest struct {
	FilePath string `json:"file_path" binding:"required"`
}

// Send sends a file from the user's workspace (or shared folder) to their Telegram.
// Accepts both regular JWT and scoped "tg-send" tokens.
func (h *TelegramHandler) Send(c *gin.Context) {
	// Manual auth: accept regular tokens OR scoped tg-send tokens
	authHeader := c.GetHeader("Authorization")
	if authHeader == "" {
		token := c.Query("token")
		if token != "" {
			authHeader = "Bearer " + token
		}
	}
	if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Authorization required"})
		return
	}
	tokenString := strings.TrimPrefix(authHeader, "Bearer ")
	claims, err := utils.ParseToken(h.cfg.JWTSecret, tokenString)
	if err != nil || claims.Partial {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid token"})
		return
	}
	// Only allow regular tokens or purpose="tg-send"
	if claims.Purpose != "" && claims.Purpose != "tg-send" {
		c.JSON(http.StatusForbidden, gin.H{"error": "Token not authorized for this endpoint"})
		return
	}

	var req sendFileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	userID := claims.UserID
	username := claims.Username

	// Find user to get telegram_id
	var user models.User
	if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}

	if user.TelegramID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Telegram ID not set. Configure it in Settings."})
		return
	}

	// Resolve file path — must be in user workspace or shared folder
	filesHandler := NewFilesHandler(h.cfg)
	userDir := h.cfg.ClaudeWorkingDir
	if username != h.cfg.AdminUsername {
		userDir = h.cfg.GetUserWorkspaceDir(username)
	}

	fullPath, err := filesHandler.safePathWithBase(req.FilePath, userDir)
	if err != nil {
		// Try shared folder
		fullPath, err = filesHandler.safePathWithBase(req.FilePath, h.cfg.SharedDir)
		if err != nil {
			c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
			return
		}
	}

	// Check path exists
	info, err := os.Stat(fullPath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Not found"})
		return
	}

	sendPath := fullPath
	var tmpZip string

	// If directory — zip it first, then send the zip
	if info.IsDir() {
		tmpFile, err := os.CreateTemp("", "nebulide-tg-*.zip")
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create temp file"})
			return
		}
		tmpZip = tmpFile.Name()
		defer os.Remove(tmpZip)

		zw := zip.NewWriter(tmpFile)
		walkErr := filepath.WalkDir(fullPath, func(path string, d fs.DirEntry, wErr error) error {
			if wErr != nil {
				return wErr
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
		zw.Close()
		tmpFile.Close()

		if walkErr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to archive folder"})
			return
		}
		sendPath = tmpZip
	}

	if err := h.bot.SendFile(user.TelegramID, sendPath); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to send file: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Sent to Telegram"})
}
