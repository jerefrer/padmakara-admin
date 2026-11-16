#!/bin/bash
# =============================================================================
# Padmakara Server Setup — Run once on a fresh Hetzner CX23 (Ubuntu 24.04)
#
# Usage: ssh root@195.201.221.12 "bash -s" < padmakara-api/deploy/setup-server.sh
# =============================================================================
set -euo pipefail

APP_USER="padmakara"
DB_NAME="padmakara"

echo ""
echo "========================================="
echo "  Padmakara Server Setup"
echo "========================================="
echo ""

# --- 1. System updates ---
echo "[1/10] Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl unzip git ufw fail2ban unattended-upgrades \
    build-essential poppler-utils

# Install AWS CLI v2 (not in Ubuntu 24.04 apt repos)
if ! command -v aws &>/dev/null; then
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "/tmp/awscliv2.zip"
    unzip -q /tmp/awscliv2.zip -d /tmp
    /tmp/aws/install
    rm -rf /tmp/aws /tmp/awscliv2.zip
fi

# --- 2. Create application user ---
echo "[2/10] Creating application user: ${APP_USER}..."
if id "$APP_USER" &>/dev/null; then
    echo "  User ${APP_USER} already exists, skipping."
else
    adduser --disabled-password --gecos "" "$APP_USER"
    mkdir -p /home/${APP_USER}/.ssh
    cp /root/.ssh/authorized_keys /home/${APP_USER}/.ssh/
    chown -R ${APP_USER}:${APP_USER} /home/${APP_USER}/.ssh
    chmod 700 /home/${APP_USER}/.ssh
    chmod 600 /home/${APP_USER}/.ssh/authorized_keys
fi

# The one root-owned helper padmakara may run to install its systemd unit and
# Caddy files. Canonical copy: deploy/padmakara-install-config (the text below
# must stay identical; tests/deploy/server-scripts.test.ts checks it).
cat > /usr/local/sbin/padmakara-install-config <<'WRAPPER'
#!/bin/bash
# =============================================================================
# padmakara-install-config — the only thing the padmakara user may run as root.
#
# Installed root-owned at /usr/local/sbin/padmakara-install-config (0755) and
# allowed in /etc/sudoers.d/padmakara with these exact arguments only:
#
#   padmakara-install-config unit    systemd unit  → /etc/systemd/system/padmakara-api.service
#   padmakara-install-config site    Caddy vhost   → /etc/caddy/sites/padmakara-api.caddy
#   padmakara-install-config entry   Caddyfile     → /etc/caddy/Caddyfile (only when it
#                                                    lacks the sites import)
#
# It replaces `NOPASSWD: /usr/bin/cp`, which let padmakara overwrite any file
# on the machine as root (sudoers, a root cron job, ...) — i.e. it was root.
#
# The sources live in padmakara's checkout, which padmakara can write. So:
#   - Sources and destinations are fixed here; no argument names a path.
#   - Sources are read AS padmakara (runuser), so a symlink pointing at a
#     root-only file reads nothing that padmakara could not already read.
#   - What gets installed is the copy that was checked, never the source
#     again (no window to swap the file between check and install).
#   - The unit is checked against an allowlist of keys and must run as
#     padmakara with NoNewPrivileges. Anything else (User=root, ExecStart=+...,
#     capabilities, ExecStartPre, ...) is refused: a unit is executed by
#     systemd as root, so a free-form unit would be root again.
#   - The Caddy files are validated as the caddy user before install, so a
#     broken file never reaches /etc/caddy. Caddy itself runs as caddy, not root.
#   - The entry Caddyfile must contain only the sites import.
#
# `check-unit` (reads a unit on stdin, installs nothing) is not in sudoers; it
# exists so the unit rules can be tested without root (tests/deploy/).
#
# Canonical copy: deploy/padmakara-install-config in padmakara-api.
# deploy/setup-server.sh embeds the same text; a test keeps them identical.
# =============================================================================
set -euo pipefail
umask 022

