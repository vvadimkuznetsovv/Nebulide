package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"nebulide/config"
)

// maxVoiceUploadBytes limits voice recordings (≈120s of opus is well under this).
const maxVoiceUploadBytes = 25 << 20 // 25MB

type VoiceHandler struct {
	cfg *config.Config
}

func NewVoiceHandler(cfg *config.Config) *VoiceHandler {
	return &VoiceHandler{cfg: cfg}
}

// Transcribe proxies an uploaded audio file to the OpenAI-compatible
// transcription service (faster-whisper) and returns {"text": "..."}.
// POST /api/voice/transcribe — multipart form: file (audio), language (optional).
func (h *VoiceHandler) Transcribe(c *gin.Context) {
	if h.cfg.WhisperURL == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Voice transcription not configured"})
		return
	}

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxVoiceUploadBytes)
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "Audio file too large (max 25MB)"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing audio file"})
		return
	}
	defer file.Close()

	language := c.PostForm("language")

	// Stream the upstream multipart body — no full buffering of the audio
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		var werr error
		defer func() { pw.CloseWithError(werr) }()
		part, err := mw.CreateFormFile("file", header.Filename)
		if err != nil {
			werr = err
			return
		}
		if _, err := io.Copy(part, file); err != nil {
			werr = err
			return
		}
		mw.WriteField("model", h.cfg.WhisperModel)
		mw.WriteField("response_format", "json")
		if language != "" {
			mw.WriteField("language", language)
		}
		werr = mw.Close()
	}()

	url := strings.TrimRight(h.cfg.WhisperURL, "/") + "/v1/audio/transcriptions"
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, url, pr)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to build request"})
		return
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[Voice] transcription request failed: %v", err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "Transcription service unavailable"})
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		log.Printf("[Voice] transcription failed: status=%d body=%s", resp.StatusCode, truncate(string(body), 500))
		c.JSON(http.StatusBadGateway, gin.H{"error": "Transcription failed"})
		return
	}

	var out struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		log.Printf("[Voice] bad transcription response: %v body=%s", err, truncate(string(body), 500))
		c.JSON(http.StatusBadGateway, gin.H{"error": "Bad transcription response"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"text": strings.TrimSpace(out.Text)})
}
