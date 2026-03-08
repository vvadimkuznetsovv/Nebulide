package services

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"gorm.io/gorm"

	"nebulide/config"
	"nebulide/models"
)

type TelegramBot struct {
	bot *tgbotapi.BotAPI
	cfg *config.Config
	db  *gorm.DB
}

func NewTelegramBot(cfg *config.Config, db *gorm.DB) (*TelegramBot, error) {
	if cfg.TelegramBotToken == "" {
		return nil, fmt.Errorf("TELEGRAM_BOT_TOKEN not set")
	}

	var bot *tgbotapi.BotAPI
	var err error

	if cfg.TelegramAPIURL != "" {
		// Use local Telegram Bot API server (2GB file limit)
		bot, err = tgbotapi.NewBotAPIWithAPIEndpoint(cfg.TelegramBotToken, cfg.TelegramAPIURL+"/bot%s/%s")
		if err != nil {
			return nil, fmt.Errorf("failed to create telegram bot (local API): %w", err)
		}
		log.Printf("[TelegramBot] Using local API: %s", cfg.TelegramAPIURL)
	} else {
		bot, err = tgbotapi.NewBotAPI(cfg.TelegramBotToken)
		if err != nil {
			return nil, fmt.Errorf("failed to create telegram bot: %w", err)
		}
	}

	log.Printf("[TelegramBot] Authorized as @%s", bot.Self.UserName)
	return &TelegramBot{bot: bot, cfg: cfg, db: db}, nil
}

// Start runs the long-polling loop. Call in a goroutine.
func (t *TelegramBot) Start() {
	u := tgbotapi.NewUpdate(0)
	u.Timeout = 60
	updates := t.bot.GetUpdatesChan(u)

	for update := range updates {
		if update.Message == nil {
			continue
		}
		t.handleMessage(update.Message)
	}
}

func (t *TelegramBot) handleMessage(msg *tgbotapi.Message) {
	chatID := msg.Chat.ID

	// /start command
	if msg.IsCommand() && msg.Command() == "start" {
		text := fmt.Sprintf("Привет! Твой Telegram ID: %d\n\nУкажи его в настройках Nebulide для привязки аккаунта.\n\nПосле привязки ты сможешь отправлять сюда файлы — они сохранятся в твоём workspace.", chatID)
		reply := tgbotapi.NewMessage(chatID, text)
		t.bot.Send(reply)
		return
	}

	// Find user by telegram_id
	var user models.User
	if err := t.db.Where("telegram_id = ?", chatID).First(&user).Error; err != nil {
		reply := tgbotapi.NewMessage(chatID, fmt.Sprintf("Аккаунт не привязан. Укажи Telegram ID %d в настройках Nebulide.", chatID))
		t.bot.Send(reply)
		return
	}

	// Handle file/photo/document
	var fileID, fileName string

	switch {
	case msg.Document != nil:
		fileID = msg.Document.FileID
		fileName = msg.Document.FileName
	case msg.Photo != nil && len(msg.Photo) > 0:
		// Take the largest photo
		photo := msg.Photo[len(msg.Photo)-1]
		fileID = photo.FileID
		fileName = fmt.Sprintf("photo_%d.jpg", msg.MessageID)
	case msg.Video != nil:
		fileID = msg.Video.FileID
		fileName = fmt.Sprintf("video_%d.mp4", msg.MessageID)
		if msg.Video.FileName != "" {
			fileName = msg.Video.FileName
		}
	case msg.Audio != nil:
		fileID = msg.Audio.FileID
		fileName = msg.Audio.FileName
		if fileName == "" {
			fileName = fmt.Sprintf("audio_%d.mp3", msg.MessageID)
		}
	case msg.Voice != nil:
		fileID = msg.Voice.FileID
		fileName = fmt.Sprintf("voice_%d.ogg", msg.MessageID)
	default:
		reply := tgbotapi.NewMessage(chatID, "Отправь файл, фото или видео — я сохраню его в твой workspace.")
		t.bot.Send(reply)
		return
	}

	// Sanitize filename
	fileName = sanitizeFileName(fileName)

	// Save to user's workspace/uploads/
	userDir := t.cfg.GetUserWorkspaceDir(user.Username)
	if user.Username == t.cfg.AdminUsername {
		userDir = t.cfg.ClaudeWorkingDir
	}
	uploadsDir := filepath.Join(userDir, "uploads")
	os.MkdirAll(uploadsDir, 0755)

	destPath := filepath.Join(uploadsDir, fileName)
	// Avoid overwriting — name(2).ext, name(3).ext, ...
	if _, err := os.Stat(destPath); err == nil {
		ext := filepath.Ext(fileName)
		base := strings.TrimSuffix(fileName, ext)
		for i := 2; ; i++ {
			destPath = filepath.Join(uploadsDir, fmt.Sprintf("%s(%d)%s", base, i, ext))
			if _, err := os.Stat(destPath); os.IsNotExist(err) {
				break
			}
		}
	}

	// Download/copy file
	if t.cfg.TelegramAPIURL != "" {
		// Local Bot API: file_path is an absolute filesystem path on the shared volume
		if err := t.copyLocalFile(fileID, destPath); err != nil {
			log.Printf("[TelegramBot] local copy error: %v", err)
			reply := tgbotapi.NewMessage(chatID, "Ошибка сохранения файла.")
			t.bot.Send(reply)
			return
		}
	} else {
		// Official API: download via HTTP
		fileURL, err := t.bot.GetFileDirectURL(fileID)
		if err != nil {
			log.Printf("[TelegramBot] GetFileDirectURL error: %v", err)
			errMsg := "Ошибка получения файла."
			if strings.Contains(err.Error(), "file is too big") {
				errMsg = "Файл слишком большой (лимит Telegram Bot API — 20 МБ). Попробуй сжать или разделить файл."
			}
			reply := tgbotapi.NewMessage(chatID, errMsg)
			t.bot.Send(reply)
			return
		}
		if err := downloadFile(fileURL, destPath); err != nil {
			log.Printf("[TelegramBot] download error: %v", err)
			reply := tgbotapi.NewMessage(chatID, "Ошибка сохранения файла.")
			t.bot.Send(reply)
			return
		}
	}

	savedName := filepath.Base(destPath)
	reply := tgbotapi.NewMessage(chatID, fmt.Sprintf("Файл сохранён: uploads/%s", savedName))
	t.bot.Send(reply)
}

