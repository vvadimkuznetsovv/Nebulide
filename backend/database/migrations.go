package database

import (
	"fmt"
	"log"

	"nebulide/models"
)

func Migrate() {
	err := DB.AutoMigrate(
		&models.User{},
		&models.ChatSession{},
		&models.Message{},
		&models.RefreshToken{},
		&models.Invite{},
		&models.WorkspaceSession{},
	)
	if err != nil {
		log.Fatalf("Failed to run migrations: %v", err)
	}
	fmt.Println("Migrations completed")
}
