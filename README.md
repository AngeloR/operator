# operator

A Matrix-to-agent harness bridge that lets you interact with `opencode`, `codex`, or `claude` directly from Matrix chat rooms.

## Contributing

See `CONTRIBUTING.md` for human and AI contributor workflows, branch/PR expectations, and pre-PR checks.

## What It Is

`operator` is a relay service that:

- Connects to your Matrix homeserver and monitors configured rooms for messages
- Runs per-project harness commands to respond to messages automatically using AI
- Provides an HTTP API for external agents to send/receive messages via Redis queues
- Supports in-room CLI commands for checking usage, models, and managing model overrides

Architecture reference: [`ARCHITECTURE.md`](ARCHITECTURE.md)

Multi-harness rollout reference: [`docs/multi-harness-rollout.md`](docs/multi-harness-rollout.md)

## How It Works

```mermaid
flowchart LR
    A[Matrix Room] -->|messages| B[operator runtime]
    B -->|queue| C[Redis Queue]
    B -->|spawn| D[OpenCode]
    
    D -->|invoke| E[External Agents]
```

1. **Matrix Ingress**: Messages from configured rooms are queued to Redis (`[project]:user`)
2. **Matrix Egress**: Agent responses from Redis (`[project]:agent`) are sent to rooms
3. **Harness Workers**: Runs per-project harness execution (`opencode`, `codex`, `claude`)
4. **HTTP API**: External services can poll/send via `/v1/agent/poll` and `/v1/agent/send`

Before an inbound message is enqueued for agent processing, operator sends a Matrix read receipt (`m.read`) for that event so clients can show it as seen as early as possible.

Inbound attachments are supported for `m.file` and `m.image` events. The router currently allows only:
- text files with `.txt` or `.md` extensions
- image attachments

Allowed attachments are downloaded to local temp storage and included in the polled queue message as `message.attachments[]` with metadata such as `filename`, `kind`, `mimeType`, `sizeBytes`, `localPath`, and `downloadStatus`.

## Installation

### Prerequisites