APP_USER="padmakara"
SRC_DIR="/home/padmakara/padmakara-api/deploy"
SITES_IMPORT="import /etc/caddy/sites/*.caddy"

die() {
  echo "padmakara-install-config: $*" >&2
  exit 1
}

# Keys the unit may use. Everything the current unit needs, nothing that
# changes who the process runs as or what it may do beyond that user.
ALLOWED_KEYS=" Description Documentation After Before Wants Requires PartOf \
Type User Group WorkingDirectory ExecStart Restart RestartSec TimeoutStartSec \
TimeoutStopSec Environment EnvironmentFile NoNewPrivileges ProtectSystem \
ProtectHome ReadWritePaths ReadOnlyPaths PrivateTmp PrivateDevices \
ProtectKernelTunables ProtectKernelModules ProtectControlGroups \
RestrictSUIDSGID LockPersonality MemoryMax CPUQuota LimitNOFILE \
StandardOutput StandardError SyslogIdentifier KillSignal WantedBy "

# Reads a unit on stdin; exits non-zero with a reason when it is not allowed.
check_unit() {
  local line key value section="" user="" group="" nnp=""
  while IFS= read -r line || [ -n "$line" ]; do
    # Trim surrounding whitespace.
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in
      "" | "#"* | ";"*) continue ;;
    esac
    case "$line" in
      *\\) die "unit: line continuations are not allowed" ;;
    esac
    case "$line" in
      "[Unit]" | "[Service]" | "[Install]")
        section="$line"
        continue
        ;;
      "["*) die "unit: section not allowed: $line" ;;
    esac
    [ -n "$section" ] || die "unit: key outside a section"
    case "$line" in
      *=*) ;;
      *) die "unit: not a Key=Value line" ;;
    esac
    key="${line%%=*}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    case "$ALLOWED_KEYS" in
      *" $key "*) ;;
      *) die "unit: key not allowed: $key" ;;
    esac
    case "$key" in
      User) user="$value" ;;
      Group) group="$value" ;;
      NoNewPrivileges) nnp="$value" ;;
      ExecStart)
        # + ! !! run the command with full privileges, @ rewrites argv[0],
        # : and | change how it is parsed. Only a plain absolute path is allowed.
        case "$value" in
          /*) ;;
          *) die "unit: ExecStart must be a plain absolute path" ;;
        esac
        ;;
    esac
  done
  [ "$user" = "$APP_USER" ] || die "unit: User must be $APP_USER"
  [ "$group" = "$APP_USER" ] || die "unit: Group must be $APP_USER"
  [ "$nnp" = "true" ] || die "unit: NoNewPrivileges must be true"
}

# Copies a source into a fresh root-owned directory, reading it as padmakara.
fetch_source() {
  local src="$1" dst="$2"
  runuser -u "$APP_USER" -- cat -- "$src" > "$dst" || die "cannot read $src"
}

validate_caddy() {
  local file="$1"
  # As caddy: validation opens the log files it names, and root would create
  # them root-owned, which Caddy then could not write to.
  # The environment is the one caddy.service gives it (sudo leaves HOME=/root).
  runuser -u caddy -- env HOME=/var/lib/caddy \
    XDG_DATA_HOME=/var/lib/caddy/.local/share XDG_CONFIG_HOME=/var/lib/caddy/.config \
    caddy validate --adapter caddyfile --config "$file" > /dev/null 2>&1 \
    || die "caddy validate failed for $file (run it by hand to see why)"
}

main() {
  local target="${1:-}"

  if [ "$target" = "check-unit" ]; then
    check_unit
    echo "unit OK"
    return 0
  fi

  [ "$(id -u)" -eq 0 ] || die "must run as root (sudo)"

  local work
  work="$(mktemp -d)"
  trap 'rm -rf -- "$work"' EXIT
  chmod 0755 "$work"

  case "$target" in
    unit)
      fetch_source "$SRC_DIR/padmakara-api.service" "$work/unit"
      check_unit < "$work/unit"
      install -o root -g root -m 0644 "$work/unit" /etc/systemd/system/padmakara-api.service
      systemctl daemon-reload
      echo "installed /etc/systemd/system/padmakara-api.service"
      ;;
    site)
      fetch_source "$SRC_DIR/padmakara-api.caddy" "$work/site.caddy"
      chmod 0644 "$work/site.caddy"
      validate_caddy "$work/site.caddy"
      install -o root -g root -m 0644 "$work/site.caddy" /etc/caddy/sites/padmakara-api.caddy
      echo "installed /etc/caddy/sites/padmakara-api.caddy (reload caddy to apply)"
      ;;
    entry)
      if [ -f /etc/caddy/Caddyfile ] && grep -qxF "$SITES_IMPORT" /etc/caddy/Caddyfile; then
        die "/etc/caddy/Caddyfile already imports the sites directory; refusing to overwrite it"
      fi
      fetch_source "$SRC_DIR/Caddyfile" "$work/Caddyfile"
      # Only comments, blank lines and the import itself.
      grep -qxF "$SITES_IMPORT" "$work/Caddyfile" || die "entry Caddyfile lacks: $SITES_IMPORT"
      local extra
      extra="$(grep -vE '^[[:space:]]*(#.*)?$' "$work/Caddyfile" | grep -vxF "$SITES_IMPORT" || true)"
      [ -z "$extra" ] || die "entry Caddyfile may contain only: $SITES_IMPORT"
      install -o root -g root -m 0644 "$work/Caddyfile" /etc/caddy/Caddyfile
      echo "installed /etc/caddy/Caddyfile (reload caddy to apply)"
      ;;
    *)
      die "usage: padmakara-install-config unit|site|entry"
      ;;
  esac
}

main "$@"
WRAPPER
chown root:root /usr/local/sbin/padmakara-install-config
chmod 0755 /usr/local/sbin/padmakara-install-config

# Allow padmakara to manage its own service and caddy without password.
# No general-purpose command (cp, tee, ...) belongs here: any of them lets
# padmakara write any file as root, which makes it root.
cat > /etc/sudoers.d/padmakara <<'SUDOERS'
padmakara ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart padmakara-api
padmakara ALL=(ALL) NOPASSWD: /usr/bin/systemctl start padmakara-api
padmakara ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop padmakara-api
padmakara ALL=(ALL) NOPASSWD: /usr/bin/systemctl status padmakara-api
padmakara ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart caddy
# reload is what deploy.sh uses: other applications share this Caddy and should
# not lose a connection because this one's vhost changed.
padmakara ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload caddy
padmakara ALL=(ALL) NOPASSWD: /usr/bin/systemctl daemon-reload
padmakara ALL=(ALL) NOPASSWD: /usr/bin/systemctl enable padmakara-api
padmakara ALL=(root) NOPASSWD: /usr/local/sbin/padmakara-install-config unit
padmakara ALL=(root) NOPASSWD: /usr/local/sbin/padmakara-install-config site
padmakara ALL=(root) NOPASSWD: /usr/local/sbin/padmakara-install-config entry
SUDOERS
chmod 440 /etc/sudoers.d/padmakara
visudo -c -f /etc/sudoers.d/padmakara

# --- 3. Harden SSH ---
echo "[3/10] Hardening SSH..."
# Disable root login and password auth, ensure pubkey is enabled
sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PubkeyAuthentication .*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
systemctl restart ssh

# --- 4. Configure firewall ---
echo "[4/10] Configuring firewall (UFW)..."
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp   # SSH
ufw allow 80/tcp   # HTTP → HTTPS redirect
ufw allow 443/tcp  # HTTPS
ufw --force enable

# --- 5. Configure fail2ban ---
echo "[5/10] Configuring fail2ban..."
cat > /etc/fail2ban/jail.local <<'JAIL'
[sshd]
enabled = true
port = 22
maxretry = 5
bantime = 3600
findtime = 600
JAIL
systemctl enable fail2ban
systemctl restart fail2ban

# --- 6. Install Bun ---
echo "[6/10] Installing Bun..."
su - ${APP_USER} -c 'curl -fsSL https://bun.sh/install | bash'

# --- 7. Install Node.js (for Expo web build) ---
echo "[7/10] Installing Node.js 22 LTS..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs

# --- 8. Install PostgreSQL ---
echo "[8/10] Installing PostgreSQL..."
apt-get install -y -qq postgresql postgresql-contrib

DB_PASSWORD=$(openssl rand -base64 24)
sudo -u postgres psql -c "CREATE USER ${APP_USER} WITH PASSWORD '${DB_PASSWORD}';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${APP_USER};" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${APP_USER};"

# --- 9. Install Caddy ---
echo "[9/10] Installing Caddy..."
apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq caddy

mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy

# One directory, one file per application. /etc/caddy/Caddyfile holds only the
# import that reads this; each repository owns the vhost it puts here, so no
# deploy can disturb another application's configuration.
mkdir -p /etc/caddy/sites

# --- 10. Configure automatic security updates ---
echo "[10/10] Configuring unattended-upgrades..."
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'AUTOUPGRADE'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
AUTOUPGRADE

# --- Set up hourly database backup cron ---
echo "Setting up hourly database backup..."
# Canonical copy: deploy/backup-db.sh (identical text, checked by a test).
cat > /home/${APP_USER}/backup-db.sh <<'BACKUP'
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
BACKUP
chown ${APP_USER}:${APP_USER} /home/${APP_USER}/backup-db.sh
chmod 0700 /home/${APP_USER}/backup-db.sh

# Install hourly cron as padmakara user
echo "0 * * * * /home/${APP_USER}/backup-db.sh >> /home/${APP_USER}/backup.log 2>&1" | crontab -u ${APP_USER} -

# =============================================================================
echo ""
echo "========================================="
echo "  SERVER SETUP COMPLETE"
echo "========================================="
echo ""
echo "  Database password: ${DB_PASSWORD}"
echo "  DATABASE_URL=postgresql://${APP_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}"
echo ""
echo "  SAVE THE DATABASE PASSWORD ABOVE — it won't be shown again!"
echo ""
echo "========================================="
echo "  Security summary:"
echo "========================================="
echo "  - SSH: key-only, root login disabled"
echo "  - Firewall: only ports 22, 80, 443 open"
echo "  - Fail2ban: 5 failed attempts = 1 hour ban"
echo "  - Auto-updates: security patches applied daily"
echo "  - Backups: hourly pg_dump to S3 (needs the padmakara-db-backup AWS profile)"
echo "  - sudo: padmakara may only restart its service, reload Caddy and run"
echo "    padmakara-install-config (no general-purpose command)"
echo ""
echo "========================================="
echo "  Installed software:"
echo "========================================="
echo "  - Bun:        $(su - ${APP_USER} -c '/home/padmakara/.bun/bin/bun --version' 2>/dev/null || echo 'installed')"
echo "  - Node.js:    $(node --version 2>/dev/null || echo 'installed')"
echo "  - PostgreSQL:  $(psql --version 2>/dev/null | head -1 || echo 'installed')"
echo "  - Caddy:      $(caddy version 2>/dev/null || echo 'installed')"
echo ""
echo "========================================="
echo "  Next steps (as padmakara user):"
echo "========================================="
echo ""
echo "  ssh padmakara@195.201.221.12"
echo ""
echo "  # 1. AWS profile for backups: the put-only IAM user padmakara-db-backup"
echo "  #    (see the header of deploy/backup-db.sh for its policy)"
echo "  aws configure --profile padmakara-db-backup"
echo "  chmod 600 ~/.aws/credentials"
echo ""
echo "  # 2. Clone the repo and set up"
echo "  # (this will be done by the deploy script later; it keeps ~/padmakara-api/.env"
echo "  #  at mode 600 — it holds the database password and every API secret)"
echo ""
