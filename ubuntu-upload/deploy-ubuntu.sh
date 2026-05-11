#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MASTER_ENV="$APP_DIR/.env.master"
WORKER_ENV="$APP_DIR/.env.worker"
MASTER_SERVICE_PATH="/etc/systemd/system/hash256-master.service"
WORKER_SERVICE_PATH="/etc/systemd/system/hash256-worker.service"

if [[ "${EUID}" -eq 0 ]]; then
  SUDO=""
else
  SUDO="sudo"
fi

log() {
  printf '[deploy] %s\n' "$1"
}

fail() {
  printf '[deploy] error: %s\n' "$1" >&2
  exit 1
}

prompt() {
  local label="$1"
  local default_value="${2:-}"
  local result
  if [[ -n "$default_value" ]]; then
    read -r -p "$label [$default_value]: " result
    printf '%s' "${result:-$default_value}"
  else
    read -r -p "$label: " result
    printf '%s' "$result"
  fi
}

prompt_secret() {
  local label="$1"
  local result
  read -r -s -p "$label: " result
  printf '\n' >&2
  printf '%s' "$result"
}

ensure_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

ensure_system_packages() {
  ensure_cmd bash
  ensure_cmd sed
  ensure_cmd awk
  ensure_cmd systemctl
  ensure_cmd curl
  ensure_cmd openssl
}

ensure_node() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    log "node detected: $(node -v)"
    return
  fi

  ensure_cmd apt-get
  log "node not found, installing Node.js 20"
  if [[ -n "$SUDO" ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
  else
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  fi
  $SUDO apt-get install -y nodejs
  log "node installed: $(node -v)"
}

install_dependencies() {
  log "installing npm dependencies"
  cd "$APP_DIR"
  npm install --omit=dev
}

write_master_env() {
  local rpc_url="$1"
  local bind_host="$2"
  local port="$3"
  local token="$4"
  local private_key="$5"
  local min_gas_balance="$6"
  local public_host="$7"

  cat > "$MASTER_ENV" <<EOF
RPC_URL=$rpc_url
MASTER_BIND_HOST=$bind_host
MASTER_PUBLIC_HOST=$public_host
MASTER_PORT=$port
MASTER_TOKEN=$token
PRIVATE_KEY=$private_key
MIN_GAS_BALANCE=$min_gas_balance
EOF
}

write_worker_env() {
  local host="$1"
  local port="$2"
  local token="$3"
  local agent_name="$4"
  local workers="$5"
  local batch_size="$6"

cat > "$WORKER_ENV" <<EOF
MASTER_HOST=$host
MASTER_PORT=$port
MASTER_TOKEN=$token
AGENT_NAME=$agent_name
WORKERS=$workers
BATCH_SIZE=$batch_size
EOF
}

install_master_service() {
  local service_file
  service_file="$(mktemp)"
  cat > "$service_file" <<EOF
[Unit]
Description=HASH256 master miner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$MASTER_ENV
ExecStart=/usr/bin/node $APP_DIR/hash256-mine.mjs master
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

  $SUDO cp "$service_file" "$MASTER_SERVICE_PATH"
  rm -f "$service_file"
}

install_worker_service() {
  local service_file
  service_file="$(mktemp)"
  cat > "$service_file" <<EOF
[Unit]
Description=HASH256 worker miner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$WORKER_ENV
ExecStart=/usr/bin/node $APP_DIR/hash256-mine.mjs worker
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

  $SUDO cp "$service_file" "$WORKER_SERVICE_PATH"
  rm -f "$service_file"
}

reload_systemd() {
  $SUDO systemctl daemon-reload
}

enable_and_restart_service() {
  local service_name="$1"
  $SUDO systemctl enable "$service_name" >/dev/null 2>&1 || true
  $SUDO systemctl restart "$service_name"
}

generate_wallet_if_needed() {
  if [[ -f "$APP_DIR/hash256-wallet.json" ]]; then
    log "wallet file already exists: $APP_DIR/hash256-wallet.json"
    return
  fi

  log "no wallet file found, generating one"
  cd "$APP_DIR"
  node hash256-mine.mjs wallet
}

show_finish_notes() {
  cat <<EOF

[deploy] done

Useful commands:
  sudo systemctl status hash256-master --no-pager -l
  sudo systemctl status hash256-worker --no-pager -l
  sudo journalctl -u hash256-master -f
  sudo journalctl -u hash256-worker -f

Wallet note:
  PRIVATE_KEY must be an Ethereum wallet private key.
  It is NOT your SSH server key.

EOF
}

pick_mode() {
  cat >&2 <<'EOF'
Choose deployment mode:
  1) master + local worker (recommended for a single server)
  2) master only
  3) worker only
