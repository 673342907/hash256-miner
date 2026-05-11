#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVENTORY_FILE="${INVENTORY_FILE:-$APP_DIR/workers.txt}"
MASTER_ENV_FILE="${MASTER_ENV_FILE:-$APP_DIR/.env.master}"
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
  ./fleet.sh bootstrap
  ./fleet.sh deploy
  ./fleet.sh set-master-host <host>
  ./fleet.sh restart
  ./fleet.sh status
  ./fleet.sh logs
  ./fleet.sh stop

Required files:
  .env.master
  workers.txt

workers.txt format:
  host|user|ssh_key|worker_name|threads|remote_dir
EOF
}

log() {
  printf '[fleet] %s\n' "$1"
}

fail() {
  printf '[fleet] error: %s\n' "$1" >&2
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
  local ssh_key="$1"
  local user_at_host="$2"
  local command="$3"
  ssh -o StrictHostKeyChecking=no -i "$ssh_key" "$user_at_host" "$command"
}

copy_package() {
  local ssh_key="$1"
  local user_at_host="$2"
  local remote_dir="$3"
  local tar_path
  tar_path="$(mktemp)"
  tar -C "$APP_DIR" -czf "$tar_path" "${PACKAGE_FILES[@]}"
  scp -o StrictHostKeyChecking=no -i "$ssh_key" "$tar_path" "${user_at_host}:/tmp/hash256-worker-package.tgz" >/dev/null
  rm -f "$tar_path"
  ssh_run "$ssh_key" "$user_at_host" "mkdir -p '$remote_dir' && tar -xzf /tmp/hash256-worker-package.tgz -C '$remote_dir' && rm -f /tmp/hash256-worker-package.tgz"
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

deploy_worker() {
  local host="$1"
  local user="$2"
  local ssh_key="$3"
  local worker_name="$4"
  local threads="$5"
  local remote_dir="$6"
  local user_at_host="${user}@${host}"
  local master_host master_port master_token runtime

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
  runtime="${WORKER_RUNTIME:-node}"

  log "deploying $worker_name to $host"
  copy_package "$ssh_key" "$user_at_host" "$remote_dir"

  local env_payload
  env_payload="$(render_worker_env "$master_host" "$master_port" "$master_token" "$worker_name" "$threads" "$runtime")"

  ssh_run "$ssh_key" "$user_at_host" "cat > '$remote_dir/.env.worker' <<'EOF'
$env_payload
EOF"

  ssh_run "$ssh_key" "$user_at_host" "chmod +x '$remote_dir/deploy-ubuntu.sh' '$remote_dir/start-worker.sh'"
  ssh_run "$ssh_key" "$user_at_host" "cd '$remote_dir' && if ! command -v node >/dev/null 2>&1; then curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs; fi"
  ssh_run "$ssh_key" "$user_at_host" "cd '$remote_dir' && if [[ '$runtime' == 'native' ]]; then if ! command -v cargo >/dev/null 2>&1; then curl https://sh.rustup.rs -sSf | sh -s -- -y; fi; export PATH=\"\$HOME/.cargo/bin:\$PATH\"; cargo build --release --manifest-path native-worker/Cargo.toml; fi"
  ssh_run "$ssh_key" "$user_at_host" "cd '$remote_dir' && npm install --omit=dev"
  ssh_run "$ssh_key" "$user_at_host" "cat > /etc/systemd/system/hash256-worker.service <<EOF
[Unit]
Description=HASH256 worker miner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$remote_dir
EnvironmentFile=$remote_dir/.env.worker
ExecStart=$remote_dir/start-worker.sh
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF"
  ssh_run "$ssh_key" "$user_at_host" "systemctl daemon-reload && systemctl enable --now hash256-worker"
}

restart_worker() {
  local host="$1"
  local user="$2"
  local ssh_key="$3"
  local user_at_host="${user}@${host}"
  log "restarting worker on $host"
  ssh_run "$ssh_key" "$user_at_host" "systemctl restart hash256-worker"
}

status_worker() {
  local host="$1"
  local user="$2"
  local ssh_key="$3"
  local user_at_host="${user}@${host}"
  log "status on $host"
  ssh_run "$ssh_key" "$user_at_host" "systemctl status hash256-worker --no-pager -l | tail -n 20"
}

logs_worker() {
  local host="$1"
  local user="$2"
  local ssh_key="$3"
  local user_at_host="${user}@${host}"
  log "logs on $host"
  ssh_run "$ssh_key" "$user_at_host" "journalctl -u hash256-worker -n 30 --no-pager"
}

stop_worker() {
  local host="$1"
  local user="$2"
  local ssh_key="$3"
  local user_at_host="${user}@${host}"
  log "stopping worker on $host"
  ssh_run "$ssh_key" "$user_at_host" "systemctl stop hash256-worker"
}

set_master_host_on_worker() {
  local host="$1"
  local user="$2"
  local ssh_key="$3"
  local remote_dir="$4"
  local new_master_host="$5"
  local user_at_host="${user}@${host}"
  log "updating MASTER_HOST on $host -> $new_master_host"
  ssh_run "$ssh_key" "$user_at_host" "sed -i 's/^MASTER_HOST=.*/MASTER_HOST=$new_master_host/' '$remote_dir/.env.worker' && systemctl restart hash256-worker"
}

bootstrap_inventory() {
  ensure_file "$MASTER_ENV_FILE"
  if [[ -f "$INVENTORY_FILE" ]]; then
    log "inventory already exists: $INVENTORY_FILE"
    return
  fi
  cp "$APP_DIR/workers.txt.example" "$INVENTORY_FILE"
  log "created inventory template: $INVENTORY_FILE"
}

run_for_all() {
  local action="$1"
  local extra_arg="${2:-}"
  ensure_file "$MASTER_ENV_FILE"
  ensure_file "$INVENTORY_FILE"

  while IFS='|' read -r host user ssh_key worker_name threads remote_dir; do
    [[ -z "${host// }" ]] && continue
    [[ "${host:0:1}" == "#" ]] && continue
    [[ -n "$host" && -n "$user" && -n "$ssh_key" && -n "$worker_name" && -n "$threads" && -n "$remote_dir" ]] || fail "bad inventory line for host '$host'"
    [[ -f "$ssh_key" ]] || fail "missing ssh key for $host: $ssh_key"

    case "$action" in
      deploy) deploy_worker "$host" "$user" "$ssh_key" "$worker_name" "$threads" "$remote_dir" ;;
      set-master-host) set_master_host_on_worker "$host" "$user" "$ssh_key" "$remote_dir" "$extra_arg" ;;
      restart) restart_worker "$host" "$user" "$ssh_key" ;;
      status) status_worker "$host" "$user" "$ssh_key" ;;
      logs) logs_worker "$host" "$user" "$ssh_key" ;;
      stop) stop_worker "$host" "$user" "$ssh_key" ;;
      *) fail "unsupported action: $action" ;;
    esac
  done < "$INVENTORY_FILE"
}

main() {
  local command="${1:-}"
  local extra_arg="${2:-}"
  case "$command" in
    bootstrap) bootstrap_inventory ;;
    deploy|restart|status|logs|stop) run_for_all "$command" ;;
    set-master-host)
      [[ -n "$extra_arg" ]] || fail "usage: ./fleet.sh set-master-host <host>"
      run_for_all "$command" "$extra_arg"
      ;;
    *) usage; exit 1 ;;
  esac
}

main "$@"
