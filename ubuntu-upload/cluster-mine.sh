#!/usr/bin/env bash
# HASH256 群控挖矿（Ubuntu）
# 与 https://hash256.org/mine 同源逻辑：链上合约挖矿，本仓库用 Node 主从替代浏览器算力。
# 架构：一台 master（钱包 + 出块提交） + 多台 worker（只连 master 领任务）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# 默认用 Node/WASM 路径，避免 fleet 在每台机器上编译 Rust（百台 worker 时极慢）。
export WORKER_RUNTIME="${WORKER_RUNTIME:-node}"

# 设为 1 时使用多列清单 workers.txt + fleet.sh
USE_FULL_FLEET="${USE_FULL_FLEET:-0}"

usage() {
  cat <<'EOF'
用法:
  ./cluster-mine.sh check-master          检查 .env.master 中公网可达配置
  ./cluster-mine.sh init                  生成 ips.txt / workers.txt 模板（若不存在）
  ./cluster-mine.sh fleet <子命令>       转发到群控脚本（默认 fleet-lite.sh）
  ./cluster-mine.sh report                在主控机执行 npm run report（需 journalctl 里 master 日志）

环境变量:
  USE_FULL_FLEET=1     使用 fleet.sh + workers.txt（每行 host|user|key|name|threads|dir）
  WORKER_RUNTIME=node  默认；若要用 Rust 原生 worker 设为 native

示例（主控机已跑 hash256-master，且 .env.master 里 MASTER_PUBLIC_HOST 为公网 IP）:
  ./cluster-mine.sh init
  nano ips.txt
  chmod +x fleet-lite.sh
  SSH_KEY=/root/.ssh/workers.pem ./cluster-mine.sh fleet deploy
  ./cluster-mine.sh fleet status
EOF
}

log() { printf '[cluster-mine] %s\n' "$1"; }
fail() { printf '[cluster-mine] 错误: %s\n' "$1" >&2; exit 1; }

env_value() {
  local key="$1"
  local file="${2:-$ROOT/.env.master}"
  [[ -f "$file" ]] || { printf ''; return; }
  awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/, "", $0); print $0; exit }' "$file"
}

cmd_check_master() {
  local f="$ROOT/.env.master"
  [[ -f "$f" ]] || fail "缺少 $f，请先在主控机运行: chmod +x deploy-ubuntu.sh && ./deploy-ubuntu.sh（选 master 或 master+worker）"

  local pub bind port token
  pub="$(env_value MASTER_PUBLIC_HOST "$f")"
  bind="$(env_value MASTER_BIND_HOST "$f")"
  port="$(env_value MASTER_PORT "$f")"
  token="$(env_value MASTER_TOKEN "$f")"

  log "MASTER_BIND_HOST=${bind:-?}"
  log "MASTER_PUBLIC_HOST=${pub:-?}"
  log "MASTER_PORT=${port:-7331}"
  if [[ -z "$token" ]]; then
    log "警告: MASTER_TOKEN 为空，任意客户端可连你的 master 端口，请设置强随机 token 并配防火墙。"
  fi

  if [[ "$pub" == "0.0.0.0" ]]; then
    fail "MASTER_PUBLIC_HOST 不能是 0.0.0.0，请改为 worker 能访问的公网 IP 或域名。"
  fi
  if [[ "$pub" == "127.0.0.1" || "$pub" == "localhost" ]]; then
    log "警告: MASTER_PUBLIC_HOST=$pub 时，其它机器上的 worker 无法连接；仅本机 worker 可用。"
  fi
  log "检查通过（请确认云安全组/防火墙已放行 TCP ${port:-7331}）。"
}

cmd_init() {
  [[ -f "$ROOT/.env.master" ]] || fail "请先创建 .env.master（运行 ./deploy-ubuntu.sh 或从 .env.master.example 复制并填写）"
  if [[ "$USE_FULL_FLEET" == "1" ]]; then
    if [[ ! -f "$ROOT/workers.txt" ]]; then
      [[ -f "$ROOT/workers.txt.example" ]] || fail "缺少 workers.txt.example"
      cp "$ROOT/workers.txt.example" "$ROOT/workers.txt"
      log "已创建 workers.txt，请编辑后执行 fleet deploy"
    else
      log "workers.txt 已存在，跳过"
    fi
  else
    if [[ ! -f "$ROOT/ips.txt" ]]; then
      [[ -f "$ROOT/ips.txt.example" ]] || fail "缺少 ips.txt.example"
      cp "$ROOT/ips.txt.example" "$ROOT/ips.txt"
      log "已创建 ips.txt，请填入 worker 公网 IP（每行一个）后执行 fleet deploy"
    else
      log "ips.txt 已存在，跳过"
    fi
  fi
}

fleet_script() {
  if [[ "$USE_FULL_FLEET" == "1" ]]; then
    printf '%s/fleet.sh' "$ROOT"
  else
    printf '%s/fleet-lite.sh' "$ROOT"
  fi
}

cmd_fleet() {
  local script
  script="$(fleet_script)"
  [[ -x "$script" ]] || chmod +x "$script"
  [[ $# -ge 1 ]] || { usage; exit 1; }
  exec "$script" "$@"
}

cmd_report() {
  command -v npm >/dev/null 2>&1 || fail "未找到 npm"
  npm run report --prefix "$ROOT"
}

main() {
  local sub="${1:-}"
  shift || true
  case "$sub" in
    check-master) cmd_check_master ;;
    init) cmd_init ;;
    fleet) cmd_fleet "$@" ;;
    report) cmd_report ;;
    help|-h|--help|"") usage ;;
    *) fail "未知子命令: $sub（运行 ./cluster-mine.sh help）" ;;
  esac
}

main "$@"
