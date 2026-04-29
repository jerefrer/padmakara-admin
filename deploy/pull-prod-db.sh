#!/bin/bash
# =============================================================================
# Pull production Padmakara database to local for development / debugging.
#
# Streams pg_dump over SSH from prod and replays it into the local database
# named in padmakara-api/.env (DATABASE_URL). Drops + recreates the local
# database first, so all local-only data is destroyed. Prompts for confirmation
# before doing so.
#
# Usage:  ./deploy/pull-prod-db.sh
# =============================================================================
set -euo pipefail

PROD_HOST="${PROD_HOST:-padmakara@admin.padmakara.pt}"
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"

[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE — cannot determine local DATABASE_URL"; exit 1; }

# Read DATABASE_URL from .env without sourcing the whole file.
LOCAL_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed -E 's/^"//; s/"$//')"
[ -n "$LOCAL_URL" ] || { echo "DATABASE_URL not set in $ENV_FILE"; exit 1; }

# Parse local URL: postgresql://user[:pass]@host[:port]/dbname
proto_stripped="${LOCAL_URL#*://}"
userinfo_host="${proto_stripped%%/*}"
LOCAL_DB="${proto_stripped##*/}"
LOCAL_DB="${LOCAL_DB%%\?*}"        # strip ?query
LOCAL_HOSTPORT="${userinfo_host##*@}"
LOCAL_USERINFO="${userinfo_host%@*}"
[ "$LOCAL_USERINFO" = "$userinfo_host" ] && LOCAL_USERINFO=""
LOCAL_USER="${LOCAL_USERINFO%%:*}"
LOCAL_HOST="${LOCAL_HOSTPORT%%:*}"
LOCAL_PORT="${LOCAL_HOSTPORT##*:}"
[ "$LOCAL_PORT" = "$LOCAL_HOST" ] && LOCAL_PORT=5432

ADMIN_URL="postgresql://${LOCAL_USERINFO:+$LOCAL_USERINFO@}${LOCAL_HOST}:${LOCAL_PORT}/postgres"

echo "About to OVERWRITE local database:"
echo "  host:     $LOCAL_HOST:$LOCAL_PORT"
echo "  user:     ${LOCAL_USER:-<unset>}"
echo "  database: $LOCAL_DB"
echo "  source:   $PROD_HOST"
echo
read -r -p "All local data in '$LOCAL_DB' will be destroyed. Continue? (yes/no) " confirm
[ "$confirm" = "yes" ] || { echo "Aborted."; exit 0; }

echo "[1/3] Terminating connections to '$LOCAL_DB'..."
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$LOCAL_DB' AND pid<>pg_backend_pid();" \
  >/dev/null

echo "[2/3] Dropping and recreating '$LOCAL_DB'..."
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$LOCAL_DB\";" >/dev/null
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$LOCAL_DB\";" >/dev/null

echo "[3/3] Streaming pg_dump from $PROD_HOST..."
# Plain SQL with a sed filter that strips \restrict/\unrestrict meta-commands.
# Prod (PG 16+) emits these as a security hardening; older local psql/pg_restore
# (PG 14) doesn't understand them. The commands are no-ops for our purposes —
# they only restrict DROP semantics during the dump session — so dropping
# them produces an equivalent restore on the local side.
ssh "$PROD_HOST" 'set -a && . ~/padmakara-api/.env && set +a && pg_dump --no-owner --no-privileges "$DATABASE_URL"' \
  | sed -E '/^\\(un)?restrict /d' \
  | psql "$LOCAL_URL" -v ON_ERROR_STOP=1 -q

echo "Done. Local database '$LOCAL_DB' now mirrors production."
