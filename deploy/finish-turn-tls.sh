#!/usr/bin/env bash
set -euo pipefail

DOMAIN=turn.caribbean-one.site
ENV_FILE=/etc/helios-conferences.env
TURN_CONFIG=/etc/coturn/turnserver.conf

if ! sudo test -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem"; then
  echo "Public certificate for $DOMAIN is missing" >&2
  exit 1
fi

turn_secret="$(sudo sed -n 's/^TURN_SHARED_SECRET=//p' "$ENV_FILE")"
if [[ -z "$turn_secret" ]]; then
  echo "TURN_SHARED_SECRET is missing" >&2
  exit 1
fi

sudo install -d -m 755 /etc/coturn
sudo tee "$TURN_CONFIG" >/dev/null <<EOF
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
relay-ip=172.31.42.86
external-ip=34.196.131.114/172.31.42.86
realm=$DOMAIN
server-name=$DOMAIN
fingerprint
use-auth-secret
static-auth-secret=$turn_secret
stale-nonce=600
min-port=49160
max-port=49200
cert=/etc/coturn/cert.pem
pkey=/etc/coturn/key.pem
no-multicast-peers
simple-log
log-file=stdout
EOF
sudo chown 65534:65534 "$TURN_CONFIG"
sudo chmod 600 "$TURN_CONFIG"
sudo install -m 644 -o 65534 -g 65534 "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" /etc/coturn/cert.pem
sudo install -m 600 -o 65534 -g 65534 "/etc/letsencrypt/live/$DOMAIN/privkey.pem" /etc/coturn/key.pem

sudo install -m 644 /home/ec2-user/helios-coturn.service /etc/systemd/system/helios-coturn.service
sudo install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/restart-helios-coturn.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
install -m 644 -o 65534 -g 65534 /etc/letsencrypt/live/turn.caribbean-one.site/fullchain.pem /etc/coturn/cert.pem
install -m 600 -o 65534 -g 65534 /etc/letsencrypt/live/turn.caribbean-one.site/privkey.pem /etc/coturn/key.pem
systemctl restart helios-coturn.service
EOF
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/restart-helios-coturn.sh

sudo systemctl daemon-reload
sudo systemctl enable helios-coturn.service
sudo systemctl restart helios-coturn.service
sudo systemctl enable --now certbot-renew.timer
