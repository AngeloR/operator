import config from "../config.json";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type MessageFormat,
  nonEmptyText,
  parseFormat,
  parseOptionalString,
  truncateText,
} from "./text";
import { parseSenderAllowlist } from "./sender-allowlist";
import {
  logEvent,
  recordFailure,
  recordProcessingLatency,
} from "./metrics";
import {
  buildRoomToProjectMap,
  loadConfig,
  parseAdminUserIds,
  parseAgentApiTokens,
  resolveProject,
  type AppConfig,
  type ProjectConfig,
} from "./runtime/config";
import {
  executeManagementCommand,
  parseManagementCommandArgs,
  type ParsedManagementCommand,
} from "./commands/management";
import {
  executeAutoOpenCodeCliCommand,
  generalHelp,
  parseAutoOpenCodeCliRequest,
  splitCommandTokens,
} from "./commands/opencode-cli";
import {
  createEnvelope,
  createRedisClient,
  parseEnvelope,
  queueKey,
  resolveRedisConfig,
  type QueueDirection,
  type QueueEnvelope,
  type Redis,
  type RedisConfig,
} from "./runtime/redis";
import {
  buildMatrixContent,
  fetchBotUserId,
  type MatrixClientConfig,
} from "./runtime/matrix";
import { startHttpFacade } from "./runtime/http";
import { runInboundLoop, runOutboundLoop } from "./runtime/loops";
import {
  runAutoOpenCodeProjectSupervisor,
  runAutoOpenCodeProjectWorker,
  type ActiveAutoOpenCodeRun,
  type AutoOpenCodeCliCommand,
  type AutoOpenCodeProject,
  type AutoOpenCodeVerbosity,
} from "./worker/auto-opencode";
import {
  AutoOpenCodeStoppedError,
  isOpenCodeRunCommand,
  runAutoOpenCodePrompt,
  runCommandWithInput,
} from "./runtime/process";
import { appendTurnLog, prepareAutoOpenCodeContext } from "./worker/context-state";

type ParsedCli = {
  positionals: string[];
  options: Map<string, string | true>;
};

const cfg = config as AppConfig;
let projects = cfg.projects ?? {};
const CONFIG_JSON_PATH = fileURLToPath(new URL("../config.json", import.meta.url));
const SYNC_TOKEN_KEY = "operator:sync:next-batch:v1";
const LEGACY_SYNC_TOKEN_KEY = "matrix-agent:sync:next-batch:v1";
const DEFAULT_AUTO_OPENCODE_COMMAND = ["opencode", "run"];
const DEFAULT_AUTO_OPENCODE_COMMAND_PREFIX = "!op";
const MANAGEMENT_COMMAND_PREFIX = "!op";
const DEFAULT_AUTO_OPENCODE_ALLOWED_CLI_COMMANDS = ["usage", "stats", "models", "model", "start", "help"];
const DEFAULT_AUTO_OPENCODE_COMMAND_TIMEOUT_SECONDS = 30;
const DEFAULT_AUTO_OPENCODE_TIMEOUT_SECONDS = 300;
const DEFAULT_AUTO_OPENCODE_HEARTBEAT_SECONDS = 45;
const AUTO_OPENCODE_INFINITE_TIMEOUT_HEARTBEAT_MS = 15 * 60 * 1000;
const DEFAULT_AUTO_OPENCODE_VERBOSITY: AutoOpenCodeVerbosity = "output";
const DEFAULT_AUTO_OPENCODE_PROGRESS_UPDATES = true;
const DEFAULT_AUTO_OPENCODE_STATE_DIR = ".operator-state";
const LEGACY_AUTO_OPENCODE_STATE_DIR = ".matrix-agent-state";
const DEFAULT_AUTO_OPENCODE_ACK_TEMPLATE =
  "Received your message. Starting OpenCode job {{job_id}}.";
