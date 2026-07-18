#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/home/ec2-user/helios-instant-conferences-backend
RELEASE=/home/ec2-user/helios-conferences-release.tgz
ENV_FILE=/etc/helios-conferences.env

mkdir -p "$APP_DIR"
tar -xzf "$RELEASE" -C "$APP_DIR"
cd "$APP_DIR"
npm ci --omit=dev

if [[ ! -f "$ENV_FILE" ]]; then
  turn_secret="$(openssl rand -hex 48)"
  sudo install -m 600 -o root -g root /dev/null "$ENV_FILE"
  sudo tee "$ENV_FILE" >/dev/null <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
ALLOWED_ORIGINS=https://caribbean-one.site,https://www.caribbean-one.site
STUN_URLS=stun:turn.caribbean-one.site:3478
TURN_URLS=turn:turn.caribbean-one.site:3478?transport=udp,turn:turn.caribbean-one.site:3478?transport=tcp,turns:turn.caribbean-one.site:5349?transport=tcp
TURN_SHARED_SECRET=$turn_secret
TURN_CREDENTIAL_TTL_SECONDS=43200
MAX_ROOM_PARTICIPANTS=2
MAX_MESSAGE_BYTES=65536
MAX_MESSAGES_PER_WINDOW=120
RATE_LIMIT_WINDOW_MS=10000
EOF
fi

sudo install -m 644 /home/ec2-user/helios-conferences.service /etc/systemd/system/helios-conferences.service
sudo install -m 644 /home/ec2-user/nginx.conf.example /etc/nginx/conf.d/helios-conferences.conf
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now helios-conferences.service
sudo systemctl reload nginx
curl --fail --silent --show-error http://127.0.0.1:8787/health
rm -f "$RELEASE"
