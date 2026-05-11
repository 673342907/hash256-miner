#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_DIR="$APP_DIR/.run"
LOG_DIR="$APP_DIR/logs"
PID_FILE="$PID_DIR/hash256-solo-gpu.pid"
LOG_FILE="$LOG_DIR/hash256-solo-gpu.log"

log() {
  printf '[solo-gpu-daemon] %s\n' "$1"
}

fail() {
  printf '[solo-gpu-daemon] error: %s\n' "$1" >&2
  exit 1
}

ensure_prereqs() {
  command -v node >/dev/null 2>&1 || fail "missing node"
  [[ -f "$APP_DIR/.env.solo-gpu" ]] || fail "missing $APP_DIR/.env.solo-gpu"
  [[ -f "$APP_DIR/hash256-solo-gpu.mjs" ]] || fail "missing hash256-solo-gpu.mjs"
  mkdir -p "$PID_DIR" "$LOG_DIR"
}

is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

start_daemon() {
  ensure_prereqs

  if is_running; then
    log "already running with pid $(cat "$PID_FILE")"
    return 0
  fi

  if [[ -f "$PID_FILE" ]]; then
    rm -f "$PID_FILE"
  fi

  nohup node "$APP_DIR/hash256-solo-gpu.mjs" >>"$LOG_FILE" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  sleep 1

  if kill -0 "$pid" 2>/dev/null; then
    log "started pid=$pid"
    log "log file: $LOG_FILE"
  else
    rm -f "$PID_FILE"
    fail "process exited immediately, check $LOG_FILE"
  fi
}

stop_daemon() {
  if ! is_running; then
    log "not running"
    rm -f "$PID_FILE"
    return 0
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid" 2>/dev/null || true

  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      log "stopped pid=$pid"
      return 0
    fi
    sleep 1
  done

  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  log "force killed pid=$pid"
}

status_daemon() {
  if is_running; then
    local pid
    pid="$(cat "$PID_FILE")"
    log "running pid=$pid"
    return 0
  fi
  log "not running"
  return 1
}

logs_daemon() {
  ensure_prereqs
  touch "$LOG_FILE"
  tail -f "$LOG_FILE"
}

case "${1:-}" in
  start)
    start_daemon
    ;;
  stop)
    stop_daemon
    ;;
  restart)
    stop_daemon
    start_daemon
    ;;
  status)
    status_daemon
    ;;
  logs)
    logs_daemon
    ;;
  *)
    cat <<'EOF'
Usage:
  ./solo-gpu-daemon.sh start
  ./solo-gpu-daemon.sh stop
  ./solo-gpu-daemon.sh restart
  ./solo-gpu-daemon.sh status
  ./solo-gpu-daemon.sh logs
EOF
    exit 1
    ;;
esac