const DEFAULT_AUTO_OPENCODE_PROGRESS_TEMPLATE = "OpenCode {{phase}} (job {{job_id}}).";
const DEFAULT_AUTO_OPENCODE_CONTEXT_TAIL_LINES = 60;
const AUTO_OPENCODE_STOP_ALIASES = new Set<string>([
  "stop",
  "!stop",
  `${DEFAULT_AUTO_OPENCODE_COMMAND_PREFIX} stop`,
]);
const AUTO_OPENCODE_MAX_MESSAGE_CHARS = 16_000;
const AUTO_OPENCODE_MAX_CONTEXT_CHARS = 24_000;
const AUTO_OPENCODE_DEDUP_WINDOW_MS = 30 * 60 * 1000;
const AUTO_OPENCODE_DEDUP_MAX_IDS = 2000;
const AUTO_OPENCODE_STREAM_UPDATE_MIN_INTERVAL_MS = 5000;
const AUTO_OPENCODE_STREAM_UPDATE_MIN_CHARS = 200;
const AUTO_OPENCODE_STREAM_PREVIEW_MAX_CHARS = 4000;
const AUTO_OPENCODE_WORKER_RESTART_BASE_DELAY_MS = 1000;
const AUTO_OPENCODE_WORKER_RESTART_MAX_DELAY_MS = 30_000;
const activeAutoOpenCodeRuns = new Map<string, ActiveAutoOpenCodeRun>();

function matrixClientConfig(): MatrixClientConfig {
  return {
    homeserverUrl: cfg.homeserverUrl,
    accessToken: cfg.accessToken,
  };
}

if (!cfg.homeserverUrl || !cfg.accessToken) {
  throw new Error("config.json must include homeserverUrl and accessToken");
}

function isStopMessage(body: string): boolean {
  const normalized = body.trim().toLowerCase();
  return AUTO_OPENCODE_STOP_ALIASES.has(normalized);
}

function requestStopForProject(projectKey: string, sender: string): {
  stopped: boolean;
  jobId: string | null;
} {
  const active = activeAutoOpenCodeRuns.get(projectKey);
  if (!active) {
    return { stopped: false, jobId: null };
  }

  active.stopRequestedBy = sender;
  active.abortController.abort();
  return { stopped: true, jobId: active.jobId };
}