// copyLocalFile uses bot.GetFile to get the local filesystem path from the
// Telegram Bot API local server, then copies the file directly from the shared
// Docker volume (/var/lib/telegram-bot-api/...) instead of HTTP download.
func (t *TelegramBot) copyLocalFile(fileID, destPath string) error {
	file, err := t.bot.GetFile(tgbotapi.FileConfig{FileID: fileID})
	if err != nil {
		return fmt.Errorf("getFile: %w", err)
	}
	srcPath := file.FilePath
	log.Printf("[TelegramBot] local copy: %s → %s", srcPath, destPath)

	src, err := os.Open(srcPath)
	if err != nil {
		return fmt.Errorf("open source %s: %w", srcPath, err)
	}
	defer src.Close()

	dst, err := os.Create(destPath)
	if err != nil {
		return fmt.Errorf("create dest: %w", err)
	}
	defer dst.Close()

	n, err := io.Copy(dst, src)
	if err != nil {
		return fmt.Errorf("copy: %w", err)
	}
	log.Printf("[TelegramBot] copied %d bytes → %s", n, destPath)
	return nil
}

// SendFile sends a file from the filesystem to a Telegram chat.
func (t *TelegramBot) SendFile(chatID int64, filePath string) error {
	file := tgbotapi.FilePath(filePath)
	fileName := filepath.Base(filePath)
	doc := tgbotapi.NewDocument(chatID, file)
	doc.Caption = fileName
	_, err := t.bot.Send(doc)
	return err
}

const maxDownloadSize = 800 * 1024 * 1024 // 800MB

func downloadFile(url, dest string) error {
	log.Printf("[TelegramBot] downloading %s → %s", url, dest)
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("download failed: HTTP %d: %s", resp.StatusCode, string(body))
	}

	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()

	// Limit download size to prevent disk exhaustion
	n, err := io.Copy(out, io.LimitReader(resp.Body, maxDownloadSize))
	log.Printf("[TelegramBot] downloaded %d bytes → %s", n, dest)
	return err
}

func sanitizeFileName(name string) string {
	// Remove path separators and dangerous characters
	name = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == '\x00' || r == ':' || r == '*' || r == '?' || r == '"' || r == '<' || r == '>' || r == '|' {
			return '_'
		}
		return r
	}, name)
	// Block path traversal and reserved names
	if name == "" || name == "." || name == ".." {
		name = "file"
	}
	// Truncate overly long filenames (filesystem limit 255 bytes)
	if len(name) > 200 {
		ext := filepath.Ext(name)
		name = name[:200-len(ext)] + ext
	}
	return name
}
