#!/bin/bash
# =============================================================================
# Padmakara Database Backup — runs hourly from padmakara's crontab:
#   0 * * * * /home/padmakara/backup-db.sh >> /home/padmakara/backup.log 2>&1
#
# The server runs a COPY at /home/padmakara/backup-db.sh, not this file:
# after changing it, install the copy again (see
# docs/runbooks/server-hardening-2026-11.md). setup-server.sh embeds the same
# text; tests/deploy/server-scripts.test.ts keeps the two identical.
#
# Identity: the AWS profile padmakara-db-backup (IAM user padmakara-db-backup,
# created 2026-11-16), allowed only s3:PutObject and s3:AbortMultipartUpload
# on arn:aws:s3:::padmakara-pt-database-backups/db-backups/*. It can add
# backups and nothing else: it cannot list, read or delete them, and since the
# bucket is versioned a PUT over an existing key only adds a version. A
# compromise of this server therefore cannot erase the backup history.
#
# Retention is therefore the bucket's job, not this script's: a lifecycle rule
# expires current objects under db-backups/ after 30 days, and versioning plus
# a second rule keeps noncurrent versions another 30 days.
# =============================================================================
set -euo pipefail

# Dumps hold every user's data: nothing this script creates is readable by
# anyone but its owner.
umask 077

export AWS_PROFILE="${BACKUP_AWS_PROFILE:-padmakara-db-backup}"

DB_NAME="padmakara"
S3_BUCKET="${BACKUP_S3_BUCKET:-padmakara-pt-database-backups}"
S3_PREFIX="db-backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# An unpredictable name, so no other local user can pre-create or swap it.
BACKUP_FILE="$(mktemp "${TMPDIR:-/tmp}/padmakara-backup.XXXXXXXXXX")"
trap 'rm -f -- "$BACKUP_FILE"' EXIT

echo "[$(date)] Starting database backup..."

pg_dump "$DB_NAME" | gzip > "$BACKUP_FILE"
BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "  Backup created: ${BACKUP_SIZE}"

aws s3 cp "$BACKUP_FILE" "s3://${S3_BUCKET}/${S3_PREFIX}/${TIMESTAMP}.sql.gz" --quiet
echo "  Uploaded to s3://${S3_BUCKET}/${S3_PREFIX}/${TIMESTAMP}.sql.gz"

echo "[$(date)] Backup complete."
