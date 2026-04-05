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

# Allow padmakara to manage its own service and caddy without password
cat > /etc/sudoers.d/padmakara <<'SUDOERS'
padmakara ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart padmakara-api
padmakara ALL=(ALL) NOPASSWD: /usr/bin/systemctl start padmakara-api
padmakara ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop padmakara-api
padmakara ALL=(ALL) NOPASSWD: /usr/bin/systemctl status padmakara-api
padmakara ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart caddy
padmakara ALL=(ALL) NOPASSWD: /usr/bin/systemctl daemon-reload
padmakara ALL=(ALL) NOPASSWD: /usr/bin/systemctl enable padmakara-api
padmakara ALL=(ALL) NOPASSWD: /usr/bin/cp
SUDOERS
chmod 440 /etc/sudoers.d/padmakara

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

# --- 10. Configure automatic security updates ---
echo "[10/10] Configuring unattended-upgrades..."
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'AUTOUPGRADE'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
AUTOUPGRADE

# --- Set up hourly database backup cron ---
echo "Setting up hourly database backup..."
cat > /home/${APP_USER}/backup-db.sh <<'BACKUP'
#!/bin/bash
set -euo pipefail
DB_NAME="padmakara"
S3_BUCKET="${BACKUP_S3_BUCKET:-padmakara-pt-database-backups}"
S3_PREFIX="db-backups"
RETENTION_DAYS=30
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="/tmp/padmakara_${TIMESTAMP}.sql.gz"

pg_dump "$DB_NAME" | gzip > "$BACKUP_FILE"
aws s3 cp "$BACKUP_FILE" "s3://${S3_BUCKET}/${S3_PREFIX}/${TIMESTAMP}.sql.gz" --quiet
rm -f "$BACKUP_FILE"

# Delete backups older than retention period
CUTOFF_DATE=$(date -d "-${RETENTION_DAYS} days" +%Y%m%d 2>/dev/null || date -v-${RETENTION_DAYS}d +%Y%m%d)
aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" | while read -r line; do
    FILENAME=$(echo "$line" | awk '{print $4}')
    FILE_DATE=$(echo "$FILENAME" | grep -oP '\d{8}' | head -1 || true)
    if [ -n "$FILE_DATE" ] && [ "$FILE_DATE" -lt "$CUTOFF_DATE" ] 2>/dev/null; then
        aws s3 rm "s3://${S3_BUCKET}/${S3_PREFIX}/${FILENAME}" --quiet
    fi
done
BACKUP
chown ${APP_USER}:${APP_USER} /home/${APP_USER}/backup-db.sh
chmod +x /home/${APP_USER}/backup-db.sh

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
echo "  - Backups: hourly pg_dump to S3 (needs aws configure)"
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
echo "  # 1. Configure AWS CLI for backups"
echo "  aws configure"
echo ""
echo "  # 2. Create backup S3 bucket (if not exists)"
echo "  aws s3 mb s3://padmakara-backups --region eu-west-3"
echo ""
echo "  # 3. Clone the repo and set up"
echo "  # (this will be done by the deploy script later)"
echo ""
