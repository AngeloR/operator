#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

CONFIG_PATH="${1:-config.json}"
load_runtime_config "$CONFIG_PATH"

python3 - <<'PY' \
  "$MATRIX_PROJECT" \
  "$MATRIX_AGENT" \
  "$MATRIX_POLL_BLOCK_SECONDS" \
  "$MATRIX_RELAY_BASE_URL" \
  "$MATRIX_AGENT_API_TOKEN"
import json
import sys
import urllib.request

project, agent, block_seconds, base_url, token = sys.argv[1:]
body = json.dumps(
    {
        "project": project,
        "agent": agent,
        "block_seconds": int(block_seconds),
    }
).encode("utf-8")

req = urllib.request.Request(
    f"{base_url}/v1/agent/poll",
    data=body,
    headers={
        "content-type": "application/json",
        "authorization": f"Bearer {token}",
    },
    method="POST",
)

try:
    with urllib.request.urlopen(req, timeout=max(35, int(block_seconds) + 5)) as resp:
        print(resp.read().decode("utf-8"))
except urllib.error.HTTPError as e:
    payload = e.read().decode("utf-8", errors="replace")
    raise SystemExit(f"poll failed: HTTP {e.code}: {payload}")
except Exception as e:
    raise SystemExit(f"poll failed: {e}")
PY
