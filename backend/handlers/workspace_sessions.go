package handlers

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/datatypes"

	"nebulide/config"
	"nebulide/database"
	"nebulide/models"
)

type WorkspaceSessionsHandler struct {
	cfg *config.Config
}

func NewWorkspaceSessionsHandler(cfg *config.Config) *WorkspaceSessionsHandler {
	return &WorkspaceSessionsHandler{cfg: cfg}
}

type createWorkspaceSessionRequest struct {
	Name      string         `json:"name"`
	DeviceTag string         `json:"device_tag"`
	Snapshot  datatypes.JSON `json:"snapshot"`
}

type updateWorkspaceSessionRequest struct {
	Name     string         `json:"name"`
	Snapshot datatypes.JSON `json:"snapshot"`
}

// List returns all workspace sessions for the current user.
func (h *WorkspaceSessionsHandler) List(c *gin.Context) {
	userID, _ := c.Get("user_id")

	var sessions []models.WorkspaceSession
	database.DB.Where("user_id = ?", userID).
		Order("updated_at DESC").
		Find(&sessions)

	c.JSON(http.StatusOK, sessions)
}

// Latest returns the most recently updated workspace session.
func (h *WorkspaceSessionsHandler) Latest(c *gin.Context) {
	userID, _ := c.Get("user_id")

	var session models.WorkspaceSession
	if err := database.DB.Where("user_id = ?", userID).
		Order("updated_at DESC").
		First(&session).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "No workspace sessions found"})
		return
	}

	c.JSON(http.StatusOK, session)
}

// Create creates a new workspace session.
func (h *WorkspaceSessionsHandler) Create(c *gin.Context) {
	var req createWorkspaceSessionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	userID, _ := c.Get("user_id")

	if req.Name == "" {
		req.Name = "New Workspace"
	}
	if req.Snapshot == nil {
		req.Snapshot = datatypes.JSON(`{}`)
	}

	session := models.WorkspaceSession{
		UserID:    userID.(uuid.UUID),
		Name:      req.Name,
		DeviceTag: req.DeviceTag,
		Snapshot:  req.Snapshot,
	}

	if err := database.DB.Create(&session).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create workspace session"})
		return
	}

	h.publishEvent(userID.(uuid.UUID), "created", session.ID)
	c.JSON(http.StatusCreated, session)
}

// Update updates a workspace session's name and/or snapshot.
func (h *WorkspaceSessionsHandler) Update(c *gin.Context) {
	sessionID := c.Param("id")
	userID, _ := c.Get("user_id")

	var req updateWorkspaceSessionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	var session models.WorkspaceSession
	if err := database.DB.Where("id = ? AND user_id = ?", sessionID, userID).First(&session).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace session not found"})
		return
	}

	if req.Name != "" {
		session.Name = req.Name
	}
	if req.Snapshot != nil {
		session.Snapshot = req.Snapshot
	}

	database.DB.Save(&session)

	h.publishEvent(userID.(uuid.UUID), "updated", session.ID)
	c.JSON(http.StatusOK, session)
}

// Delete removes a workspace session.
func (h *WorkspaceSessionsHandler) Delete(c *gin.Context) {
	sessionID := c.Param("id")
	userID, _ := c.Get("user_id")

	result := database.DB.Where("id = ? AND user_id = ?", sessionID, userID).
		Delete(&models.WorkspaceSession{})

	if result.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace session not found"})
		return
	}

	parsedID, _ := uuid.Parse(sessionID)
	h.publishEvent(userID.(uuid.UUID), "deleted", parsedID)
	c.JSON(http.StatusOK, gin.H{"message": "Workspace session deleted"})
}

// publishEvent sends a workspace change event to Redis pub/sub.
func (h *WorkspaceSessionsHandler) publishEvent(userID uuid.UUID, action string, sessionID uuid.UUID) {
	if database.RDB == nil {
		return
	}

	event := map[string]string{
		"type":       "workspace_session_changed",
		"action":     action,
		"session_id": sessionID.String(),
	}
	data, _ := json.Marshal(event)
	database.RDB.Publish(context.Background(), "ws:user:"+userID.String(), string(data))
}
