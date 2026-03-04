#!/bin/bash
# =============================================================================
# Padmakara Deploy Script — Run from your local machine
#
# Usage: ./deploy/deploy.sh user@host
# Example: ./deploy/deploy.sh padmakara@195.201.221.12
#
# Handles both first deploy and subsequent deploys automatically.
# =============================================================================
set -euo pipefail

SERVER="${1:-}"

if [ -z "$SERVER" ]; then
    echo "Usage: ./deploy/deploy.sh user@host"
    echo "Example: ./deploy/deploy.sh padmakara@195.201.221.12"
    exit 1
fi

echo "=== Deploying Padmakara to ${SERVER} ==="
echo ""

ssh "$SERVER" bash <<'REMOTE_SCRIPT'
set -euo pipefail

API_DIR="/home/padmakara/padmakara-api"
APP_DIR="/home/padmakara/padmakara-app"
BUN="/home/padmakara/.bun/bin/bun"

# --- Clone repos if missing ---
if [ ! -d "$API_DIR/.git" ]; then
    echo "[setup] Cloning padmakara-api..."
    git clone https://github.com/jerefrer/padmakara-admin.git "$API_DIR"
fi

if [ ! -d "$APP_DIR/.git" ]; then
    echo "[setup] Cloning padmakara-app..."
    git clone https://github.com/jerefrer/padmakara-app-frontend.git "$APP_DIR"
fi

# Ensure we're on main (in case a previous rollback left us in detached HEAD)
cd "$API_DIR" && git checkout main 2>/dev/null || true
cd "$APP_DIR" && git checkout main 2>/dev/null || true

# Save current commit for rollback
cd "$API_DIR"
PREVIOUS_API=$(git rev-parse HEAD)
cd "$APP_DIR"
PREVIOUS_APP=$(git rev-parse HEAD)

# --- Pull latest code ---
echo "[1/7] Pulling latest code..."
cd "$API_DIR" && git pull origin main
cd "$APP_DIR" && git pull origin main

# --- Install Caddyfile and systemd service if missing ---
if [ ! -f /etc/systemd/system/padmakara-api.service ]; then
    echo "[setup] Installing Caddyfile..."
    sudo cp "$API_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
    sudo systemctl restart caddy

    echo "[setup] Installing systemd service..."
    sudo cp "$API_DIR/deploy/padmakara-api.service" /etc/systemd/system/padmakara-api.service
    sudo systemctl daemon-reload
    sudo systemctl enable padmakara-api
fi

# --- Check .env exists ---
if [ ! -f "$API_DIR/.env" ]; then
    echo ""
    echo "==========================================="
    echo "  .env setup required"
    echo "==========================================="
    echo ""
    echo "A .env file has been created from .env.example."
    echo "SSH into the server and edit it with production values:"
    echo ""
    echo "  ssh ${USER}@$(hostname -I | awk '{print $1}')"
    echo "  nano $API_DIR/.env"
    echo ""
    echo "Key values to set:"
    echo "  - DATABASE_URL (use the password from setup-server.sh output)"
    echo "  - JWT_SECRET (generate with: openssl rand -base64 32)"
    echo "  - AWS credentials"
    echo "  - FRONTEND_URL=https://app.padmakara.pt"
    echo "  - BACKEND_URL=https://api.padmakara.pt"
    echo "  - ADMIN_URL=https://admin.padmakara.pt"
    echo "  - NODE_ENV=production"
    echo "  - EASYPAY_TESTING=false (when ready)"
    echo ""
    echo "Then re-run the deploy script."
    cp "$API_DIR/.env.example" "$API_DIR/.env"
    exit 1
fi

# --- Check for missing env vars ---
echo "[2/7] Checking for missing env vars..."
if [ -f "$API_DIR/.env.example" ] && [ -f "$API_DIR/.env" ]; then
    MISSING=""
    while IFS= read -r line; do
        # Skip comments and blank lines
        [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
        KEY="${line%%=*}"
        if ! grep -q "^${KEY}=" "$API_DIR/.env"; then
            MISSING="${MISSING}  - ${KEY}\n"
        fi
    done < "$API_DIR/.env.example"

    if [ -n "$MISSING" ]; then
        echo ""
        echo "WARNING: These env vars are in .env.example but missing from .env:"
        echo -e "$MISSING"
        echo "Deploy aborted. Add the missing vars to $API_DIR/.env and re-deploy."
        cd "$API_DIR" && git reset --hard "$PREVIOUS_API"
        cd "$APP_DIR" && git reset --hard "$PREVIOUS_APP"
        exit 1
    fi
    echo "  All env vars present."
else
    echo "  Skipped (missing .env.example or .env)"
fi

echo "[3/7] Installing API dependencies..."
cd "$API_DIR" && $BUN install --frozen-lockfile

echo "[4/7] Running database migrations..."
cd "$API_DIR" && $BUN x drizzle-kit migrate

echo "[5/7] Building admin panel..."
cd "$API_DIR/admin" && $BUN install --frozen-lockfile && $BUN x vite build

echo "[6/7] Building web app..."
cd "$APP_DIR" && npm install && npx expo export -p web

echo "[7/7] Restarting API service..."
sudo systemctl restart padmakara-api

# Wait for the service to be ready
sleep 3

# Health check
echo ""
echo "Running health check..."
if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    echo "Health check PASSED"
    echo ""
    echo "Deployed successfully!"
    echo "  API: $(cd "$API_DIR" && git rev-parse --short HEAD)"
    echo "  App: $(cd "$APP_DIR" && git rev-parse --short HEAD)"
else
    echo "Health check FAILED — rolling back!"
    echo ""

    cd "$API_DIR"
    git reset --hard "$PREVIOUS_API"
    $BUN install --frozen-lockfile

    cd "$APP_DIR"
    git reset --hard "$PREVIOUS_APP"

    sudo systemctl restart padmakara-api
    sleep 3

    if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
        echo "Rollback successful — previous version restored."
    else
        echo "CRITICAL: Rollback also failed. Manual intervention needed!"
    fi
    exit 1
fi
REMOTE_SCRIPT

echo ""
echo "=== Deploy complete ==="
