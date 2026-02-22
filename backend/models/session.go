package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type ChatSession struct {
	ID               uuid.UUID `gorm:"type:uuid;primaryKey" json:"id"`
	UserID           uuid.UUID `gorm:"type:uuid;not null;index" json:"user_id"`
	Title            string    `gorm:"size:255;default:'New Chat'" json:"title"`
	ClaudeSessionID  string    `gorm:"size:255" json:"claude_session_id"`
	WorkingDirectory string    `gorm:"size:500" json:"working_directory"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`

	User     User      `gorm:"foreignKey:UserID" json:"-"`
	Messages []Message `gorm:"foreignKey:SessionID" json:"messages,omitempty"`
}

func (s *ChatSession) BeforeCreate(tx *gorm.DB) error {
	if s.ID == uuid.Nil {
		s.ID = uuid.New()
	}
	return nil
}
