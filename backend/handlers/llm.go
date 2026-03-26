package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"nebulide/config"
	"nebulide/database"
	"nebulide/models"
)

type LLMHandler struct {
	cfg *config.Config
}

func NewLLMHandler(cfg *config.Config) *LLMHandler {
	return &LLMHandler{cfg: cfg}
}

// ListSessions returns all LLM sessions for the user
func (h *LLMHandler) ListSessions(c *gin.Context) {
	userID := c.GetString("user_id")
	var sessions []models.LLMSession
	database.DB.Where("user_id = ?", userID).Order("updated_at DESC").Find(&sessions)
	c.JSON(http.StatusOK, sessions)
}

// CreateSession creates a new LLM chat session
func (h *LLMHandler) CreateSession(c *gin.Context) {
	userID := c.GetString("user_id")
	uid, _ := uuid.Parse(userID)

	var body struct {
		Title string `json:"title"`
		Model string `json:"model"`
	}
	c.ShouldBindJSON(&body)

	session := models.LLMSession{
		UserID: uid,
		Title:  body.Title,
		Model:  body.Model,
	}
	if session.Title == "" {
		session.Title = "New Chat"
	}
	if session.Model == "" {
		session.Model = "nvidia/llama-3.3-nemotron-super-49b-v1"
	}

	if err := database.DB.Create(&session).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create session"})
		return
	}
	c.JSON(http.StatusCreated, session)
}

// DeleteSession deletes a session and its messages
func (h *LLMHandler) DeleteSession(c *gin.Context) {
	userID := c.GetString("user_id")
	sessionID := c.Param("id")

	var session models.LLMSession
	if err := database.DB.Where("id = ? AND user_id = ?", sessionID, userID).First(&session).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	database.DB.Where("session_id = ?", session.ID).Delete(&models.LLMMessage{})
	database.DB.Delete(&session)
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}

// GetMessages returns all messages for a session
func (h *LLMHandler) GetMessages(c *gin.Context) {
	userID := c.GetString("user_id")
	sessionID := c.Param("id")

	var session models.LLMSession
	if err := database.DB.Where("id = ? AND user_id = ?", sessionID, userID).First(&session).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	var messages []models.LLMMessage
	database.DB.Where("session_id = ?", session.ID).Order("created_at ASC").Find(&messages)

	// Calculate total chars for context warning
	totalChars := 0
	for _, m := range messages {
		totalChars += len(m.Content)
	}
	c.JSON(http.StatusOK, gin.H{"messages": messages, "total_chars": totalChars})
}

// TrimContext marks old messages as out-of-context, keeping last N in context
func (h *LLMHandler) TrimContext(c *gin.Context) {
	userID := c.GetString("user_id")
	sessionID := c.Param("id")

	var body struct {
		Keep int `json:"keep"`
	}
	c.ShouldBindJSON(&body)
	if body.Keep < 2 {
		body.Keep = 20
	}

	var session models.LLMSession
	if err := database.DB.Where("id = ? AND user_id = ?", sessionID, userID).First(&session).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	// Get only in-context messages
	var messages []models.LLMMessage
	database.DB.Where("session_id = ? AND in_context = true", session.ID).Order("created_at ASC").Find(&messages)

	if len(messages) <= body.Keep {
		c.JSON(http.StatusOK, gin.H{"trimmed": 0, "in_context": len(messages)})
		return
	}

	toTrim := messages[:len(messages)-body.Keep]
	ids := make([]uuid.UUID, len(toTrim))
	for i, m := range toTrim {
		ids[i] = m.ID
	}
	database.DB.Model(&models.LLMMessage{}).Where("id IN ?", ids).Update("in_context", false)

	c.JSON(http.StatusOK, gin.H{"trimmed": len(toTrim), "in_context": body.Keep})
}

