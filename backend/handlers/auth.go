package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"

	"nebulide/config"
	"nebulide/database"
	"nebulide/models"
	"nebulide/services"
	"nebulide/utils"
)

type AuthHandler struct {
	cfg     *config.Config
	lockout *services.LoginLockout
}

func NewAuthHandler(cfg *config.Config, lockout *services.LoginLockout) *AuthHandler {
	return &AuthHandler{cfg: cfg, lockout: lockout}
}

type loginRequest struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
}

type totpVerifyRequest struct {
	Code string `json:"code" binding:"required"`
}

type refreshRequest struct {
	RefreshToken string `json:"refresh_token" binding:"required"`
}

func (h *AuthHandler) Login(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	// Check lockout BEFORE any DB/bcrypt work
	if locked, remaining := h.lockout.IsLocked(c.Request.Context(), req.Username); locked {
		c.JSON(http.StatusTooManyRequests, gin.H{
			"error":               "Account temporarily locked due to too many failed attempts",
			"retry_after_seconds": remaining,
		})
		return
	}

	// Dummy hash for constant-time response when user not found (prevents timing-based user enumeration)
	dummyHash := []byte("$2a$10$0000000000000000000000uAAAAAAAAAAAAAAAAAAAAAAAAAAAA")

	var user models.User
	userFound := database.DB.Where("username = ?", req.Username).First(&user).Error == nil

	if !userFound {
		// Run bcrypt anyway so response time is the same as for existing users
		bcrypt.CompareHashAndPassword(dummyHash, []byte(req.Password))
		h.lockout.RecordFailure(c.Request.Context(), req.Username)
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid credentials"})
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
		h.lockout.RecordFailure(c.Request.Context(), req.Username)
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid credentials"})
		return
	}

	// Clear lockout on success
	h.lockout.RecordSuccess(c.Request.Context(), req.Username)

	if user.TOTPEnabled {
		// Issue partial token — TOTP verification still needed
		token, err := utils.GenerateAccessToken(h.cfg.JWTSecret, user.ID, user.Username, true, 5*time.Minute)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate token"})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"requires_totp": true,
			"partial_token": token,
		})
		return
	}

	// No TOTP — issue full tokens
	h.issueFullTokens(c, user)
}

func (h *AuthHandler) TOTPVerify(c *gin.Context) {
	var req totpVerifyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	userID, _ := c.Get("user_id")

	var user models.User
	if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}

	if !services.ValidateTOTP(user.TOTPSecret, req.Code) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid TOTP code"})
		return
	}

	h.issueFullTokens(c, user)
}

func (h *AuthHandler) TOTPSetup(c *gin.Context) {
	userID, _ := c.Get("user_id")
	username, _ := c.Get("username")

	var user models.User
	if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}

	if user.TOTPEnabled {
		c.JSON(http.StatusBadRequest, gin.H{"error": "TOTP already enabled"})
		return
	}

	key, err := services.GenerateTOTPSecret(username.(string))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate TOTP secret"})
		return
	}

	user.TOTPSecret = key.Secret()
	database.DB.Save(&user)

	c.JSON(http.StatusOK, gin.H{
		"secret":   key.Secret(),
		"url":      key.URL(),
		"qr_image": key.URL(),
	})
}

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password" binding:"required"`
	NewPassword     string `json:"new_password" binding:"required"`
}

type totpConfirmRequest struct {
	Code string `json:"code" binding:"required"`
}

func (h *AuthHandler) TOTPConfirm(c *gin.Context) {
	var req totpConfirmRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	userID, _ := c.Get("user_id")

	var user models.User
	if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}

	if !services.ValidateTOTP(user.TOTPSecret, req.Code) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid TOTP code"})
		return
	}

	user.TOTPEnabled = true
	database.DB.Save(&user)

	c.JSON(http.StatusOK, gin.H{"message": "TOTP enabled successfully"})
}

func (h *AuthHandler) ChangePassword(c *gin.Context) {
	var req changePasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	userID, _ := c.Get("user_id")

	var user models.User
	if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.CurrentPassword)); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Current password is incorrect"})
		return
	}

	if len(req.NewPassword) < 6 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "New password must be at least 6 characters"})
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to hash password"})
		return
	}

	user.PasswordHash = string(hash)
	database.DB.Save(&user)

	c.JSON(http.StatusOK, gin.H{"message": "Password changed successfully"})
}

func (h *AuthHandler) Refresh(c *gin.Context) {
	var req refreshRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	tokenHash := utils.HashToken(req.RefreshToken)

	var rt models.RefreshToken
	if err := database.DB.Where("token_hash = ? AND expires_at > ?", tokenHash, time.Now()).First(&rt).Error; err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid refresh token"})
		return
	}

	var user models.User
	if err := database.DB.First(&user, "id = ?", rt.UserID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}

	// Generate new tokens
	accessToken, err := utils.GenerateAccessToken(h.cfg.JWTSecret, user.ID, user.Username, false, h.cfg.JWTExpiry)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate access token"})
		return
	}

	refreshToken, refreshHash, err := utils.GenerateRefreshToken()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate refresh token"})
		return
	}

	newRT := models.RefreshToken{
		ID:        uuid.New(),
		UserID:    user.ID,
		TokenHash: refreshHash,
		ExpiresAt: time.Now().Add(h.cfg.JWTRefreshExpiry),
	}

	// Atomic: delete old token + create new token in one transaction
	tx := database.DB.Begin()
	if err := tx.Delete(&rt).Error; err != nil {
		tx.Rollback()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Token rotation failed"})
		return
	}
	if err := tx.Create(&newRT).Error; err != nil {
		tx.Rollback()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Token rotation failed"})
		return
	}
	tx.Commit()

	c.JSON(http.StatusOK, gin.H{
		"access_token":  accessToken,
		"refresh_token": refreshToken,
		"user": gin.H{
			"id":           user.ID,
			"username":     user.Username,
			"totp_enabled": user.TOTPEnabled,
		},
	})
}

