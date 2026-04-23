# Multi-Harness Rollout Plan

This document captures the phased plan to extend `operator` from OpenCode-only execution to multiple harnesses (`opencode`, `codex`, `claude`) while keeping current behavior stable.

## Goals

- Keep existing OpenCode users fully backward-compatible.
- Add harness selection per project.
- Provide a shared adapter interface so each harness plugs in cleanly.
- Ship Codex and Claude support incrementally, starting with final-output mode.

## Non-Goals (Initial Rollout)

- Perfect parity for streaming semantics across all harnesses on day one.
- Harness-specific advanced commands unless equivalent capabilities are available.

## Phase 1: Project Schema and Config Foundation

### Objective

Introduce harness identity in project config without behavior changes.

### Scope

- Add `harness` to project config with allowed values: `opencode | codex | claude`.
- Default missing `harness` to `opencode`.
- Keep existing `agent`, `command`, and `commandPrefix` behavior unchanged.
- Update config validation and project display output.

### Deliverables

- Config/type updates.
- Parsing + validation tests for defaults and invalid harness values.
- Documentation updates for project config.

### Exit Criteria

- Existing configs run unchanged.
- New configs can set `harness` explicitly.

## Phase 2: Harness Adapter Abstraction

### Objective

Decouple worker/runtime flow from OpenCode-specific assumptions.

### Scope

- Add `HarnessAdapter` abstraction with responsibilities such as:
  - config validation for harness-specific requirements
  - execution contract (`run`)
  - optional stream/event parsing
  - optional in-room command handling
- Wire worker startup to resolve adapter by `project.harness`.

### Deliverables

- Adapter interface + resolver/registry.
- Tests for adapter selection and unsupported harness handling.

### Exit Criteria

- Worker path uses adapter abstraction.
- No functional regression for OpenCode projects.

## Phase 3: OpenCode Extraction (Parity Refactor)

### Objective

Move current OpenCode logic behind `OpenCodeAdapter` with behavior parity.

### Scope

- Migrate OpenCode execution and stream parsing into adapter implementation.
- Keep `!op` command behavior and existing output modes unchanged.
- Keep current process and queue contracts stable.

### Deliverables

- `OpenCodeAdapter` implementation.
- Refactored worker/runtime integration tests.

### Exit Criteria

- OpenCode behavior matches pre-refactor outcomes.
- Typecheck/tests pass with no new OpenCode regressions.

## Phase 4: Codex and Claude Minimal Adapters

### Objective

Add initial Codex/Claude support with reliable final-output delivery.

### Scope

- Implement `CodexAdapter` and `ClaudeAdapter` in final-output-first mode.
- Gracefully degrade when structured streaming is unavailable.
- Validate harness command availability and clear error messaging.

### Deliverables

- Adapter implementations for Codex and Claude.
- Integration tests for successful runs + known failure paths.
- Documentation for setup requirements per harness.

### Exit Criteria

- A project configured with `harness: codex` or `harness: claude` can process prompts end-to-end.
- Failures are surfaced cleanly to Matrix.

## Phase 5: Command UX and Docs Unification

### Objective

Make the in-room and management UX harness-aware while preserving compatibility.

### Scope

- Keep `!op` as backward-compatible alias.
- Add neutral command surface (for example `!agent`) for harness-agnostic operations.
- Show harness-specific capabilities/limitations in help text.
- Update README and architecture docs for multi-harness operation.

### Deliverables

- Updated command routing/help output.
- Updated operator and project documentation.

### Exit Criteria

- Users can discover and operate all supported harnesses from docs/help.
- Legacy OpenCode command paths still work.

## Risks and Mitigations

- Stream format mismatches between CLIs.
  - Mitigation: final-output-first adapters, stream support added per harness later.
- Config drift across projects.
  - Mitigation: strict schema + defaults + clear validation errors.
- Command inconsistency across harnesses.
  - Mitigation: keep harness-agnostic core commands and clearly label harness-only commands.

## Suggested Branch and PR Sequence

1. `feat/harness-schema-foundation` -> PR: Phase 1
2. `refactor/harness-adapter-scaffold` -> PR: Phase 2
3. `refactor/opencode-adapter-parity` -> PR: Phase 3
4. `feat/codex-claude-minimal-adapters` -> PR: Phase 4
5. `feat/harness-aware-command-ux` -> PR: Phase 5
