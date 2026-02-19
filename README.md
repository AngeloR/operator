# matrix-agent

`matrix-agent` is now the **relay core**.

It bridges Matrix <-> Redis and exposes a small HTTP facade, with optional built-in autoOpenCode workers per project.

## Architecture

Single relay-core process:

1. Matrix ingress: room message -> Redis `[project]:user`
2. Matrix egress: Redis `[project]:agent` -> room message
3. Optional autoOpenCode workers consume `[project]:user` and publish to `[project]:agent`
4. HTTP facade (`/v1/agent/poll`, `/v1/agent/send`) for external agent processes

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
      "autoOpenCode": true,
      "autoOpenCodeAgent": "opencode",
      "autoOpenCodeCommand": ["opencode", "run"],
      "autoOpenCodeTimeoutSeconds": 300,
      "autoOpenCodeHeartbeatSeconds": 45,
      "autoOpenCodeVerbosity": "output",
      "autoOpenCodeSenderAllowlist": ["@admin:your-server"],
      "autoOpenCodeProgressUpdates": true,
      "autoOpenCodeStateDir": ".matrix-agent-state",
      "autoOpenCodeCwd": "/abs/path/to/project",
      "autoOpenCodeAckTemplate": "Received. Starting OpenCode job {{job_id}}.",
      "autoOpenCodeProgressTemplate": "OpenCode {{phase}} (job {{job_id}}).",
      "autoOpenCodeContextTailLines": 60
    }
  }
}
```

Notes:
- `agentApiToken` or `agentApiTokens` is required to use `/v1/agent/*` routes.
- `/v1/metrics` is public (same access model as `/v1/health`).
- `adminUserIds` gates which Matrix senders are enqueued into `[project]:user`.
- Sync checkpoint is stored at Redis key `matrix-agent:sync:next-batch:v1`.
- `autoOpenCode` is optional per project. When enabled, relay-core consumes `[project]:user`, runs the configured command with a rolling context bundle on stdin, and sends replies to `[project]:agent`.
- Legacy `autoCodex*` keys are no longer supported; startup fails fast if they are still present.
- Outbound Matrix messages are sent as provided (no automatic `[agent]` prefix in message text).
- Relay converts markdown payloads to Matrix HTML (`org.matrix.custom.html`) for outbound messages.
- `autoOpenCodeSenderAllowlist` is required when `autoOpenCode` is enabled.
- `autoOpenCodeCommand` executes on the host with this process's permissions; treat it as privileged configuration.
- `autoOpenCodeAgent` is an optional internal agent label used for context/state partitioning.
- `autoOpenCodeCommand` must invoke `opencode run`; relay automatically enforces `--format json` and adds `--thinking` for `thinking` / `thinking-complete` verbosity modes.
- `autoOpenCodeTimeoutSeconds` defaults to `300`; set `0` to disable timeout and force a 15-minute heartbeat while OpenCode is running.
- `autoOpenCodeHeartbeatSeconds` defaults to `45`; heartbeat updates are sent in debug mode for long-running jobs. Set `0` to disable timed heartbeats.
- `autoOpenCodeVerbosity` defaults to `"output"` and controls status visibility:
- `"debug"`: emit full status stream (ack + planning/executing/stream/heartbeat/finalizing) plus final output.
- `"thinking"`: emit title-only thinking updates (one line per reasoning section title) plus final output.
- `"thinking-complete"`: emit full thinking stream text and suppress duplicate final output when a stream already produced content.
- `"output"`: emit only `Received.` acknowledgement plus final output.
- `autoOpenCodeCwd` sets the working directory used for `autoOpenCodeCommand` and is validated at daemon startup. If omitted, relay-core uses its own current working directory.

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

Metrics:

```bash
curl -sS http://localhost:8888/v1/metrics
```

Response shape:

```json
{
  "ok": true,
  "generatedAt": "2026-02-18T00:00:00.000Z",
  "queueDepth": {
    "total": 0,
    "byQueue": { "matrix-router:user": 0, "matrix-router:agent": 0 },
    "byProject": { "matrix-router": { "user": 0, "agent": 0, "total": 0 } }
  },
  "workerRestarts": { "total": 0, "byProject": {} },
  "failures": { "total": 0, "byCategory": {}, "byProject": {} },
  "processingLatency": {
    "overall": {
      "count": 0,
      "sumMs": 0,
      "minMs": null,
      "maxMs": null,
      "avgMs": null,
      "p50Ms": null,
      "p95Ms": null,
      "sampleCount": 0
    },
    "byOperation": {}
  }
}
```

## Observability

- Daemon logs are structured JSON.
- Every log event includes these base fields: `timestamp`, `level`, `event`, `projectKey`, `jobId`, `queue`, `sender`, `durationMs`.

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
