#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="hash256-solo-gpu"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

if [[ "${EUID}" -eq 0 ]]; then
  SUDO=""
else
  SUDO="sudo"
fi

log() {
  printf '[solo-gpu-service] %s\n' "$1"
}

fail() {
  printf '[solo-gpu-service] error: %s\n' "$1" >&2
  exit 1
}

ensure_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

ensure_prereqs() {
  ensure_cmd node
  ensure_cmd systemctl
  [[ -f "$APP_DIR/.env.solo-gpu" ]] || fail "missing $APP_DIR/.env.solo-gpu"
  [[ -f "$APP_DIR/hash256-solo-gpu.mjs" ]] || fail "missing hash256-solo-gpu.mjs"
}

install_service() {
  local service_file
  service_file="$(mktemp)"
  cat > "$service_file" <<EOF
[Unit]
Description=HASH256 solo GPU miner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) $APP_DIR/hash256-solo-gpu.mjs
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

  $SUDO cp "$service_file" "$SERVICE_PATH"
  rm -f "$service_file"
}

main() {
  ensure_prereqs
  install_service
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now "$SERVICE_NAME"
  log "installed and started $SERVICE_NAME"
  log "view logs: sudo journalctl -u $SERVICE_NAME -f"
  log "status: sudo systemctl status $SERVICE_NAME --no-pager -l"
}

main "$@"
