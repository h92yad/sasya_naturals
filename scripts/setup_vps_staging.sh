#!/usr/bin/env bash
# ==============================================================================
# Sasya Naturals (sashyanaturals.com) — 1-Command VPS Staging Setup Script
# Target VPS: Hostinger KVM2 Ubuntu 24.04 LTS (189.72.179.46)
#
# Executes Steps 4.3, 4.4, 4.5, and 4.6 automatically:
#   - 4.3 Installs Node.js 22 LTS, Nginx, Git, UFW, and apache2-utils
#   - 4.4 Clones/updates /var/www/sasya_naturals_staging & starts systemd (:3021)
#   - 4.5 Prepares /etc/ssl/cloudflare & /var/www/coming_soon/index.html
#   - 4.6 Configures Nginx (sashyanaturals.com -> Launching Soon,
#         staging.sashyanaturals.com -> 127.0.0.1:3021) and enables UFW firewall
# ==============================================================================

set -euo pipefail

DOMAIN="sashyanaturals.com"
STAGING_DOMAIN="staging.sashyanaturals.com"
REPO_URL="https://github.com/h92yad/sasya_naturals.git"
STAGING_DIR="/var/www/sasya_naturals_staging"
COMING_SOON_DIR="/var/www/coming_soon"
SSL_DIR="/etc/ssl/cloudflare"
SERVICE_FILE="/etc/systemd/system/sasya-staging.service"
NGINX_AVAILABLE="/etc/nginx/sites-available/${DOMAIN}"
NGINX_ENABLED="/etc/nginx/sites-enabled/${DOMAIN}"

echo "=================================================================="
echo " Sasya Naturals — Automated Staging VPS Setup (${STAGING_DOMAIN})"
echo "=================================================================="

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: Please run this script as root (ssh root@189.72.179.46)." >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# Step 4.3: Update Ubuntu Packages & Install Node.js 22, Nginx, Git, UFW
# ------------------------------------------------------------------------------
echo ""
echo "---> [Step 4.3] Installing base Ubuntu 24.04 packages & Node.js 22 LTS..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y curl ca-certificates gnupg nginx git ufw apache2-utils openssl

NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo "0")
  if [ "${NODE_MAJOR}" -ge 22 ]; then
    NEED_NODE=0
  fi
fi