func (h *AuthHandler) Logout(c *gin.Context) {
	userID, _ := c.Get("user_id")
	database.DB.Where("user_id = ?", userID).Delete(&models.RefreshToken{})
	c.JSON(http.StatusOK, gin.H{"message": "Logged out"})
}

func (h *AuthHandler) Me(c *gin.Context) {
	userID, _ := c.Get("user_id")
	var user models.User
	if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"id":            user.ID,
		"username":      user.Username,
		"totp_enabled":  user.TOTPEnabled,
		"is_admin":      user.IsAdmin,
		"telegram_id":   user.TelegramID,
		"shared_dir":    h.cfg.SharedDir,
		"workspace_dir": func() string {
			if user.IsAdmin {
				return h.cfg.ClaudeWorkingDir
			}
			return h.cfg.GetUserWorkspaceDir(user.Username)
		}(),
	})
}

func (h *AuthHandler) UpdateTelegramID(c *gin.Context) {
	var req struct {
		TelegramID int64 `json:"telegram_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	userID, _ := c.Get("user_id")

	// Check uniqueness — prevent two users from claiming the same Telegram ID
	if req.TelegramID != 0 {
		var existing models.User
		if err := database.DB.Where("telegram_id = ? AND id != ?", req.TelegramID, userID).First(&existing).Error; err == nil {
			c.JSON(http.StatusConflict, gin.H{"error": "This Telegram ID is already linked to another account"})
			return
		}
	}

	if err := database.DB.Model(&models.User{}).Where("id = ?", userID).Update("telegram_id", req.TelegramID).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Telegram ID updated", "telegram_id": req.TelegramID})
}

func (h *AuthHandler) GetTheme(c *gin.Context) {
	userID, _ := c.Get("user_id")
	var user models.User
	if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}
	themeJSON := user.ThemeJSON
	if themeJSON == "" || themeJSON == "{}" {
		themeJSON = `{"accent_color":"#7F00FF","blobs_enabled":true}`
	}
	c.Data(http.StatusOK, "application/json", []byte(themeJSON))
}

func (h *AuthHandler) UpdateTheme(c *gin.Context) {
	var req struct {
		AccentColor  string `json:"accent_color"`
		BlobsEnabled *bool  `json:"blobs_enabled"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}
	// Validate accent color (hex format)
	if req.AccentColor != "" && (len(req.AccentColor) != 7 || req.AccentColor[0] != '#') {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid color format"})
		return
	}

	userID, _ := c.Get("user_id")

	// Build JSON manually to keep it simple
	blobsVal := "true"
	if req.BlobsEnabled != nil && !*req.BlobsEnabled {
		blobsVal = "false"
	}
	accent := req.AccentColor
	if accent == "" {
		accent = "#7F00FF"
	}
	themeJSON := `{"accent_color":"` + accent + `","blobs_enabled":` + blobsVal + `}`

	if err := database.DB.Model(&models.User{}).Where("id = ?", userID).Update("theme_json", themeJSON).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save theme"})
		return
	}
	c.Data(http.StatusOK, "application/json", []byte(themeJSON))
}

func (h *AuthHandler) GetPreferences(c *gin.Context) {
	userID, _ := c.Get("user_id")
	var user models.User
	if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}
	prefs := user.PreferencesJSON
	if prefs == "" || prefs == "{}" {
		prefs = "{}"
	}
	c.Data(http.StatusOK, "application/json", []byte(prefs))
}

func (h *AuthHandler) UpdatePreferences(c *gin.Context) {
	raw, err := io.ReadAll(io.LimitReader(c.Request.Body, 50_000))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}
	if !json.Valid(raw) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON"})
		return
	}
	userID, _ := c.Get("user_id")
	if err := database.DB.Model(&models.User{}).Where("id = ?", userID).
		Update("preferences_json", string(raw)).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save preferences"})
		return
	}
	c.Data(http.StatusOK, "application/json", raw)
}

func (h *AuthHandler) issueFullTokens(c *gin.Context, user models.User) {
	accessToken, err := utils.GenerateAccessToken(h.cfg.JWTSecret, user.ID, user.Username, false, h.cfg.JWTExpiry)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate access token"})
		return
	}

	refreshToken, refreshHash, err := utils.GenerateRefreshToken()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate refresh token"})
		return
	}

	rt := models.RefreshToken{
		ID:        uuid.New(),
		UserID:    user.ID,
		TokenHash: refreshHash,
		ExpiresAt: time.Now().Add(h.cfg.JWTRefreshExpiry),
	}
	if err := database.DB.Create(&rt).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to persist refresh token"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"access_token":  accessToken,
		"refresh_token": refreshToken,
		"user": gin.H{
			"id":           user.ID,
			"username":     user.Username,
			"totp_enabled": user.TOTPEnabled,
		},
	})
}