EOF
  prompt "Enter mode number" "1"
}

main() {
  ensure_system_packages
  ensure_node
  install_dependencies

  local mode
  mode="$(pick_mode)"

  case "$mode" in
    1)
      local rpc_url bind_host public_host port token private_key min_gas_balance worker_threads batch_size
      rpc_url="$(prompt "Ethereum mainnet RPC URL" "https://ethereum-rpc.publicnode.com")"
      bind_host="$(prompt "Master bind host" "0.0.0.0")"
      public_host="$(prompt "Master public host or IP for remote workers" "127.0.0.1")"
      port="$(prompt "Master port" "7331")"
      token="$(prompt "Master token (leave blank to auto-generate)" "$(openssl rand -hex 24)")"
      private_key="$(prompt_secret "Ethereum wallet private key (0x...)")"
      if [[ -z "$private_key" ]]; then
        generate_wallet_if_needed
        fail "blank private key is not supported for one-click deploy. Open hash256-wallet.json and rerun with that private key."
      fi
      min_gas_balance="$(prompt "Minimum ETH balance for gas" "0.001")"
      worker_threads="$(prompt "Local worker thread count (use auto for nproc)" "auto")"
      batch_size="$(prompt "Batch size per local miner thread" "250000")"

      write_master_env "$rpc_url" "$bind_host" "$port" "$token" "$private_key" "$min_gas_balance" "$public_host"
      write_worker_env "127.0.0.1" "$port" "$token" "auto" "$worker_threads" "$batch_size"
      install_master_service
      install_worker_service
      reload_systemd
      enable_and_restart_service hash256-master
      enable_and_restart_service hash256-worker
      ;;
    2)
      local rpc_url bind_host public_host port token private_key min_gas_balance
      rpc_url="$(prompt "Ethereum mainnet RPC URL" "https://ethereum-rpc.publicnode.com")"
      bind_host="$(prompt "Master bind host" "0.0.0.0")"
      public_host="$(prompt "Master public host or IP for remote workers" "127.0.0.1")"
      port="$(prompt "Master port" "7331")"
      token="$(prompt "Master token (leave blank to auto-generate)" "$(openssl rand -hex 24)")"
      private_key="$(prompt_secret "Ethereum wallet private key (0x...)")"
      if [[ -z "$private_key" ]]; then
        generate_wallet_if_needed
        fail "blank private key is not supported for one-click deploy. Open hash256-wallet.json and rerun with that private key."
      fi
      min_gas_balance="$(prompt "Minimum ETH balance for gas" "0.001")"

      write_master_env "$rpc_url" "$bind_host" "$port" "$token" "$private_key" "$min_gas_balance" "$public_host"
      install_master_service
      reload_systemd
      enable_and_restart_service hash256-master
      ;;
    3)
      local master_host port token agent_name worker_threads batch_size
      master_host="$(prompt "Master host or IP" "127.0.0.1")"
      port="$(prompt "Master port" "7331")"
      token="$(prompt_secret "Master token")"
      agent_name="$(prompt "Worker name" "$(hostname)-worker")"
      worker_threads="$(prompt "Worker thread count (use auto for nproc)" "auto")"
      batch_size="$(prompt "Batch size per local miner thread" "250000")"

      write_worker_env "$master_host" "$port" "$token" "$agent_name" "$worker_threads" "$batch_size"
      install_worker_service
      reload_systemd
      enable_and_restart_service hash256-worker
      ;;
    *)
      fail "unsupported mode: $mode"
      ;;
  esac

  show_finish_notes
}

main "$@"
