#!/bin/bash
# Nebulide PostgreSQL backup — runs via cron daily at 3:00 UTC
# Keeps last 14 days, .sql.gz format

BACKUP_DIR=/opt/nebulide/backups
MAX_BACKUPS=14
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/nebulide_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

docker exec nebulide-postgres-1 pg_dump -U nebulide -d nebulide | gzip > "$BACKUP_FILE"

if [ $? -eq 0 ] && [ -s "$BACKUP_FILE" ]; then
  echo "[$(date)] Backup OK: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
else
  echo "[$(date)] Backup FAILED" >&2
  rm -f "$BACKUP_FILE"
  exit 1
fi

# Remove old backups beyond MAX_BACKUPS
ls -t ${BACKUP_DIR}/nebulide_*.sql.gz 2>/dev/null | tail -n +$((MAX_BACKUPS+1)) | xargs -r rm
