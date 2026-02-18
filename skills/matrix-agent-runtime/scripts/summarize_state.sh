#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

CONFIG_PATH="${1:-config.json}"
load_runtime_config "$CONFIG_PATH"

mkdir -p "$MATRIX_STATE_DIR"

INBOX_LOG="$MATRIX_STATE_DIR/inbox.log"
OUTBOX_LOG="$MATRIX_STATE_DIR/outbox.log"
SUMMARY_FILE="$MATRIX_STATE_DIR/rolling-summary.md"

touch "$INBOX_LOG" "$OUTBOX_LOG"

TMP_INBOX="$MATRIX_STATE_DIR/.inbox.trim.tmp"
TMP_OUTBOX="$MATRIX_STATE_DIR/.outbox.trim.tmp"

tail -n "$MATRIX_CONTEXT_TAIL_LINES" "$INBOX_LOG" > "$TMP_INBOX" || true
tail -n "$MATRIX_CONTEXT_TAIL_LINES" "$OUTBOX_LOG" > "$TMP_OUTBOX" || true
mv "$TMP_INBOX" "$INBOX_LOG"
mv "$TMP_OUTBOX" "$OUTBOX_LOG"

INBOX_COUNT="$(wc -l < "$INBOX_LOG" | tr -d ' ')"
OUTBOX_COUNT="$(wc -l < "$OUTBOX_LOG" | tr -d ' ')"

{
  echo "# Rolling Summary"
  echo
  echo "- Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "- Project: $MATRIX_PROJECT"
  echo "- Agent: $MATRIX_AGENT"
  echo "- Inbound entries retained: $INBOX_COUNT"
  echo "- Outbound entries retained: $OUTBOX_COUNT"
  echo
  echo "## Recent Inbound"
  tail -n 10 "$INBOX_LOG" || true
  echo
  echo "## Recent Outbound"
  tail -n 10 "$OUTBOX_LOG" || true
} > "$SUMMARY_FILE"

echo "$SUMMARY_FILE"