- [Bun](https://bun.sh/) runtime
- Redis server
- Matrix homeserver account with access token
- Harness CLI(s) you plan to use (`opencode`, `codex`, and/or `claude`)

### Setup

1. Install dependencies:

```bash
bun install
```

2. Create your config file:

```bash
cp config.example.json config.json
```

3. Edit `config.json` with your settings:
   - `homeserverUrl`: Your Matrix server URL (e.g., `https://matrix.org`)
   - `accessToken`: Your Matrix access token (get from Element: Settings > Help & About > Advanced)
   - `adminUserIds`: List of Matrix user IDs allowed to trigger bot responses
   - `agentApiToken`: Secret token for HTTP API access
   - `redisUrl`: Redis connection URL

4. Configure projects (rooms the bot should monitor):

```json
{
  "projects": {
    "my-project": {
      "roomId": "!abc123:matrix.org",
      "harness": "opencode",
      "projectWorkingDirectory": "/path/to/your/codebase",
      "senderAllowlist": ["@you:matrix.org"]
    }
  }
}
```

5. Run the daemon:

```bash
bun run src/index.ts
```

### Harness Setup Notes

- `opencode` projects can omit `command`; default is `["opencode", "run"]`.
- `codex` and `claude` projects must set `command` explicitly to a non-interactive CLI invocation that reads prompt text from stdin and writes final output to stdout.
- On startup, operator validates that the configured command executable exists and returns a clear error if not.

## In-Room Commands

You can use these commands directly in Matrix rooms:

| Command                           | Description                                  |
| --------------------------------- | -------------------------------------------- |
| `!op start`                       | Run guided onboarding flow                   |
| `!op usage <model> [--days N]`    | Show usage stats for a specific model        |
| `!op stats [--days N] [--models]` | Show overall usage statistics                |
| `!op models [--verbose]`          | List available models                        |
| `!op model`                       | Show current model override for this project |
| `!op model <model-id>`            | Set a model override for this project        |
| `!op model reset`                 | Clear model override (use OpenCode default)  |
| `!op help`                        | Show command help                            |
| `!agent help`                     | Harness-aware help (`!op help` alias)        |
| `stop`                            | Stop the active auto-opencode job            |

Notes:
- OpenCode projects support in-room CLI commands (`usage`, `stats`, `models`, `model`, `start`).
- Codex/Claude projects currently run in final-output mode (prompt in, final response out) and do not expose in-room CLI shortcuts yet.

Example:

```
!op start
!op usage openai/gpt-5.3-codex --days 30
!op model openai/gpt-4-turbo
```

### Project Management Commands (Management Room Only)

Use these commands in your configured management room to add/remove/list projects.

| Command                                                   | Description                      |
| --------------------------------------------------------- | -------------------------------- |
| `!agent list`                                             | Show all configured projects     |
| `!agent create <name> --room <roomId> --path <dir>`      | Create a new project             |
| `!agent delete <name>`                                    | Delete a project                 |
| `!agent show <name>`                                      | Show one project configuration   |
| `!agent reload`                                           | Reload `config.json` from disk   |
| `!agent help`                                             | Show management command help     |

Examples:

```text
!agent list
!agent create operator --room !QefzZvtgPwIGrHuOuo:palantir --path /home/xangelo/repos/operator
!agent show operator
!agent reload
```

`!op` remains supported as a legacy alias in the management room.

When using `!agent create`, the sender who runs the command is automatically added to
that project's `senderAllowlist`.

## HTTP API

The relay exposes an HTTP API for external agents:

### Health Check

```bash
curl http://localhost:8888/v1/health
```

### Poll for Messages

```bash
curl -X POST http://localhost:8888/v1/agent/poll \
  -H "Authorization: Bearer $AGENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project":"my-project","agent":"bot","block_seconds":30}'
```

### Send a Message

```bash
curl -X POST http://localhost:8888/v1/agent/send \
  -H "Authorization: Bearer $AGENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project":"my-project","agent":"bot","markdown":"Hello!","format":"markdown"}'
```

### Metrics

```bash
curl http://localhost:8888/v1/metrics
```

## Configuration Reference

### Top-Level Options

| Key             | Required | Description                                     |
| --------------- | -------- | ----------------------------------------------- |
| `port`          | No       | HTTP server port (default: 8888)                |
| `homeserverUrl` | Yes      | Matrix homeserver URL                           |
| `accessToken`   | Yes      | Matrix bot access token                         |
| `adminUserIds`  | No       | User IDs allowed to enqueue messages            |
| `agentApiToken` | No\*     | Token for HTTP API (\*required if using API)    |
| `redisUrl`      | No       | Redis URL (default: `redis://localhost:6379/0`) |

### Project Options

| Key                      | Required | Description                                                     |
| ------------------------ | -------- | --------------------------------------------------------------- |
| `roomId`                 | Yes      | Matrix room ID                                                  |
| `harness`                | No       | Harness selector: `opencode`, `codex`, or `claude` (default: `opencode`) |
| `prefix`                 | No       | Legacy prefix for message routing                               |
| `agent`                  | No       | Agent label (default: `opencode`)                               |
| `command`                | No*      | CLI command to run (*required for `codex`/`claude`; optional for `opencode`) |
| `commandPrefix`          | No       | OpenCode in-room command prefix (default: `!op`, alias `!agent`) |
| `projectWorkingDirectory`| Yes      | Working directory for OpenCode                                  |
| `senderAllowlist`        | Yes      | Allowed senders (auto-seeded for `!op create` projects)        |
| `timeoutSeconds`         | No       | Timeout for OpenCode runs (default: 300, 0=disable)             |
| `verbosity`              | No       | Output mode: `output`, `debug`, `thinking`, `thinking-complete` |

### Verbosity Modes

- `output`: Acknowledgment + final output only (default)
- `debug`: Full status stream + output
- `thinking`: Reasoning section titles + output
- `thinking-complete`: Full reasoning stream, suppress duplicate final output

## CLI Debug Commands

```bash
# Push agent message to queue
bun run src/index.ts push-agent my-project "Hello from CLI"

# Push user message to queue
bun run src/index.ts push-user my-project "Run tests" --sender @admin:matrix.org

# Poll user messages
bun run src/index.ts poll-user my-project --block 30
```

## Architecture Notes

- **Sync State**: Matrix sync position stored at Redis key `operator:sync:next-batch:v1`
- **Message Format**: Outbound messages support Markdown, converted to Matrix HTML
- **Large Responses**:
  - <= ~12 KiB: sent as a normal Matrix text event
  - > ~12 KiB and <= ~40 KiB: split into threaded parts with `[Part x/y | event-id]` headers (8 KiB chunk target)
  - > ~40 KiB: uploaded as a text attachment (`m.file`) instead of being posted inline
- **Read Receipts**: Inbound accepted messages trigger an immediate `m.read` receipt before enqueue/dispatch
- **Attachment Allowlist**: Inbound attachments accept only `.txt`, `.md`, and image types
- **Security**: `command` runs with the process's permissions - treat as privileged config
- **Legacy**: `autoCodex*` and `autoOpenCode*` config keys are no longer supported

## Naming

The canonical public project name is `operator`. Older references to `matrix-relay-core` have been normalized to `operator` in docs and runtime output.

## Development

Run tests:

```bash
bun test
```

Type check:

```bash
bunx tsc --noEmit
```