// Chat sends a message and streams NVIDIA API response
func (h *LLMHandler) Chat(c *gin.Context) {
	if h.cfg.NvidiaAPIKey == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "NVIDIA API key not configured"})
		return
	}

	userID := c.GetString("user_id")
	uid, _ := uuid.Parse(userID)

	var body struct {
		SessionID        string `json:"session_id" binding:"required"`
		Content          string `json:"content" binding:"required"`
		ImageDescription string `json:"image_description"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	sid, _ := uuid.Parse(body.SessionID)

	var session models.LLMSession
	if err := database.DB.Where("id = ? AND user_id = ?", sid, uid).First(&session).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	// Prepend image description if provided
	finalContent := body.Content
	if body.ImageDescription != "" {
		finalContent = "[Image description: " + body.ImageDescription + "]\n\n" + body.Content
	}

	// Save user message
	userMsg := models.LLMMessage{SessionID: sid, Role: "user", Content: finalContent}
	database.DB.Create(&userMsg)

	// Build messages array from history (only in-context)
	var history []models.LLMMessage
	database.DB.Where("session_id = ? AND in_context = true", sid).Order("created_at ASC").Find(&history)

	type apiMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	msgs := make([]apiMsg, len(history))
	for i, m := range history {
		msgs[i] = apiMsg{Role: m.Role, Content: m.Content}
	}

	reqBody, _ := json.Marshal(map[string]interface{}{
		"model":      session.Model,
		"messages":   msgs,
		"stream":     true,
		"max_tokens": 32768,
	})

	req, _ := http.NewRequest("POST", "https://integrate.api.nvidia.com/v1/chat/completions", bytes.NewReader(reqBody))
	req.Header.Set("Authorization", "Bearer "+h.cfg.NvidiaAPIKey)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("NVIDIA API error: %v", err)})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		c.JSON(resp.StatusCode, gin.H{"error": string(body)})
		return
	}

	// Stream SSE to client
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")

	var fullContent string
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			chunk := string(buf[:n])
			c.Writer.Write(buf[:n])
			c.Writer.Flush()

			// Parse content from SSE for saving
			for _, line := range bytes.Split(buf[:n], []byte("\n")) {
				if bytes.HasPrefix(line, []byte("data: ")) {
					data := bytes.TrimPrefix(line, []byte("data: "))
					if string(data) == "[DONE]" {
						continue
					}
					var parsed struct {
						Choices []struct {
							Delta struct {
								Content string `json:"content"`
							} `json:"delta"`
						} `json:"choices"`
					}
					if json.Unmarshal(data, &parsed) == nil && len(parsed.Choices) > 0 {
						fullContent += parsed.Choices[0].Delta.Content
					}
				}
			}
			_ = chunk
		}
		if err != nil {
			break
		}
	}

	// Save assistant message
	if fullContent != "" {
		assistantMsg := models.LLMMessage{SessionID: sid, Role: "assistant", Content: fullContent}
		database.DB.Create(&assistantMsg)

		// Update session title from first user message if still default
		if session.Title == "New Chat" {
			title := body.Content
			if len(title) > 80 {
				title = title[:80] + "..."
			}
			database.DB.Model(&session).Update("title", title)
		}
		database.DB.Model(&session).Update("updated_at", time.Now())
	}
}

// Punctuate adds punctuation to text via NVIDIA API
func (h *LLMHandler) Punctuate(c *gin.Context) {
	h.textTransform(c, "Add proper punctuation and capitalization to this text. Return ONLY the corrected text, nothing else. Do not change words, only add punctuation marks and fix capitalization.")
}

// Enhance rewrites text as a clearer prompt
func (h *LLMHandler) Enhance(c *gin.Context) {
	h.textTransform(c, "Rewrite this text as a clear, concise prompt for an AI coding assistant. Keep the same intent but make it more precise. Return ONLY the rewritten text in 1-3 sentences, nothing else. No templates, no placeholders, no explanations.")
}

func (h *LLMHandler) textTransform(c *gin.Context, systemPrompt string) {
	if h.cfg.NvidiaAPIKey == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "NVIDIA API key not configured"})
		return
	}

	var body struct {
		Text string `json:"text" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	type apiMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	reqBody, _ := json.Marshal(map[string]interface{}{
		"model": "nvidia/llama-3.3-nemotron-super-49b-v1",
		"messages": []apiMsg{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: body.Text},
		},
		"stream":     false,
		"max_tokens": 32768,
	})

	req, _ := http.NewRequest("POST", "https://integrate.api.nvidia.com/v1/chat/completions", bytes.NewReader(reqBody))
	req.Header.Set("Authorization", "Bearer "+h.cfg.NvidiaAPIKey)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("NVIDIA API error: %v", err)})
		return
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		c.JSON(resp.StatusCode, gin.H{"error": string(respBody)})
		return
	}

	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil || len(parsed.Choices) == 0 {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to parse response"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"result": parsed.Choices[0].Message.Content})
}

// Vision analyzes an image using meta/llama-3.2-90b-vision-instruct
func (h *LLMHandler) Vision(c *gin.Context) {
	if h.cfg.NvidiaAPIKey == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "NVIDIA API key not configured"})
		return
	}

	var body struct {
		Image string `json:"image" binding:"required"` // base64 encoded image
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Build multimodal request for vision model
	type contentPart struct {
		Type     string      `json:"type"`
		Text     string      `json:"text,omitempty"`
		ImageURL interface{} `json:"image_url,omitempty"`
	}
	type visionMsg struct {
		Role    string        `json:"role"`
		Content []contentPart `json:"content"`
	}

	imageURL := body.Image
	if !strings.HasPrefix(imageURL, "data:") {
		imageURL = "data:image/png;base64," + imageURL
	}

	reqBody, _ := json.Marshal(map[string]interface{}{
		"model": "meta/llama-3.2-90b-vision-instruct",
		"messages": []visionMsg{{
			Role: "user",
			Content: []contentPart{
				{Type: "text", Text: "Describe this image in detail. Include all visible text, UI elements, code, diagrams, and any other relevant information."},
				{Type: "image_url", ImageURL: map[string]string{"url": imageURL}},
			},
		}},
		"max_tokens": 2048,
		"stream":     false,
	})

	req, _ := http.NewRequest("POST", "https://integrate.api.nvidia.com/v1/chat/completions", bytes.NewReader(reqBody))
	req.Header.Set("Authorization", "Bearer "+h.cfg.NvidiaAPIKey)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("Vision API error: %v", err)})
		return
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		c.JSON(resp.StatusCode, gin.H{"error": string(respBody)})
		return
	}

	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil || len(parsed.Choices) == 0 {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to parse vision response"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"description": parsed.Choices[0].Message.Content})
}
