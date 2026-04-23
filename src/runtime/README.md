# Runtime Module Boundaries

`src/index.ts` is the runtime bootstrap/orchestration layer.

Responsibility split:

- `src/runtime/config.ts`: config schema/types, token/admin parsing, config persistence/loading, project lookup, room/project mapping.
- `src/runtime/redis.ts`: Redis connectivity, queue keying, queue envelope encode/decode.
- `src/runtime/matrix.ts`: Matrix HTTP client helpers, message rendering, room join/sync primitives, timeline-to-queue conversion.
- `src/runtime/http.ts`: operator HTTP facade (`/health`, `/v1/metrics`, `/v1/agent/*`) with auth and payload validation.
- `src/runtime/loops.ts`: inbound/outbound Matrix-Redis worker loops and event routing glue.
- `src/runtime/process.ts`: command process execution, OpenCode run command preparation, and stream-to-output parsing.
- `src/worker/auto-opencode.ts`: auto-opencode project worker and supervisor loop implementations.
- `src/worker/context-state.ts`: auto-opencode state directory/log I/O plus rolling-summary/current-context builders.
- `src/commands/management.ts`: management-room `!agent` command parsing/help/execution (`!op` kept as legacy alias).
- `src/commands/opencode-cli.ts`: project-room OpenCode CLI command parsing/help (`!agent`/`!op`) for usage/stats/models/model/start.

This keeps `src/index.ts` focused on command flow, top-level wiring, and process lifecycle while preserving external behavior.
