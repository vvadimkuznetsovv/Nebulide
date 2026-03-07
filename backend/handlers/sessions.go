package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"nebulide/config"
	"nebulide/database"
	"nebulide/models"
)

type SessionsHandler struct {
	cfg *config.Config
}

func NewSessionsHandler(cfg *config.Config) *SessionsHandler {
	return &SessionsHandler{cfg: cfg}
}

type createSessionRequest struct {
	Title            string `json:"title"`
	WorkingDirectory string `json:"working_directory"`
}

func (h *SessionsHandler) List(c *gin.Context) {
	userID, _ := c.Get("user_id")

	var sessions []models.ChatSession
	database.DB.Where("user_id = ?", userID).
		Order("updated_at DESC").
		Find(&sessions)

	c.JSON(http.StatusOK, sessions)
}

func (h *SessionsHandler) Create(c *gin.Context) {
	var req createSessionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		req.Title = "New Chat"
	}

	userID, _ := c.Get("user_id")

	if req.Title == "" {
		req.Title = "New Chat"
	}
	if req.WorkingDirectory == "" {
		username, _ := c.Get("username")
		if u, ok := username.(string); ok && u != "" && u != h.cfg.AdminUsername {
			req.WorkingDirectory = h.cfg.GetUserWorkspaceDir(u)
		} else {
			req.WorkingDirectory = h.cfg.ClaudeWorkingDir
		}
	}

	session := models.ChatSession{
		UserID:           userID.(uuid.UUID),
		Title:            req.Title,
		WorkingDirectory: req.WorkingDirectory,
	}

	if err := database.DB.Create(&session).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create session"})
		return
	}

	c.JSON(http.StatusCreated, session)
}

func (h *SessionsHandler) Delete(c *gin.Context) {
	sessionID := c.Param("id")
	userID, _ := c.Get("user_id")

	result := database.DB.Where("id = ? AND user_id = ?", sessionID, userID).
		Delete(&models.ChatSession{})

	if result.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Session deleted"})
}

func (h *SessionsHandler) Messages(c *gin.Context) {
	sessionID := c.Param("id")
	userID, _ := c.Get("user_id")

	var session models.ChatSession
	if err := database.DB.Where("id = ? AND user_id = ?", sessionID, userID).First(&session).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	var messages []models.Message
	database.DB.Where("session_id = ?", sessionID).
		Order("created_at ASC").
		Find(&messages)

	c.JSON(http.StatusOK, messages)
}

func (h *SessionsHandler) Update(c *gin.Context) {
	sessionID := c.Param("id")
	userID, _ := c.Get("user_id")

	var req createSessionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	var session models.ChatSession
	if err := database.DB.Where("id = ? AND user_id = ?", sessionID, userID).First(&session).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	if req.Title != "" {
		session.Title = req.Title
	}
	if req.WorkingDirectory != "" {
		session.WorkingDirectory = req.WorkingDirectory
	}

	database.DB.Save(&session)
	c.JSON(http.StatusOK, session)
}
