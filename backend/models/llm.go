package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type LLMSession struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey" json:"id"`
	UserID    uuid.UUID `gorm:"type:uuid;not null;index" json:"user_id"`
	Title     string    `gorm:"size:255;default:'New Chat'" json:"title"`
	Model     string    `gorm:"size:255;default:'nvidia/llama-3.3-nemotron-super-49b-v1'" json:"model"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	User     User         `gorm:"foreignKey:UserID" json:"-"`
	Messages []LLMMessage `gorm:"foreignKey:SessionID" json:"messages,omitempty"`
}

func (s *LLMSession) BeforeCreate(tx *gorm.DB) error {
	if s.ID == uuid.Nil {
		s.ID = uuid.New()
	}
	return nil
}

type LLMMessage struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey" json:"id"`
	SessionID uuid.UUID `gorm:"type:uuid;not null;index" json:"session_id"`
	Role      string    `gorm:"size:50;not null" json:"role"`
	Content   string    `gorm:"type:text;not null" json:"content"`
	CreatedAt time.Time `json:"created_at"`

	Session LLMSession `gorm:"foreignKey:SessionID" json:"-"`
}

func (m *LLMMessage) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = uuid.New()
	}
	return nil
}
