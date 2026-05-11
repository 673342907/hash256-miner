#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mode="${WORKER_RUNTIME:-node}"

if [[ "$mode" == "native" ]]; then
  exec ./native-worker/target/release/hash256-native-worker
fi

if [[ "$mode" == "gpu" ]]; then
  exec node hash256-gpu-worker.mjs
fi

exec node hash256-mine.mjs worker