function parseBoolean(
  value: unknown,
  fallback: boolean,
  fieldName: string,
): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean`);
  }

  return value;
}

function parseVerbosity(
  value: unknown,
  fallback: AutoOpenCodeVerbosity,
): AutoOpenCodeVerbosity {
  if (value === undefined) {
    return fallback;
  }

  const parsed = nonEmptyText(value)?.toLowerCase();
  if (!parsed) {
    throw new Error("verbosity must be a non-empty string");
  }

  if (
    parsed !== "debug" &&
    parsed !== "thinking" &&
    parsed !== "thinking-complete" &&
    parsed !== "output"
  ) {
    throw new Error(
      "verbosity must be one of: debug, thinking, thinking-complete, output",
    );
  }

  return parsed;
}

function parseString(
  value: unknown,
  fallback: string,
  fieldName: string,
): string {
  if (value === undefined) {
    return fallback;
  }

  const parsed = nonEmptyText(value);
  if (!parsed) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return parsed;
}

function parseCommand(value: unknown): string[] | null {
  if (value === undefined) {
    return null;
  }

  if (!Array.isArray(value)) {
    throw new Error("command must be an array of strings");
  }

  const command = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);

  if (command.length === 0) {
    throw new Error("command must include at least one token");
  }

  return command;
}

function parseCommandPrefix(value: unknown): string {
  if (value === undefined) {
    return DEFAULT_AUTO_OPENCODE_COMMAND_PREFIX;
  }

  const parsed = nonEmptyText(value);
  if (!parsed) {
    throw new Error("commandPrefix must be a non-empty string");
  }

  return parsed;
}

function parseModel(value: unknown): string | undefined {
  const parsed = nonEmptyText(value);
  return parsed ?? undefined;
}

function parseAllowedCliCommands(
  value: unknown,
): Set<AutoOpenCodeCliCommand> {
  if (value === undefined) {
    return new Set(
      DEFAULT_AUTO_OPENCODE_ALLOWED_CLI_COMMANDS as AutoOpenCodeCliCommand[],
    );
  }

  if (!Array.isArray(value)) {
    throw new Error("allowedCliCommands must be an array of strings");
  }

  const commands = value
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter((item) => item.length > 0);

  if (commands.length === 0) {
    throw new Error("allowedCliCommands must include at least one command");
  }

  for (const command of commands) {
    if (
      command !== "usage" &&
      command !== "stats" &&
      command !== "models" &&
      command !== "model" &&
      command !== "start" &&
      command !== "help"
    ) {
      throw new Error(
        "allowedCliCommands entries must be one of: usage, stats, models, model, start, help",
      );
    }
  }

  return new Set(commands as AutoOpenCodeCliCommand[]);
}

function parseCommandTimeoutSeconds(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_AUTO_OPENCODE_COMMAND_TIMEOUT_SECONDS;
  }

  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 300) {
    throw new Error("commandTimeoutSeconds must be an integer between 1 and 300");
  }

  return n;
}

function parseProjectWorkingDirectory(value: unknown): string {
  if (value === undefined) {
    return process.cwd();
  }

  const parsed = nonEmptyText(value);
  if (!parsed) {
    throw new Error("projectWorkingDirectory must be a non-empty string");
  }

  return resolve(parsed);
}

function parseTimeoutSeconds(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_AUTO_OPENCODE_TIMEOUT_SECONDS;
  }

  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 3600) {
    throw new Error(
      "timeoutSeconds must be an integer between 0 and 3600 (0 disables timeout)",
    );
  }

  return n;
}

function parseHeartbeatSeconds(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_AUTO_OPENCODE_HEARTBEAT_SECONDS;
  }

  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 3600) {
    throw new Error("heartbeatSeconds must be an integer between 0 and 3600");
  }

  return n;
}

function parseContextTailLines(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_AUTO_OPENCODE_CONTEXT_TAIL_LINES;
  }

  const n = Number(value);
  if (!Number.isInteger(n) || n < 10 || n > 500) {
    throw new Error("contextTailLines must be an integer between 10 and 500");
  }

  return n;
}

function assertNoLegacyConfig(projectKey: string, project: ProjectConfig): void {
  const legacyAutoCodexKeys = [
    "autoCodex",
    "autoCodexAgent",
    "autoCodexCommand",
    "autoCodexTimeoutSeconds",
    "autoCodexHeartbeatSeconds",
    "autoCodexVerbosity",
    "autoCodexDebug",
    "autoCodexProgressUpdates",
    "autoCodexStateDir",
    "autoCodexCwd",
    "autoCodexSenderAllowlist",
    "autoCodexAckTemplate",
    "autoCodexProgressTemplate",
    "autoCodexContextTailLines",
  ];

  const legacyAutoOpenCodeKeys = [
    "autoOpenCode",
    "autoOpenCodeAgent",
    "autoOpenCodeCommand",
    "autoOpenCodeCommandPrefix",
    "autoOpenCodeAllowedCliCommands",
    "autoOpenCodeCommandTimeoutSeconds",
    "autoOpenCodeTimeoutSeconds",
    "autoOpenCodeHeartbeatSeconds",
    "autoOpenCodeVerbosity",
    "autoOpenCodeProgressUpdates",
    "autoOpenCodeStateDir",
    "autoOpenCodeCwd",
    "autoOpenCodeSenderAllowlist",
    "autoOpenCodeAckTemplate",
    "autoOpenCodeProgressTemplate",
    "autoOpenCodeContextTailLines",
  ];

  const legacyModelOverrides = "autoOpenCodeProjectModelOverrides";

  const rawProject = project as Record<string, unknown>;
  const presentAutoCodex = legacyAutoCodexKeys.filter((key) => rawProject[key] !== undefined);
  const presentAutoOpenCode = legacyAutoOpenCodeKeys.filter((key) => rawProject[key] !== undefined);

  if (presentAutoCodex.length > 0) {
    throw new Error(
      `project "${projectKey}" uses removed config keys: ${presentAutoCodex.join(", ")}. See README.md for current config format.`,
    );
  }

  if (presentAutoOpenCode.length > 0) {
    throw new Error(
      `project "${projectKey}" uses removed config keys: ${presentAutoOpenCode.join(", ")}. Rename to simpler names (e.g., autoOpenCodeCwd -> projectWorkingDirectory). See README.md for details.`,
    );
  }

  const rawConfig = cfg as Record<string, unknown>;
  if (rawConfig[legacyModelOverrides] !== undefined) {
    throw new Error(
      `config uses removed key "autoOpenCodeProjectModelOverrides". Use per-project "model" field instead.`,
    );
  }
}

function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) =>
    vars[key] ?? "",
  );
}

function buildAutoOpenCodeMap(): Map<string, AutoOpenCodeProject> {
  const map = new Map<string, AutoOpenCodeProject>();

  for (const [projectKey, project] of Object.entries(projects)) {
    assertNoLegacyConfig(projectKey, project);

    const roomId = nonEmptyText(project.roomId);
    if (!roomId) {
      throw new Error(`project "${projectKey}" has no roomId`);
    }

    const command = parseCommand(project.command) ??
      DEFAULT_AUTO_OPENCODE_COMMAND;
    const commandPrefix = parseCommandPrefix(project.commandPrefix);
    const allowedCliCommands = parseAllowedCliCommands(
      project.allowedCliCommands,
    );
    const commandTimeoutSeconds = parseCommandTimeoutSeconds(
      project.commandTimeoutSeconds,
    );
    if (!isOpenCodeRunCommand(command)) {
      throw new Error(
        `project "${projectKey}" has invalid command: expected opencode run`,
      );
    }
    const timeoutSeconds = parseTimeoutSeconds(
      project.timeoutSeconds,
    );
    const heartbeatSeconds = parseHeartbeatSeconds(
      project.heartbeatSeconds,
    );
    const verbosity = parseVerbosity(
      project.verbosity,
      DEFAULT_AUTO_OPENCODE_VERBOSITY,
    );
    const progressUpdates = parseBoolean(
      project.progressUpdates,
      DEFAULT_AUTO_OPENCODE_PROGRESS_UPDATES,
      "progressUpdates",
    );
    const parsedStateDir = parseString(
      project.stateDir,
      DEFAULT_AUTO_OPENCODE_STATE_DIR,
      "stateDir",
    );
    const stateDir =
      parsedStateDir === LEGACY_AUTO_OPENCODE_STATE_DIR
        ? DEFAULT_AUTO_OPENCODE_STATE_DIR
        : parsedStateDir;
    const cwd = parseProjectWorkingDirectory(project.projectWorkingDirectory);
    const senderAllowlist = parseSenderAllowlist(
      project.senderAllowlist,
    );
    const ackTemplate = parseString(
      project.ackTemplate,
      DEFAULT_AUTO_OPENCODE_ACK_TEMPLATE,
      "ackTemplate",
    );
    const progressTemplate = parseString(
      project.progressTemplate,
      DEFAULT_AUTO_OPENCODE_PROGRESS_TEMPLATE,
      "progressTemplate",
    );
    const contextTailLines = parseContextTailLines(
      project.contextTailLines,
    );
    const model = parseModel(project.model);

    const queue = queueKey(projectKey, "user");
    const autoProject: AutoOpenCodeProject = {
      projectKey,
      roomId,
      agent:
        nonEmptyText(project.agent) ??
        nonEmptyText(project.prefix) ??
        "opencode",
      model,
      command,
      commandPrefix,
      allowedCliCommands,
      commandTimeoutMs: commandTimeoutSeconds * 1000,
      timeoutMs: timeoutSeconds === 0 ? null : timeoutSeconds * 1000,
      heartbeatMs: heartbeatSeconds * 1000,
      verbosity,
      progressUpdates,
      stateDir,
      cwd,
      senderAllowlist,
      ackTemplate,
      progressTemplate,
      contextTailLines,
    };

    map.set(queue, autoProject);
  }

  return map;
}

async function validateAutoOpenCodeProjects(
  projectsByQueue: Map<string, AutoOpenCodeProject>,
): Promise<void> {
  for (const autoProject of projectsByQueue.values()) {
    let entry;
    try {
      entry = await stat(autoProject.cwd);
    } catch {
      throw new Error(
        `project "${autoProject.projectKey}" has invalid projectWorkingDirectory: directory not found (${autoProject.cwd})`,
      );
    }

    if (!entry.isDirectory()) {
      throw new Error(
        `project "${autoProject.projectKey}" has invalid projectWorkingDirectory: not a directory (${autoProject.cwd})`,
      );
    }
  }
}

function parseCliArgs(rawArgs: string[]): ParsedCli {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === undefined) {
      continue;
    }

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const maybeEq = arg.indexOf("=");
    if (maybeEq > 2) {
      options.set(arg.slice(2, maybeEq), arg.slice(maybeEq + 1));
      continue;
    }

    const key = arg.slice(2);
    const next = rawArgs[i + 1];

    if (typeof next === "string" && !next.startsWith("--")) {
      options.set(key, next);
      i += 1;
      continue;
    }

    options.set(key, true);
  }

  return { positionals, options };
}

function getOption(cli: ParsedCli, key: string): string | undefined {
  const value = cli.options.get(key);
  return typeof value === "string" ? value : undefined;
}

function readIntegerOption(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`invalid integer value: ${value}`);
  }
  return n;
}

async function readBodyFromArgsOrStdin(args: string[]): Promise<string | null> {
  const positional = nonEmptyText(args.join(" "));
  if (positional) return positional;

  if (process.stdin.isTTY) return null;

  const raw = await new Response(Bun.stdin.stream()).text();
  return nonEmptyText(raw);
}

async function enqueueAutoOpenCodeMessage(
  redis: Redis,
  autoProject: AutoOpenCodeProject,
  body: string,
  format: MessageFormat,
): Promise<QueueEnvelope> {
  const envelope = createEnvelope(
    autoProject.projectKey,
    autoProject.roomId,
    body,
    format,
    { agent: autoProject.agent },
  );

  const key = queueKey(autoProject.projectKey, "agent");
  await redis.rpush(key, JSON.stringify(envelope));
  return envelope;
}

async function enqueueAutoOpenCodeStatus(
  redis: Redis,
  autoProject: AutoOpenCodeProject,
  template: string,
  phase: string,
  jobId: string,
  sender: string,
): Promise<QueueEnvelope> {
  const body = renderTemplate(template, {
    phase,
    job_id: jobId,
    project: autoProject.projectKey,
    sender,
  });

  return enqueueAutoOpenCodeMessage(redis, autoProject, body, "markdown");
}

function cleanupDedupMap(
  projectDedup: Map<string, number>,
  now: number,
): void {
  for (const [eventId, ts] of projectDedup.entries()) {
    if (now - ts > AUTO_OPENCODE_DEDUP_WINDOW_MS) {
      projectDedup.delete(eventId);
    }
  }

  if (projectDedup.size <= AUTO_OPENCODE_DEDUP_MAX_IDS) {
    return;
  }

  const entries = [...projectDedup.entries()].sort((a, b) => a[1] - b[1]);
  const overflow = projectDedup.size - AUTO_OPENCODE_DEDUP_MAX_IDS;
  for (let i = 0; i < overflow; i += 1) {
    const eventId = entries[i]?.[0];
    if (eventId) {
      projectDedup.delete(eventId);
    }
  }
}

function markAndCheckDuplicate(
  projectDedup: Map<string, number>,
  eventId: string,
): boolean {
  const now = Date.now();
  cleanupDedupMap(projectDedup, now);

  if (projectDedup.has(eventId)) {
    return true;
  }

  projectDedup.set(eventId, now);
  return false;
}

function printUsage() {
  console.log(`operator

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
  projectWorkingDirectory: "/abs/path/to/project"      # default: current operator cwd
  model: "opencode/minimax-m2.5-free"                  # optional per-project model override
  ackTemplate: "Starting OpenCode {{job_id}}."         # used when verbosity=debug
  progressTemplate: "OpenCode {{phase}} ({{job_id}})." # used for debug status updates
  contextTailLines: 60                                 # default

