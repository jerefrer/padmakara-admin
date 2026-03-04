#!/bin/bash
# =============================================================================
# Padmakara Database Backup — Runs daily via cron
#
# Setup:
#   1. Install AWS CLI: sudo apt install awscli && aws configure
#   2. Create S3 bucket: aws s3 mb s3://padmakara-pt-database-backups
#   3. Add to crontab: crontab -e
#      0 3 * * * /home/padmakara/backup-db.sh >> /home/padmakara/backup.log 2>&1
#
# Keeps last 30 daily backups in S3.
# =============================================================================
set -euo pipefail

# --- Configuration ---
DB_NAME="padmakara"
S3_BUCKET="${BACKUP_S3_BUCKET:-padmakara-pt-database-backups}"
S3_PREFIX="db-backups"
RETENTION_DAYS=30
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="/tmp/padmakara_${TIMESTAMP}.sql.gz"

echo "[$(date)] Starting database backup..."

# Dump and compress
pg_dump "$DB_NAME" | gzip > "$BACKUP_FILE"
BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "  Backup created: ${BACKUP_SIZE}"

# Upload to S3
aws s3 cp "$BACKUP_FILE" "s3://${S3_BUCKET}/${S3_PREFIX}/${TIMESTAMP}.sql.gz" --quiet
echo "  Uploaded to s3://${S3_BUCKET}/${S3_PREFIX}/${TIMESTAMP}.sql.gz"

# Clean up local file
rm -f "$BACKUP_FILE"

# Delete old backups from S3
CUTOFF_DATE=$(date -d "-${RETENTION_DAYS} days" +%Y%m%d 2>/dev/null || date -v-${RETENTION_DAYS}d +%Y%m%d)
aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" | while read -r line; do
    FILENAME=$(echo "$line" | awk '{print $4}')
    # Extract date from filename (padmakara_YYYYMMDD_HHMMSS.sql.gz → YYYYMMDD)
    FILE_DATE=$(echo "$FILENAME" | grep -oP '\d{8}' | head -1)
    if [ -n "$FILE_DATE" ] && [ "$FILE_DATE" -lt "$CUTOFF_DATE" ] 2>/dev/null; then
        echo "  Deleting old backup: ${FILENAME}"
        aws s3 rm "s3://${S3_BUCKET}/${S3_PREFIX}/${FILENAME}" --quiet
    fi
done

echo "[$(date)] Backup complete."
