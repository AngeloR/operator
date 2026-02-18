# matrix-agent

`matrix-agent` is now the **relay core**.

It bridges Matrix <-> Redis and exposes a small HTTP facade so lightweight agent runtimes only need a local `config.json`.

## Architecture

Two layers:

1. Relay core (this repo/process)
- Matrix ingress: room message -> Redis `[project]:user`
- Matrix egress: Redis `[project]:agent` -> room message
- HTTP facade for agent runtimes

2. Agent runtime (skill package)
- polls relay core over HTTP
- sends replies over HTTP
- keeps local context state files
- minimal setup on host

## Install

```bash
bun install
cp config.example.json config.json
```

## Relay Core Config (`config.json`)

```json
{
  "port": 8888,
  "homeserverUrl": "http://your-matrix-server:8008",
  "accessToken": "syt_...",
  "adminUserIds": ["@admin:your-server"],
  "agentApiToken": "replace-with-long-random-token",
  "redisUrl": "redis://127.0.0.1:6379/0",
  "projects": {
    "antares": {
      "roomId": "!yourRoomId:your-server"
    },
    "matrix-router": {
      "roomId": "!anotherRoomId:your-server",
      "autoCodex": true,
      "autoCodexAgent": "codex",
      "autoCodexCommand": ["codex", "exec", "--skip-git-repo-check"],
      "autoCodexTimeoutSeconds": 300,
      "autoCodexHeartbeatSeconds": 45,
      "autoCodexDebug": false,
      "autoCodexSenderAllowlist": ["@admin:your-server"],
      "autoCodexProgressUpdates": true,
      "autoCodexStateDir": ".matrix-agent-state",
      "autoCodexCwd": "/abs/path/to/project",
      "autoCodexAckTemplate": "Received. Starting Codex job {{job_id}}.",
      "autoCodexProgressTemplate": "Codex {{phase}} (job {{job_id}}).",
      "autoCodexContextTailLines": 60
    }
  }
}
```

Notes:
- `agentApiToken` or `agentApiTokens` is required to use `/v1/agent/*` routes.
- `adminUserIds` gates which Matrix senders are enqueued into `[project]:user`.
- Sync checkpoint is stored at Redis key `matrix-agent:sync:next-batch:v1`.
- `autoCodex` is optional per project. When enabled, relay-core consumes `[project]:user`, runs the configured command with a rolling context bundle on stdin, and sends replies to `[project]:agent`.
- Outbound Matrix messages are sent as provided (no automatic `[agent]` prefix in message text).
- `autoCodexSenderAllowlist` is required when `autoCodex` is enabled.
- `autoCodexCommand` executes on the host with this process's permissions; treat it as privileged configuration.
- `autoCodexAgent` is an optional internal agent label used for context/state partitioning.
- For `codex exec`, relay automatically enables `--json` and writes `--output-last-message` to a temporary state file unless you already pass those flags in `autoCodexCommand`.
- `autoCodexTimeoutSeconds` defaults to `300`; set `0` to disable timeout and force a 15-minute heartbeat while Codex is running.
- `autoCodexHeartbeatSeconds` defaults to `45`; for timed runs this heartbeat is used for non-Codex commands, while `codex exec` progress is stream-driven from JSON events. Set `0` to disable timed heartbeats.
- `autoCodexDebug` defaults to `false`. When enabled, relay sends verbose phase/stream status messages to Matrix using `autoCodexAckTemplate`/`autoCodexProgressTemplate`.
- When `autoCodexDebug` is `false`, relay suppresses those verbose status messages and sends a lightweight `Received.` + `Thinking...` flow before the final answer.
- `autoCodexCwd` sets the working directory used for `autoCodexCommand` and is validated at daemon startup. If omitted, relay-core uses its own current working directory.

## Run

Start full daemon (worker loops + HTTP facade):

```bash
bun run src/index.ts
```

or explicitly:

```bash
bun run src/index.ts daemon
```

## HTTP Facade

Health:

```bash
curl -sS http://localhost:8888/v1/health
```

Poll inbound message:

```bash
curl -sS -X POST http://localhost:8888/v1/agent/poll \
  -H "content-type: application/json" \
  -H "authorization: Bearer $AGENT_API_TOKEN" \
  -d '{"project":"matrix-router","agent":"agent-a","block_seconds":30}'
```

Queue outbound message:

```bash
curl -sS -X POST http://localhost:8888/v1/agent/send \
  -H "content-type: application/json" \
  -H "authorization: Bearer $AGENT_API_TOKEN" \
  -d '{"project":"matrix-router","agent":"agent-a","markdown":"hello from agent","format":"markdown"}'
```

## Redis Queue Model

Per project key:
- `[project]:user`: Matrix/admin -> agent
- `[project]:agent`: agent -> Matrix

## CLI Debug Commands

Push agent message:

```bash
bun run src/index.ts push-agent matrix-router "hello"
```

Push user message:

```bash
bun run src/index.ts push-user matrix-router "run diagnostics" --sender @admin:example
```

Poll user message:

```bash
bun run src/index.ts poll-user matrix-router --block 30
```

## Skill Runtime Package

A minimal agent-runtime skill is provided at:

- `skills/matrix-agent-runtime/SKILL.md`

Main scripts:
- `skills/matrix-agent-runtime/scripts/poll.sh`
- `skills/matrix-agent-runtime/scripts/send.sh`
- `skills/matrix-agent-runtime/scripts/run-turn.sh`
- `skills/matrix-agent-runtime/scripts/run-codex-loop.sh`
- `skills/matrix-agent-runtime/scripts/summarize_state.sh`

For local runtime usage, start from:

```bash
cp agent-runtime.example.json agent-runtime.json
```
