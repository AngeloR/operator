#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

CONFIG_PATH="config.json"
if [[ $# -gt 0 && "$1" != "--" ]]; then
  CONFIG_PATH="$1"
  shift
fi

load_runtime_config "$CONFIG_PATH"

if [[ $# -gt 0 ]]; then
  MESSAGE="$*"
else
  MESSAGE="$(cat)"
fi

if [[ -z "${MESSAGE//[[:space:]]/}" ]]; then
  echo "send failed: message is empty" >&2
  exit 1
fi

python3 - <<'PY' \
  "$MATRIX_PROJECT" \
  "$MATRIX_AGENT" \
  "$MATRIX_RELAY_BASE_URL" \
  "$MATRIX_AGENT_API_TOKEN" \
  "$MESSAGE"
import json
import sys
import urllib.request

project, agent, base_url, token, message = sys.argv[1:]
body = json.dumps(
    {
        "project": project,
        "agent": agent,
        "markdown": message,
        "format": "markdown",
    }
).encode("utf-8")

req = urllib.request.Request(
    f"{base_url}/v1/agent/send",
    data=body,
    headers={
        "content-type": "application/json",
        "authorization": f"Bearer {token}",
    },
    method="POST",
)

try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        print(resp.read().decode("utf-8"))
except urllib.error.HTTPError as e:
    payload = e.read().decode("utf-8", errors="replace")
    raise SystemExit(f"send failed: HTTP {e.code}: {payload}")
except Exception as e:
    raise SystemExit(f"send failed: {e}")
PY
