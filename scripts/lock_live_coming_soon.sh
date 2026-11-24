#!/usr/bin/env bash
# ==============================================================================
# Sasya Naturals — Lock Live Domain (sashyanaturals.com) to "Launching Soon" Only
# Makes ZERO changes to staging.sashyanaturals.com (:3021) or the staging app.
# ==============================================================================

set -euo pipefail

DOMAIN="sashyanaturals.com"
STAGING_DOMAIN="staging.sashyanaturals.com"
COMING_SOON_DIR="/var/www/coming_soon"
SSL_DIR="/etc/ssl/cloudflare"
NGINX_AVAILABLE="/etc/nginx/sites-available/${DOMAIN}"
NGINX_ENABLED="/etc/nginx/sites-enabled/${DOMAIN}"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: Please run as root (ssh root@189.72.179.46)." >&2
  exit 1
fi

if [ -s "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ] && [ -s "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" ]; then
  ACTIVE_SSL_CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
  ACTIVE_SSL_KEY="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
else
  ACTIVE_SSL_CERT="${SSL_DIR}/origin.pem"
  ACTIVE_SSL_KEY="${SSL_DIR}/origin.key"
fi

cat <<EOF > "${NGINX_AVAILABLE}"
# 1. Drop direct IP requests
server {
    listen 80 default_server;
    listen 443 ssl default_server;
    server_name _;
    ssl_certificate ${ACTIVE_SSL_CERT};
    ssl_certificate_key ${ACTIVE_SSL_KEY};
    return 444;
}

# 2. MAIN PUBLIC DOMAIN -> Strictly serves "Launching Soon" page ONLY (No staging proxy)
server {
    listen 80;
    listen 443 ssl;
    server_name ${DOMAIN} www.${DOMAIN};

    ssl_certificate ${ACTIVE_SSL_CERT};
    ssl_certificate_key ${ACTIVE_SSL_KEY};

    root ${COMING_SOON_DIR};
    index index.html;

    location / {
        add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet, noimageindex" always;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
        add_header Set-Cookie "sn_staging=0; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" always;
        try_files \$uri \$uri/ /index.html;
    }
}

# 3. STAGING SUBDOMAIN -> Forwards to Node.js Staging Server (:3021) (Unchanged)
server {
    listen 80;
    listen 443 ssl;
    server_name ${STAGING_DOMAIN};

    ssl_certificate ${ACTIVE_SSL_CERT};
    ssl_certificate_key ${ACTIVE_SSL_KEY};

    client_max_body_size 15M;

    location / {
        add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet, noimageindex" always;
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
nginx -t
systemctl reload nginx

echo "✓ https://${DOMAIN} and https://www.${DOMAIN} are now locked strictly to the 'Launching Soon' page."
echo "✓ https://${STAGING_DOMAIN} remains untouched on 127.0.0.1:3021."
