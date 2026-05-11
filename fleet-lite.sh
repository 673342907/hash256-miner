#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IPS_FILE="${IPS_FILE:-$APP_DIR/ips.txt}"
MASTER_ENV_FILE="${MASTER_ENV_FILE:-$APP_DIR/.env.master}"

SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-/root/.ssh/worker.pem}"
REMOTE_DIR="${REMOTE_DIR:-/opt/hash256-miner}"
WORKER_PREFIX="${WORKER_PREFIX:-worker}"

PACKAGE_FILES=(
  "hash256-mine.mjs"
  "hash_miner.js"
  "hash_miner_bg.wasm"
  "native-worker"
  "package.json"
  "package-lock.json"
  ".env.worker.example"
  "hash256-worker.service"
  "deploy-ubuntu.sh"
  "start-worker.sh"
  "README.md"
)

usage() {
  cat <<'EOF'
Usage:
  ./fleet-lite.sh bootstrap
  ./fleet-lite.sh deploy
  ./fleet-lite.sh set-master-host <host>
  ./fleet-lite.sh restart
  ./fleet-lite.sh status
  ./fleet-lite.sh logs
  ./fleet-lite.sh stop

Defaults:
  SSH_USER=root
  SSH_KEY=/root/.ssh/worker.pem
  REMOTE_DIR=/opt/hash256-miner
  WORKER_PREFIX=worker

Required files:
  .env.master
  ips.txt
EOF
}

log() {
  printf '[fleet-lite] %s\n' "$1"
}

fail() {
  printf '[fleet-lite] error: %s\n' "$1" >&2
  exit 1
}

ensure_file() {
  [[ -f "$1" ]] || fail "missing file: $1"
}

master_env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, "", $0); print $0 }' "$MASTER_ENV_FILE"
}

ssh_run() {
  local host="$1"
  local command="$2"
  ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "${SSH_USER}@${host}" "$command"
}

copy_package() {
  local host="$1"
  local tar_path
  tar_path="$(mktemp)"
  tar -C "$APP_DIR" -czf "$tar_path" "${PACKAGE_FILES[@]}"
  scp -o StrictHostKeyChecking=no -i "$SSH_KEY" "$tar_path" "${SSH_USER}@${host}:/tmp/hash256-worker-package.tgz" >/dev/null
  rm -f "$tar_path"
  ssh_run "$host" "mkdir -p '$REMOTE_DIR' && tar -xzf /tmp/hash256-worker-package.tgz -C '$REMOTE_DIR' && rm -f /tmp/hash256-worker-package.tgz"
}

render_worker_env() {
  local master_host="$1"
  local master_port="$2"
  local master_token="$3"
  local worker_name="$4"
  local threads="$5"
  local runtime="${6:-native}"
  cat <<EOF
MASTER_HOST=$master_host
MASTER_PORT=$master_port
MASTER_TOKEN=$master_token
AGENT_NAME=$worker_name
WORKERS=${threads:-auto}
BATCH_SIZE=250000
WORKER_RUNTIME=$runtime
EOF
}