Environment:
  REDIS_URL (default: redis://127.0.0.1:6379/0)
  REDIS_HOST, REDIS_PORT, REDIS_PASSWORD, REDIS_DB
  AGENT_API_TOKEN, AGENT_API_TOKENS
`);
}

async function commandPush(
  redis: Redis,
  direction: QueueDirection,
  cli: ParsedCli,
): Promise<void> {
  const projectKey = cli.positionals[0];
  if (!projectKey) {
    throw new Error(`missing project key for push-${direction}`);
  }

  const project = resolveProject(projects, projectKey);
  const body = await readBodyFromArgsOrStdin(cli.positionals.slice(1));

  if (!body) {
    throw new Error("missing message body (arg or stdin)");
  }

  const format = parseFormat(getOption(cli, "format"));
  const agent = parseOptionalString(getOption(cli, "agent"));
  const sender = parseOptionalString(getOption(cli, "sender"));

  const envelope = createEnvelope(projectKey, project.roomId, body, format, {
    agent,
    sender,
  });

  const key = queueKey(projectKey, direction);
  const queueLength = await redis.rpush(key, JSON.stringify(envelope));

  logEvent("info", "cli.push.completed", {
    projectKey,
    queue: key,
    sender: envelope.sender ?? null,
    direction,
    roomId: project.roomId,
    queueLength,
    eventId: envelope.id,
    receivedAt: envelope.receivedAt,
  });
}

async function commandPollUser(redis: Redis, cli: ParsedCli): Promise<void> {
  const projectKey = cli.positionals[0];
  if (!projectKey) {
    throw new Error("missing project key for poll-user");
  }

  const project = resolveProject(projects, projectKey);
  const key = queueKey(projectKey, "user");
  const blockSeconds = readIntegerOption(getOption(cli, "block"), 0);

  const rawPayload =
    blockSeconds > 0
      ? (await redis.blpop(key, blockSeconds))?.[1] ?? null
      : await redis.lpop(key);

  if (rawPayload === null) {
    logEvent("info", "cli.poll.empty", {
      projectKey,
      queue: key,
    });
    return;
  }

  const message = parseEnvelope(rawPayload, projectKey, project.roomId);

  logEvent("info", "cli.poll.message", {
    projectKey,
    queue: key,
    sender: message.sender ?? null,
    eventId: message.id,
    message,
  });
}

function resolvePort(): number {
  const configuredPort = Number(process.env.PORT ?? cfg.port ?? 8888);
  if (Number.isInteger(configuredPort) && configuredPort >= 0) {
    return configuredPort;
  }
  return 8888;
}

async function commandDaemon(redisConfig: RedisConfig): Promise<void> {
  const roomToProject = buildRoomToProjectMap(projects, (payload) => {
    logEvent("warn", "config.room.duplicate", payload);
  });
  const queueToProject = new Map<string, string>();
  for (const [projectKey] of Object.entries(projects)) {
    queueToProject.set(queueKey(projectKey, "agent"), projectKey);
  }
  const autoOpenCodeQueueToProject = buildAutoOpenCodeMap();
  const autoOpenCodeProjectKeys = new Set(
    [...autoOpenCodeQueueToProject.values()].map((item) => item.projectKey),
  );
  await validateAutoOpenCodeProjects(autoOpenCodeQueueToProject);

  if (queueToProject.size === 0) {
    throw new Error("no projects configured in config.json");
  }

  const adminUserIds = parseAdminUserIds(cfg.adminUserIds);
  if (adminUserIds.size === 0) {
    logEvent("warn", "config.admin_user_ids.empty", {
      message:
        "inbound Matrix ingestion will accept all senders except the bot user",
    });
  }

  const botUserId = await fetchBotUserId(matrixClientConfig(), (detail: string) => {
    logEvent("warn", "matrix.whoami.failed", {
      error: detail,
      message: "bot sender filtering disabled",
    });
  });
  const authTokens = parseAgentApiTokens(cfg);

  const outboundRedis = await createRedisClient(redisConfig);
  const inboundRedis = await createRedisClient(redisConfig);
  const apiRedis = await createRedisClient(redisConfig);
  const autoOpenCodeWorkerClients = new Set<Redis>();

  const port = resolvePort();
  const server = await startHttpFacade({
    apiRedis,
    authTokens,
    resolveProject: (projectKey: string) => resolveProject(projects, projectKey),
    projectKeys: () => Object.keys(projects),
    queueKey,
    parseEnvelope,
    createEnvelope,
  }, port);

  logEvent("info", "daemon.online", {
    port: server.port,
    redisHost: redisConfig.host,
    redisPort: redisConfig.port,
    redisDb: redisConfig.db,
    outboundQueues: [...queueToProject.keys()],
    inboundRooms: [...roomToProject.keys()],
    autoOpenCodeProjects: [...autoOpenCodeQueueToProject.values()].map((item) => ({
      projectKey: item.projectKey,
      command: item.command,
      commandPrefix: item.commandPrefix,
      allowedCliCommands: [...item.allowedCliCommands],
      cwd: item.cwd,
      senderAllowlistSize: item.senderAllowlist.size,
    })),
    botUserId: botUserId ?? "unknown",
    authTokenCount: authTokens.size,
  });

  runOutboundLoop({
    outboundRedis,
    queueToProject,
    resolveProjectRoomId: (projectKey: string) => resolveProject(projects, projectKey).roomId,
    parseEnvelope,
    matrixClientConfig,
  }).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    recordFailure("outbound_loop_fatal");
    logEvent("error", "outbound.loop.fatal", {
      error: detail,
    });
  });

  runInboundLoop({
    inboundRedis,
    roomToProject,
    autoOpenCodeProjectKeys,
    adminUserIds,
    queueKey,
    syncTokenKey: SYNC_TOKEN_KEY,
    legacySyncTokenKey: LEGACY_SYNC_TOKEN_KEY,
    managementCommandPrefix: MANAGEMENT_COMMAND_PREFIX,
    renderHelp: () => generalHelp(DEFAULT_AUTO_OPENCODE_COMMAND_PREFIX, MANAGEMENT_COMMAND_PREFIX),
    isStopMessage,
    requestStopForProject,
    splitCommandTokens,
    parseManagementCommandArgs,
    executeManagementCommand: async (parsed: unknown, sender: string) => {
      const result = await executeManagementCommand({
        command: parsed as ParsedManagementCommand,
        currentProjects: projects,
        senderUserId: sender,
        commandPrefix: MANAGEMENT_COMMAND_PREFIX,
        configPath: CONFIG_JSON_PATH,
        appConfig: cfg,
      });
      projects = result.projects;
      return result.response;
    },
    matrixClientConfig,
    botUserId,
    managementRoomId: cfg.managementRoomId,
  }).catch(
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      recordFailure("inbound_loop_fatal");
      logEvent("error", "inbound.loop.fatal", {
        error: detail,
      });
    },
  );

  for (const [userQueue, autoProject] of autoOpenCodeQueueToProject.entries()) {
    runAutoOpenCodeProjectSupervisor({
      redisConfig,
      userQueue,
      autoProject,
      workerClients: autoOpenCodeWorkerClients,
      restartBaseDelayMs: AUTO_OPENCODE_WORKER_RESTART_BASE_DELAY_MS,
      restartMaxDelayMs: AUTO_OPENCODE_WORKER_RESTART_MAX_DELAY_MS,
      createRedisClient,
      runWorker: (workerRedis, queue, project) =>
        runAutoOpenCodeProjectWorker({
          autoOpenCodeRedis: workerRedis,
          userQueue: queue,
          autoProject: project,
          constants: {
            maxMessageChars: AUTO_OPENCODE_MAX_MESSAGE_CHARS,
            maxContextChars: AUTO_OPENCODE_MAX_CONTEXT_CHARS,
            infiniteTimeoutHeartbeatMs: AUTO_OPENCODE_INFINITE_TIMEOUT_HEARTBEAT_MS,
            streamUpdateMinIntervalMs: AUTO_OPENCODE_STREAM_UPDATE_MIN_INTERVAL_MS,
            streamUpdateMinChars: AUTO_OPENCODE_STREAM_UPDATE_MIN_CHARS,
            streamPreviewMaxChars: AUTO_OPENCODE_STREAM_PREVIEW_MAX_CHARS,
          },
          deps: {
            parseEnvelope,
            queueKey,
            markAndCheckDuplicate,
            parseAutoOpenCodeCliRequest,
            executeAutoOpenCodeCliCommand: async (request, cliProject) => {
              const result = await executeAutoOpenCodeCliCommand({
                request,
                autoProject: cliProject,
                configPath: CONFIG_JSON_PATH,
                appConfig: cfg,
                currentProjects: projects,
                maxContextChars: AUTO_OPENCODE_MAX_CONTEXT_CHARS,
                runCommandWithInput: async (command, cwd, input, timeoutMs) =>
                  runCommandWithInput(command, cwd, input, timeoutMs),
              });
              projects = result.projects;
              return result.response;
            },
            enqueueAutoOpenCodeMessage,
            enqueueAutoOpenCodeStatus,
            prepareAutoOpenCodeContext: (envelope, contextProject, jobId) =>
              prepareAutoOpenCodeContext(envelope, contextProject, jobId, {
                maxMessageChars: AUTO_OPENCODE_MAX_MESSAGE_CHARS,
                maxContextChars: AUTO_OPENCODE_MAX_CONTEXT_CHARS,
              }),
            isOpenCodeRunCommand,
            runAutoOpenCodePrompt,
            appendTurnLog,
            setActiveRun: (projectKey, run) => {
              activeAutoOpenCodeRuns.set(projectKey, run);
            },
            getStopRequestedBy: (projectKey) => {
              const activeRun = activeAutoOpenCodeRuns.get(projectKey);
              return activeRun?.stopRequestedBy ?? null;
            },
            clearActiveRun: (projectKey, jobId) => {
              const activeRun = activeAutoOpenCodeRuns.get(projectKey);
              if (activeRun?.jobId === jobId) {
                activeAutoOpenCodeRuns.delete(projectKey);
              }
            },
            isStoppedError: (error: unknown): boolean => error instanceof AutoOpenCodeStoppedError,
          },
        }),
    }).catch(
      (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        recordFailure("auto_opencode_supervisor_fatal", autoProject.projectKey);
        logEvent("error", "auto_opencode.supervisor.fatal", {
          projectKey: autoProject.projectKey,
          queue: userQueue,
          error: detail,
        });
      },
    );
  }

  const shutdown = () => {
    logEvent("info", "daemon.shutdown");
    server.stop(true);
    outboundRedis.close();
    inboundRedis.close();
    apiRedis.close();
    for (const workerRedis of autoOpenCodeWorkerClients.values()) {
      workerRedis.close();
    }
    autoOpenCodeWorkerClients.clear();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<never>(() => {});
}

async function main() {
  const [command = "daemon", ...args] = process.argv.slice(2);
  const cli = parseCliArgs(args);

  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  const redisConfig = resolveRedisConfig(cfg);

  if (command === "daemon" || command === "worker") {
    await commandDaemon(redisConfig);
    return;
  }

  const redis = await createRedisClient(redisConfig);

  try {
    switch (command) {
      case "push-agent":
        await commandPush(redis, "agent", cli);
        return;
      case "push-user":
        await commandPush(redis, "user", cli);
        return;
      case "poll-user":
        await commandPollUser(redis, cli);
        return;
      default:
        throw new Error(`unknown command: ${command}`);
    }
  } finally {
    redis.close();
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  logEvent("error", "process.fatal", {
    error: detail,
  });
  process.exit(1);
});
