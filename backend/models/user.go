package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type User struct {
	ID           uuid.UUID `gorm:"type:uuid;primaryKey" json:"id"`
	Username     string    `gorm:"uniqueIndex;size:50;not null" json:"username"`
	PasswordHash string    `gorm:"size:255;not null" json:"-"`
	TOTPSecret   string    `gorm:"size:64;not null" json:"-"`
	TOTPEnabled  bool      `gorm:"default:false" json:"totp_enabled"`
	IsAdmin      bool      `gorm:"default:false" json:"is_admin"`
	TelegramID   int64     `gorm:"default:0" json:"telegram_id"`
	ThemeJSON       string    `gorm:"type:text;default:'{}'" json:"-"`
	PreferencesJSON string    `gorm:"type:text;default:'{}'" json:"-"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (u *User) BeforeCreate(tx *gorm.DB) error {
	if u.ID == uuid.Nil {
		u.ID = uuid.New()
	}
	return nil
}
