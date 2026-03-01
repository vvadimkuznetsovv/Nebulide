package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	"nebulide/config"
	"nebulide/database"
	"nebulide/models"
	"nebulide/services"
)

type InviteHandler struct {
	cfg     *config.Config
	lockout *services.LoginLockout
}

func NewInviteHandler(cfg *config.Config, lockout *services.LoginLockout) *InviteHandler {
	return &InviteHandler{cfg: cfg, lockout: lockout}
}

type createInviteRequest struct {
	ExpiresInHours int `json:"expires_in_hours"`
}

type registerRequest struct {
	Username   string `json:"username" binding:"required"`
	Password   string `json:"password" binding:"required"`
	InviteCode string `json:"invite_code" binding:"required"`
}

// CreateInvite generates a new invite code (admin only).
func (h *InviteHandler) CreateInvite(c *gin.Context) {
	userID, _ := c.Get("user_id")

	var user models.User
	if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}
	if !user.IsAdmin {
		c.JSON(http.StatusForbidden, gin.H{"error": "Admin access required"})
		return
	}

	var req createInviteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		req.ExpiresInHours = 72 // 3 days default
	}
	if req.ExpiresInHours <= 0 {
		req.ExpiresInHours = 72
	}

	code := generateInviteCode()

	invite := models.Invite{
		Code:      code,
		CreatedBy: user.ID,
		ExpiresAt: time.Now().Add(time.Duration(req.ExpiresInHours) * time.Hour),
	}

	if err := database.DB.Create(&invite).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create invite"})
		return
	}

	c.JSON(http.StatusCreated, invite)
}

// ListInvites returns all invite codes (admin only).
func (h *InviteHandler) ListInvites(c *gin.Context) {
	userID, _ := c.Get("user_id")

	var user models.User
	if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}
	if !user.IsAdmin {
		c.JSON(http.StatusForbidden, gin.H{"error": "Admin access required"})
		return
	}

	var invites []models.Invite
	database.DB.Order("created_at DESC").Find(&invites)

	c.JSON(http.StatusOK, invites)
}

// DeleteInvite revokes an invite code (admin only).
func (h *InviteHandler) DeleteInvite(c *gin.Context) {
	userID, _ := c.Get("user_id")
	inviteID := c.Param("id")

	var user models.User
	if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}
	if !user.IsAdmin {
		c.JSON(http.StatusForbidden, gin.H{"error": "Admin access required"})
		return
	}

	result := database.DB.Where("id = ?", inviteID).Delete(&models.Invite{})
	if result.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Invite not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Invite deleted"})
}

// Register creates a new user with a valid invite code (public endpoint).
func (h *InviteHandler) Register(c *gin.Context) {
	var req registerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	// Check lockout (same as login — prevent brute-force invite guessing)
	if locked, remaining := h.lockout.IsLocked(c.Request.Context(), "register:"+c.ClientIP()); locked {
		c.JSON(http.StatusTooManyRequests, gin.H{
			"error":               "Too many attempts, please try again later",
			"retry_after_seconds": remaining,
		})
		return
	}

	if len(req.Password) < 6 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Password must be at least 6 characters"})
		return
	}

	if len(req.Username) < 3 || len(req.Username) > 50 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Username must be 3-50 characters"})
		return
	}

	// Hash password before transaction (expensive, don't hold lock)
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create user"})
		return
	}

	// Transaction: validate invite + create user + mark used (atomically)
	var user models.User
	txErr := database.DB.Transaction(func(tx *gorm.DB) error {
		// Lock invite row to prevent concurrent use
		var invite models.Invite
		if err := tx.Set("gorm:query_option", "FOR UPDATE").
			Where("code = ? AND used_by IS NULL AND expires_at > ?", req.InviteCode, time.Now()).
			First(&invite).Error; err != nil {
			return fmt.Errorf("invite_invalid")
		}

		// Check if username taken
		var count int64
		tx.Model(&models.User{}).Where("username = ?", req.Username).Count(&count)
		if count > 0 {
			return fmt.Errorf("username_taken")
		}

		// Create user
		user = models.User{
			Username:     req.Username,
			PasswordHash: string(hash),
		}
		if err := tx.Create(&user).Error; err != nil {
			return fmt.Errorf("user_create_failed")
		}

		// Mark invite as used
		now := time.Now()
		if err := tx.Model(&invite).Updates(map[string]interface{}{
			"used_by": user.ID,
			"used_at": now,
		}).Error; err != nil {
			return fmt.Errorf("invite_update_failed")
		}

		return nil
	})

	if txErr != nil {
		switch txErr.Error() {
		case "invite_invalid":
			h.lockout.RecordFailure(c.Request.Context(), "register:"+c.ClientIP())
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid or expired invite code"})
		case "username_taken":
			c.JSON(http.StatusConflict, gin.H{"error": "Username already taken"})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create user"})
		}
		return
	}

	// Clear lockout on success
	h.lockout.RecordSuccess(c.Request.Context(), "register:"+c.ClientIP())

	c.JSON(http.StatusCreated, gin.H{
		"message": "Registration successful",
		"user": gin.H{
			"id":       user.ID,
			"username": user.Username,
		},
	})
}

func generateInviteCode() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}
