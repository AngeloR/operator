# Troubleshooting

## Poll returns auth errors

- Verify `agent_api_token` in runtime `config.json`.
- Verify relay-core has matching `agentApiToken` or `agentApiTokens`.
- Confirm header is accepted by relay endpoint `/v1/agent/poll`.

## No inbound messages appear

- Confirm relay-core worker is running and Matrix sync loop is healthy.
- Confirm `project.roomId` mapping matches the Matrix room.
- Confirm sender is listed in `adminUserIds` (or that filtering is intentionally open).
- Check Redis list length for `[project]:user`.

## Messages are sent but not posted in Matrix

- Confirm relay-core outbound loop is running.
- Check Redis list `[project]:agent` and daemon logs for send failures.
- Validate Matrix access token in relay-core config.

## Context seems to reset

- Ensure `state_dir` is stable and writable.
- Verify `run-turn.sh` is used consistently for that project+agent.
- Check `rolling-summary.md`, `inbox.log`, and `outbox.log` exist under `state_dir`.

## Relay unreachable from agent runtime

- Verify `relay_base_url` and network routing.
- Confirm relay health endpoint:

```bash
curl -sS http://<relay-host>:<port>/v1/health
```

- Check firewall / container network policy.
