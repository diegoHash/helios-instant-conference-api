#!/usr/bin/env bash
set -euo pipefail

domain=rtc.caribbean-one.site
public_ip=34.196.131.114
env_file=/etc/helios-conferences.env

resolved_ip="$(getent ahostsv4 "$domain" | awk 'NR == 1 { print $1 }')"
if [[ "$resolved_ip" != "$public_ip" ]]; then
  echo "DNS_NOT_READY: $domain resolves to ${resolved_ip:-nothing}; expected $public_ip" >&2
  exit 1
fi

if [[ ! -f "$env_file" ]]; then
  echo "Missing $env_file" >&2
  exit 1
fi

turn_secret="$(sudo awk -F= '$1 == "TURN_SHARED_SECRET" { print substr($0, index($0, "=") + 1) }' "$env_file")"
if [[ -z "$turn_secret" ]]; then
  echo "TURN_SHARED_SECRET is missing" >&2
  exit 1
fi

api_key="$(openssl rand -hex 12)"
api_secret="$(openssl rand -hex 32)"
sudo sed -e "s/__LIVEKIT_API_KEY__/$api_key/" -e "s/__LIVEKIT_API_SECRET__/$api_secret/" \
  /home/ec2-user/livekit.yaml.example | sudo tee /etc/helios-livekit.yaml >/dev/null
printf '%s' "$turn_secret" | sudo tee /etc/helios-livekit-turn-secret >/dev/null
sudo chmod 600 /etc/helios-livekit.yaml /etc/helios-livekit-turn-secret

sudo tee -a "$env_file" >/dev/null <<EOF
LIVEKIT_API_URL=http://127.0.0.1:7880
LIVEKIT_WS_URL=wss://$domain
LIVEKIT_API_KEY=$api_key
LIVEKIT_API_SECRET=$api_secret
LIVEKIT_TOKEN_TTL_SECONDS=3600
LIVEKIT_MAX_PARTICIPANTS=10
EOF

sudo install -m 644 /home/ec2-user/helios-livekit.service /etc/systemd/system/helios-livekit.service
sudo install -m 644 /home/ec2-user/nginx-livekit.conf.example /etc/nginx/conf.d/helios-livekit.conf
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now helios-livekit.service
sudo systemctl reload nginx
sudo certbot --nginx --non-interactive --agree-tos --redirect -m admin@caribbean-one.site -d "$domain"
sudo systemctl restart helios-conferences.service
curl --fail --silent --show-error http://127.0.0.1:7880/ >/dev/null || true
sudo systemctl is-active --quiet helios-livekit.service