deploy_host() {
  local host="$1"
  local index="$2"
  local master_host master_port master_token worker_name threads env_payload runtime

  master_host="$(master_env_value MASTER_PUBLIC_HOST)"
  if [[ -z "$master_host" ]]; then
    master_host="$(master_env_value MASTER_HOST)"
  fi
  if [[ -z "$master_host" ]]; then
    master_host="$(master_env_value MASTER_BIND_HOST)"
  fi
  master_port="$(master_env_value MASTER_PORT)"
  master_token="$(master_env_value MASTER_TOKEN)"

  if [[ "$master_host" == "0.0.0.0" ]]; then
    fail "master public host resolves to 0.0.0.0. Set MASTER_PUBLIC_HOST in .env.master."
  fi

  worker_name="${WORKER_PREFIX}-$(printf '%02d' "$index")"
  runtime="${WORKER_RUNTIME:-node}"

  log "deploying $worker_name to $host"
  copy_package "$host"

  threads="$(ssh_run "$host" "nproc")"
  env_payload="$(render_worker_env "$master_host" "$master_port" "$master_token" "$worker_name" "$threads" "$runtime")"

  ssh_run "$host" "cat > '$REMOTE_DIR/.env.worker' <<'EOF'
$env_payload
EOF"

  ssh_run "$host" "chmod +x '$REMOTE_DIR/deploy-ubuntu.sh' '$REMOTE_DIR/start-worker.sh'"
  ssh_run "$host" "cd '$REMOTE_DIR' && if ! command -v node >/dev/null 2>&1; then curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs; fi"
  ssh_run "$host" "cd '$REMOTE_DIR' && if [[ '$runtime' == 'native' ]]; then if ! command -v cargo >/dev/null 2>&1; then curl https://sh.rustup.rs -sSf | sh -s -- -y; fi; export PATH=\"\$HOME/.cargo/bin:\$PATH\"; cargo build --release --manifest-path native-worker/Cargo.toml; fi"
  ssh_run "$host" "cd '$REMOTE_DIR' && npm install --omit=dev"
  ssh_run "$host" "cat > /etc/systemd/system/hash256-worker.service <<EOF
[Unit]
Description=HASH256 worker miner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REMOTE_DIR
EnvironmentFile=$REMOTE_DIR/.env.worker
ExecStart=$REMOTE_DIR/start-worker.sh
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF"
  ssh_run "$host" "systemctl daemon-reload && systemctl enable --now hash256-worker"
}

restart_host() {
  local host="$1"
  log "restarting worker on $host"
  ssh_run "$host" "systemctl restart hash256-worker"
}

status_host() {
  local host="$1"
  log "status on $host"
  ssh_run "$host" "systemctl status hash256-worker --no-pager -l | tail -n 20"
}

logs_host() {
  local host="$1"
  log "logs on $host"
  ssh_run "$host" "journalctl -u hash256-worker -n 30 --no-pager"
}

stop_host() {
  local host="$1"
  log "stopping worker on $host"
  ssh_run "$host" "systemctl stop hash256-worker"
}

set_master_host_on_worker() {
  local host="$1"
  local new_master_host="$2"
  log "updating MASTER_HOST on $host -> $new_master_host"
  ssh_run "$host" "sed -i 's/^MASTER_HOST=.*/MASTER_HOST=$new_master_host/' '$REMOTE_DIR/.env.worker' && systemctl restart hash256-worker"
}

bootstrap_ips() {
  ensure_file "$MASTER_ENV_FILE"
  ensure_file "$SSH_KEY"
  if [[ -f "$IPS_FILE" ]]; then
    log "ip list already exists: $IPS_FILE"
    return
  fi
  cp "$APP_DIR/ips.txt.example" "$IPS_FILE"
  log "created IP template: $IPS_FILE"
}

run_for_all() {
  local action="$1"
  local extra_arg="${2:-}"
  local host index

  ensure_file "$MASTER_ENV_FILE"
  ensure_file "$IPS_FILE"
  ensure_file "$SSH_KEY"

  index=1
  while IFS= read -r host; do
    host="${host//[$'\r\t ']}"
    [[ -z "$host" ]] && continue
    [[ "${host:0:1}" == "#" ]] && continue

    case "$action" in
      deploy) deploy_host "$host" "$index" ;;
      set-master-host) set_master_host_on_worker "$host" "$extra_arg" ;;
      restart) restart_host "$host" ;;
      status) status_host "$host" ;;
      logs) logs_host "$host" ;;
      stop) stop_host "$host" ;;
      *) fail "unsupported action: $action" ;;
    esac
    index=$((index + 1))
  done < "$IPS_FILE"
}

main() {
  local command="${1:-}"
  local extra_arg="${2:-}"
  case "$command" in
    bootstrap) bootstrap_ips ;;
    deploy|restart|status|logs|stop) run_for_all "$command" ;;
    set-master-host)
      [[ -n "$extra_arg" ]] || fail "usage: ./fleet-lite.sh set-master-host <host>"
      run_for_all "$command" "$extra_arg"
      ;;
    *) usage; exit 1 ;;
  esac
}

main "$@"
