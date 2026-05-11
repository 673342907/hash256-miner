#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node hash256-mine.mjs master
