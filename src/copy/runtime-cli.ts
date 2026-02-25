export const RUNTIME_USAGE_TEXT = `matrix-relay-core

Commands:
  daemon (default)
    Runs Matrix<->Redis workers and HTTP agent facade.

  push-agent <project_key> [message] [--format markdown|plain] [--agent name]
    Queue a message onto [project]:agent.

  push-user <project_key> [message] [--format markdown|plain] [--sender user_id]
    Queue a message onto [project]:user.

  poll-user <project_key> [--block seconds]
    Pop the next message from [project]:user.

HTTP API (daemon):
  GET  /health
  GET  /v1/health
  GET  /v1/metrics
  POST /v1/agent/poll
  POST /v1/agent/send

Auth for /v1/agent/*:
  Authorization: Bearer <token>
  token source: config.agentApiToken(s) or AGENT_API_TOKEN(S)

Project-level config (all projects run the interactive agent):
  agent: "opencode"                                    # optional internal agent label (state/context)
  command: ["opencode","run"]                          # relay enforces JSON stream mode and requires opencode run
  commandPrefix: "!op"                                 # in-room command prefix for opencode CLI shortcuts
  allowedCliCommands: ["usage","stats","models","model","start","help"] # command allowlist
  commandTimeoutSeconds: 30                            # timeout for prefixed in-room opencode commands
  timeoutSeconds: 300                                  # timeout per message (0 disables timeout + forces 15m heartbeat)
  heartbeatSeconds: 45                                 # periodic heartbeat for debug mode (0 disables)
  verbosity: "output"                                  # output|thinking|thinking-complete|debug
  senderAllowlist: ["@admin:your-server"]              # required
  progressUpdates: true                                # default true
  stateDir: ".operator-state"                          # default
  projectWorkingDirectory: "/abs/path/to/project"      # default: current relay-core cwd
  model: "opencode/minimax-m2.5-free"                  # optional per-project model override
  ackTemplate: "Starting OpenCode {{job_id}}."         # used when verbosity=debug
  progressTemplate: "OpenCode {{phase}} ({{job_id}})." # used for debug status updates
  contextTailLines: 60                                 # default

Environment:
  REDIS_URL (default: redis://127.0.0.1:6379/0)
  REDIS_HOST, REDIS_PORT, REDIS_PASSWORD, REDIS_DB
  AGENT_API_TOKEN, AGENT_API_TOKENS
`;
