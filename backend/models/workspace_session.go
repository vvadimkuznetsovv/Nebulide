package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

type WorkspaceSession struct {
	ID        uuid.UUID      `gorm:"type:uuid;primaryKey" json:"id"`
	UserID    uuid.UUID      `gorm:"type:uuid;not null;index" json:"user_id"`
	Name      string         `gorm:"size:100;not null" json:"name"`
	DeviceTag string         `gorm:"size:50" json:"device_tag"`
	Snapshot  datatypes.JSON `gorm:"type:jsonb;not null;default:'{}'" json:"snapshot"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
	User      User           `gorm:"foreignKey:UserID" json:"-"`
}

func (w *WorkspaceSession) BeforeCreate(tx *gorm.DB) error {
	if w.ID == uuid.Nil {
		w.ID = uuid.New()
	}
	return nil
}