if [ "${NEED_NODE}" -eq 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "     Node.js version: $(node -v)"
echo "     NPM version:     $(npm -v)"

# ------------------------------------------------------------------------------
# Step 4.4: Deploy Repo to /var/www/sasya_naturals_staging & Start on Port 3021
# ------------------------------------------------------------------------------
echo ""
echo "---> [Step 4.4] Deploying repository to ${STAGING_DIR} (Port 3021)..."
mkdir -p /var/www

if [ -d "${STAGING_DIR}/.git" ]; then
  echo "     Existing git clone detected; pulling latest changes..."
  git -C "${STAGING_DIR}" pull --ff-only
else
  git clone "${REPO_URL}" "${STAGING_DIR}"
fi

cd "${STAGING_DIR}"
echo "     Running 7-suite guardrail verification on VPS..."
npm test

# Preserve existing SESSION_SECRET across re-runs so Credential Vault secrets stay valid
EXISTING_SECRET=""
if [ -f "${SERVICE_FILE}" ]; then
  EXISTING_SECRET=$(grep '^Environment=SESSION_SECRET=' "${SERVICE_FILE}" | cut -d'=' -f3- || true)
fi

if [ -n "${EXISTING_SECRET}" ]; then
  STAGING_SECRET="${EXISTING_SECRET}"
  echo "     Preserving existing SESSION_SECRET from ${SERVICE_FILE}."
else
  STAGING_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
  echo "     Generated new 48-byte SESSION_SECRET."
fi

cat <<EOF > "${SERVICE_FILE}"
[Unit]
Description=Sasya Naturals Staging Server (:3021)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${STAGING_DIR}
Environment=NODE_ENV=development
Environment=PORT=3021
Environment=CANONICAL_ORIGIN=https://${STAGING_DOMAIN}
Environment=SESSION_SECRET=${STAGING_SECRET}
ExecStart=/usr/bin/node --no-warnings ${STAGING_DIR}/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sasya-staging
systemctl restart sasya-staging
sleep 2

if curl -fsS -I http://127.0.0.1:3021 >/dev/null; then
  echo "     ✓ sasya-staging service is active and listening on http://127.0.0.1:3021"
else
  echo "     ! WARNING: sasya-staging did not respond on 127.0.0.1:3021. Check: journalctl -u sasya-staging -n 50" >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# Step 4.5: Cloudflare SSL Directory & "Launching Soon" Public Holding Page
# ------------------------------------------------------------------------------
echo ""
echo "---> [Step 4.5] Preparing SSL certificates & Launching Soon page..."
mkdir -p "${SSL_DIR}"
chmod 700 "${SSL_DIR}"

USING_FALLBACK_SSL=0
if [ ! -s "${SSL_DIR}/origin.pem" ] || [ ! -s "${SSL_DIR}/origin.key" ]; then
  USING_FALLBACK_SSL=1
  echo "     No Cloudflare Origin SSL found at ${SSL_DIR}/origin.pem yet."
  echo "     Generating temporary self-signed SSL cert so Nginx starts cleanly..."
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout "${SSL_DIR}/origin.key" \
    -out "${SSL_DIR}/origin.pem" \
    -subj "/CN=${DOMAIN}" \
    -addext "subjectAltName=DNS:${DOMAIN},DNS:*.${DOMAIN}" >/dev/null 2>&1
fi
chmod 600 "${SSL_DIR}/origin.key"
chmod 644 "${SSL_DIR}/origin.pem"

mkdir -p "${COMING_SOON_DIR}"
cat <<'EOF' > "${COMING_SOON_DIR}/index.html"
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Sashya Naturals — Launching Soon</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #FAF6F0; color: #1F3A2E; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
    .card { max-width: 480px; padding: 2.5rem; border: 1px solid #E2D9C8; border-radius: 12px; background: #FFF; box-shadow: 0 10px 30px rgba(31, 58, 46, 0.06); }
    h1 { margin: 0 0 0.75rem; font-size: 1.75rem; letter-spacing: -0.02em; }
    p { margin: 0; color: #5A6B5C; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sashya Naturals</h1>
    <p>Heirloom Dry Fruits, Unpolished Native Millets &amp; Single-Origin Indian Spices.<br><br><strong>Our online store is launching soon.</strong></p>
  </div>
</body>
</html>
EOF

# ------------------------------------------------------------------------------
# Step 4.6: Configure Nginx & Enable UFW Firewall
# ------------------------------------------------------------------------------
echo ""
echo "---> [Step 4.6] Configuring Nginx & UFW Firewall..."

cat <<EOF > "${NGINX_AVAILABLE}"
# 1. Drop direct IP requests (e.g. someone visiting http://189.72.179.46 directly)
server {
    listen 80 default_server;
    listen 443 ssl default_server;
    server_name _;
    ssl_certificate ${SSL_DIR}/origin.pem;
    ssl_certificate_key ${SSL_DIR}/origin.key;
    return 444;
}

# 2. MAIN PUBLIC DOMAIN -> Serves "Launching Soon" page ONLY (Store stays offline)
server {
    listen 80;
    listen 443 ssl;
    server_name ${DOMAIN} www.${DOMAIN};

    ssl_certificate ${SSL_DIR}/origin.pem;
    ssl_certificate_key ${SSL_DIR}/origin.key;

    root ${COMING_SOON_DIR};
    index index.html;

    location / {
        add_header X-Robots-Tag "noindex, nofollow" always;
        try_files \$uri \$uri/ /index.html;
    }
}

# 3. STAGING SUBDOMAIN -> Forwards to Node.js Staging Server (:3021)
server {
    listen 80;
    listen 443 ssl;
    server_name ${STAGING_DOMAIN};

    ssl_certificate ${SSL_DIR}/origin.pem;
    ssl_certificate_key ${SSL_DIR}/origin.key;

    client_max_body_size 15M;

    location / {
        add_header X-Robots-Tag "noindex, nofollow" always;
        proxy_pass http://127.0.0.1:3021;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

ln -sf "${NGINX_AVAILABLE}" "${NGINX_ENABLED}"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl reload nginx

ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo ""
echo "=================================================================="
echo " ✓ STAGING VPS SETUP COMPLETE!"
echo "=================================================================="
echo " • Public Domain (https://${DOMAIN})      -> 'Launching Soon' Holding Page"
echo " • Staging Store (https://${STAGING_DOMAIN}) -> Active on 127.0.0.1:3021"
echo " • Staging Admin (https://${STAGING_DOMAIN}/admin)"
if [ "${USING_FALLBACK_SSL}" -eq 1 ]; then
  echo ""
  echo " [NOTE ON CLOUDFLARE SSL]"
  echo " A temporary self-signed certificate was installed so Nginx works immediately"
  echo " with Cloudflare SSL mode 'Full'."
  echo " To use Cloudflare 'Full (Strict)' mode, paste your Cloudflare Origin SSL into:"
  echo "   nano ${SSL_DIR}/origin.pem"
  echo "   nano ${SSL_DIR}/origin.key"
  echo " and run: systemctl reload nginx"
fi
echo "=================================================================="
