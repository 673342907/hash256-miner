#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec node hash256-solo-gpu.mjs
