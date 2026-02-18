---
name: matrix-agent-runtime
description: Use a config-only runtime wrapper for Matrix-coordinated agents. Polls relay-core for user messages, maintains local context state, and sends agent replies back through relay-core.
---

# Matrix Agent Runtime

Use this skill when an agent should participate in Matrix coordination with minimal setup on its host.

## Requirements

- A local `config.json` runtime file (schema below).
- `curl` and `python3` available on host.
- Reachable relay-core HTTP facade (`/v1/agent/poll`, `/v1/agent/send`).

## Runtime Config

`config.json` keys expected by scripts:

- `project`
- `agent`
- `relay_base_url`
- `agent_api_token`
- `poll_block_seconds` (optional, default `30`)
- `context_tail_lines` (optional, default `50`)
- `state_dir` (optional, default `.matrix-agent-state`)

## Main Workflow

1. Poll once for inbound message:

```bash
skills/matrix-agent-runtime/scripts/poll.sh config.json
```

2. Run one turn wrapper:

```bash
skills/matrix-agent-runtime/scripts/run-turn.sh config.json -- your-agent-command
```

`run-turn.sh` will:
- pull one inbound message from relay-core
- store inbound/outbound state under `state_dir`
- generate a context bundle
- pipe the context bundle into `your-agent-command`
- send command output back to relay-core

For continuous auto-reply with Codex:

```bash
skills/matrix-agent-runtime/scripts/run-codex-loop.sh config.json
```

3. Send a direct message:

```bash
skills/matrix-agent-runtime/scripts/send.sh config.json "message body"
```

## Notes

- Delivery semantics are at-most-once at poll time.
- State files persist context across turns for the same `project + agent`.
- For diagnostics and operating details, see `references/troubleshooting.md`.
