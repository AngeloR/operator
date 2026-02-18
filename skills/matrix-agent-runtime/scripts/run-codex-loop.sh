#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

CONFIG_PATH="config.json"
if [[ $# -gt 0 && "$1" != "--" ]]; then
  CONFIG_PATH="$1"
  shift
fi

CODEX_ARGS=(--skip-git-repo-check)
if [[ $# -gt 0 && "$1" == "--" ]]; then
  shift
  if [[ $# -gt 0 ]]; then
    CODEX_ARGS=("$@")
  fi
fi

echo "matrix-agent-runtime loop started (config: $CONFIG_PATH)"

while true; do
  if ! "$SCRIPT_DIR/run-turn.sh" "$CONFIG_PATH" -- codex exec "${CODEX_ARGS[@]}"; then
    echo "run-turn failed; retrying in 2s" >&2
    sleep 2
    continue
  fi

  # poll is long-blocking, but this avoids a tight loop if poll timeout is 0.
  sleep 1
done
