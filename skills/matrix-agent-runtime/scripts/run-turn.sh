#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

CONFIG_PATH="config.json"
if [[ $# -gt 0 && "$1" != "--" ]]; then
  CONFIG_PATH="$1"
  shift
fi

RUN_CMD=()
if [[ $# -gt 0 && "$1" == "--" ]]; then
  shift
  if [[ $# -gt 0 ]]; then
    RUN_CMD=("$@")
  fi
fi

# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"
load_runtime_config "$CONFIG_PATH"

mkdir -p "$MATRIX_STATE_DIR"
INBOX_LOG="$MATRIX_STATE_DIR/inbox.log"
OUTBOX_LOG="$MATRIX_STATE_DIR/outbox.log"
SUMMARY_FILE="$MATRIX_STATE_DIR/rolling-summary.md"
CONTEXT_FILE="$MATRIX_STATE_DIR/current-context.md"

RAW_POLL_OUTPUT="$($SCRIPT_DIR/poll.sh "$CONFIG_PATH")"

if [[ -z "${RAW_POLL_OUTPUT//[[:space:]]/}" ]]; then
  echo "no message"
  exit 0
fi

MESSAGE_JSON="$(printf '%s' "$RAW_POLL_OUTPUT" | python3 - <<'PY'
import json
import sys

raw = sys.stdin.read()
try:
    obj = json.loads(raw)
except json.JSONDecodeError as e:
    preview = raw.strip().replace("\n", "\\n")
    if len(preview) > 200:
        preview = preview[:200] + "..."
    raise SystemExit(
        f"invalid poll response JSON: {e.msg} at line {e.lineno}, column {e.colno}; body preview: {preview!r}"
    )

msg = obj.get("message")
if msg is None:
    print("")
    raise SystemExit(0)
if not isinstance(msg, dict):
    raise SystemExit("invalid poll response JSON: field 'message' must be an object or null")
print(json.dumps(msg))
PY
)"

if [[ -z "$MESSAGE_JSON" ]]; then
  echo "no message"
  exit 0
fi

TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
SENDER="$(printf '%s' "$MESSAGE_JSON" | python3 - <<'PY'
import json
import sys
msg = json.loads(sys.stdin.read())
print((msg.get("sender") or "unknown").strip())
PY
)"
BODY="$(printf '%s' "$MESSAGE_JSON" | python3 - <<'PY'
import json
import sys
msg = json.loads(sys.stdin.read())
print((msg.get("body") or "").rstrip())
PY
)"

{
  echo "[$TIMESTAMP] $SENDER"
  echo "$BODY"
  echo
} >> "$INBOX_LOG"

"$SCRIPT_DIR/summarize_state.sh" "$CONFIG_PATH" >/dev/null

{
  echo "# Incoming Message"
  echo
  echo "- Timestamp: $TIMESTAMP"
  echo "- Sender: $SENDER"
  echo
  echo "## Body"
  echo "$BODY"
  echo
  if [[ -f "$SUMMARY_FILE" ]]; then
    echo "---"
    echo
    cat "$SUMMARY_FILE"
  fi
} > "$CONTEXT_FILE"

if [[ ${#RUN_CMD[@]} -eq 0 ]]; then
  cat "$CONTEXT_FILE"
  exit 0
fi

REPLY="$(${RUN_CMD[@]} < "$CONTEXT_FILE")"
if [[ -z "${REPLY//[[:space:]]/}" ]]; then
  echo "agent command produced empty reply; nothing sent"
  exit 0
fi

{
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $MATRIX_AGENT"
  echo "$REPLY"
  echo
} >> "$OUTBOX_LOG"

"$SCRIPT_DIR/send.sh" "$CONFIG_PATH" "$REPLY"
