#!/usr/bin/env bash
set -euo pipefail

load_runtime_config() {
  local config_path="$1"

  if [[ ! -f "$config_path" ]]; then
    echo "runtime config not found: $config_path" >&2
    return 1
  fi

  eval "$(python3 - "$config_path" <<'PY'
import json
import shlex
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    cfg = json.load(f)

def text(name, default=None, required=False):
    value = cfg.get(name, default)
    if value is None and required:
        raise SystemExit(f"missing required config key: {name}")
    if value is None:
        return ""
    if not isinstance(value, str):
        raise SystemExit(f"config key {name} must be a string")
    value = value.strip()
    if required and not value:
        raise SystemExit(f"config key {name} cannot be empty")
    return value

def intval(name, default):
    value = cfg.get(name, default)
    if isinstance(value, bool):
        raise SystemExit(f"config key {name} must be an integer")
    try:
        n = int(value)
    except Exception:
        raise SystemExit(f"config key {name} must be an integer")
    if n < 0:
        raise SystemExit(f"config key {name} must be >= 0")
    return n

project = text("project", required=True)
agent = text("agent", required=True)
relay_base_url = text("relay_base_url", required=True).rstrip("/")
agent_api_token = text("agent_api_token", required=True)
poll_block_seconds = intval("poll_block_seconds", 30)
context_tail_lines = intval("context_tail_lines", 50)
state_dir = text("state_dir", default=".matrix-agent-state")
if not state_dir:
    state_dir = ".matrix-agent-state"

pairs = {
    "MATRIX_PROJECT": project,
    "MATRIX_AGENT": agent,
    "MATRIX_RELAY_BASE_URL": relay_base_url,
    "MATRIX_AGENT_API_TOKEN": agent_api_token,
    "MATRIX_POLL_BLOCK_SECONDS": str(poll_block_seconds),
    "MATRIX_CONTEXT_TAIL_LINES": str(context_tail_lines),
    "MATRIX_STATE_DIR": state_dir,
}

for key, value in pairs.items():
    print(f"{key}={shlex.quote(value)}")
PY
)"
}
