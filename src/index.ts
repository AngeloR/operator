import config from "../config.json";
import { marked } from "marked";
import { RedisClient } from "bun";
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type MessageFormat,
  nonEmptyText,
  parseFormat,
  parseOptionalString,
  tailLines,
  truncateInline,
  truncateText,
} from "./text";
import {
  appendCapturedOutput,
  appendStreamText,
  extractJsonLinesText,
  formatThinkingStreamDelta,
  parseOpenCodeStreamEvent,
  tryDecodeJsonMessageText,
} from "./opencode-stream";
import {
  buildMetricsSnapshot,
  collectQueueDepth,
  logEvent,
  recordFailure,
  recordProcessingLatency,
  recordWorkerRestart,
} from "./metrics";

type ProjectConfig = {
  roomId: string;
  prefix?: string;
  agent?: string;
  model?: string;
  command?: string[];
  commandPrefix?: string;
  allowedCliCommands?: string[];
  commandTimeoutSeconds?: number;
  timeoutSeconds?: number;
  heartbeatSeconds?: number;
  verbosity?: string;
  progressUpdates?: boolean;
  stateDir?: string;
  projectWorkingDirectory?: string;
  senderAllowlist?: string[];
  ackTemplate?: string;
  progressTemplate?: string;
  contextTailLines?: number;
};

type AppConfig = {
  homeserverUrl: string;
  accessToken: string;
  port?: number;
  projects: Record<string, ProjectConfig>;
  adminUserIds?: string[];
  managementRoomId?: string;
  agentApiToken?: string;
  agentApiTokens?: string[];
  redisUrl?: string;
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
  redisDb?: number;
};

type QueueDirection = "agent" | "user";
type AutoOpenCodeVerbosity = "debug" | "thinking" | "thinking-complete" | "output";

type ParsedMessage = {
  body: string;
  format: MessageFormat;
  agent?: string;
};

type MatrixMessageContent = {
  msgtype: "m.text";
  body: string;
  format: "org.matrix.custom.html";
  formatted_body: string;
};

type QueueEnvelope = {
  id: string;
  projectKey: string;
  roomId: string;
  body: string;
  format: MessageFormat;
  agent?: string;
  sender?: string;
  receivedAt: string;
};

type Redis = RedisClient;

type RedisConfig = {
  host: string;
  port: number;
  password?: string;
  db: number;
  connectTimeoutMs: number;
};

type ParsedCli = {
  positionals: string[];
  options: Map<string, string | true>;
};

type MatrixTimelineEvent = {
  type?: unknown;
  sender?: unknown;
  event_id?: unknown;
  origin_server_ts?: unknown;
  content?: unknown;
};

type MatrixSyncResponse = {
  next_batch?: unknown;
  rooms?: {
    join?: Record<string, { timeline?: { events?: unknown } }>;
    invite?: Record<string, unknown>;
  };
};

type MatrixWhoAmIResponse = {
  user_id?: unknown;
};

type MatrixJoinRoomResponse = {
  room_id?: unknown;
};

type JsonObject = Record<string, unknown>;

type AgentPollRequest = {
  projectKey: string;
  agent?: string;
  blockSeconds: number;
};

type AgentSendRequest = {
  projectKey: string;
  body: string;
  format: MessageFormat;
  agent?: string;
};

type AutoOpenCodeProject = {
  projectKey: string;
  roomId: string;
  agent: string;
  model?: string;
  command: string[];
  commandPrefix: string;
  allowedCliCommands: Set<AutoOpenCodeCliCommand>;
  commandTimeoutMs: number;
  timeoutMs: number | null;
  heartbeatMs: number;
  verbosity: AutoOpenCodeVerbosity;
  progressUpdates: boolean;
  stateDir: string;
  cwd: string;
  senderAllowlist: Set<string>;
  ackTemplate: string;
  progressTemplate: string;
  contextTailLines: number;
};

type CommandRunResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
};

type CommandStreamHandlers = {
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
};

type PreparedAutoOpenCodeCommand = {
  command: string[];
};

type AutoOpenCodeStatePaths = {
  rootDir: string;
  inboxLogPath: string;
  outboxLogPath: string;
  rollingSummaryPath: string;
  currentContextPath: string;
};

type AutoOpenCodeStreamHandlers = {
  onStreamPhase?: (phase: string) => void;
  onStreamText?: (text: string, isReasoning: boolean) => void;
  onThinkingTitle?: (title: string) => void;
};

type AutoOpenCodeCliCommand = "usage" | "stats" | "models" | "model" | "help";

type ParsedAutoOpenCodeCliRequest = {
  command: AutoOpenCodeCliCommand;
  args: string[];
};

const cfg = config as AppConfig;
let projects = cfg.projects ?? {};
const CONFIG_JSON_PATH = fileURLToPath(new URL("../config.json", import.meta.url));
const SYNC_TOKEN_KEY = "matrix-agent:sync:next-batch:v1";
const DEFAULT_AUTO_OPENCODE_COMMAND = ["opencode", "run"];
const DEFAULT_AUTO_OPENCODE_COMMAND_PREFIX = "!oc";
const DEFAULT_AUTO_OPENCODE_ALLOWED_CLI_COMMANDS = ["usage", "stats", "models", "model", "help"];
const DEFAULT_AUTO_OPENCODE_COMMAND_TIMEOUT_SECONDS = 30;
const DEFAULT_AUTO_OPENCODE_TIMEOUT_SECONDS = 300;
const DEFAULT_AUTO_OPENCODE_HEARTBEAT_SECONDS = 45;
const AUTO_OPENCODE_INFINITE_TIMEOUT_HEARTBEAT_MS = 15 * 60 * 1000;
const DEFAULT_AUTO_OPENCODE_VERBOSITY: AutoOpenCodeVerbosity = "output";
const DEFAULT_AUTO_OPENCODE_PROGRESS_UPDATES = true;
const DEFAULT_AUTO_OPENCODE_STATE_DIR = ".matrix-agent-state";
const DEFAULT_AUTO_OPENCODE_ACK_TEMPLATE =
  "Received your message. Starting OpenCode job {{job_id}}.";
const DEFAULT_AUTO_OPENCODE_PROGRESS_TEMPLATE = "OpenCode {{phase}} (job {{job_id}}).";
const DEFAULT_AUTO_OPENCODE_CONTEXT_TAIL_LINES = 60;
const AUTO_OPENCODE_MAX_MESSAGE_CHARS = 16_000;
const AUTO_OPENCODE_MAX_CONTEXT_CHARS = 24_000;
const AUTO_OPENCODE_DEDUP_WINDOW_MS = 30 * 60 * 1000;
const AUTO_OPENCODE_DEDUP_MAX_IDS = 2000;
const AUTO_OPENCODE_STREAM_UPDATE_MIN_INTERVAL_MS = 5000;
const AUTO_OPENCODE_STREAM_UPDATE_MIN_CHARS = 200;
const AUTO_OPENCODE_STREAM_PREVIEW_MAX_CHARS = 4000;
const AUTO_OPENCODE_WORKER_RESTART_BASE_DELAY_MS = 1000;
const AUTO_OPENCODE_WORKER_RESTART_MAX_DELAY_MS = 30_000;
const AUTO_OPENCODE_CLI_ALLOWED_COMMANDS = new Set<AutoOpenCodeCliCommand>([
  "usage",
  "stats",
  "models",
  "model",
  "help",
]);

if (!cfg.homeserverUrl || !cfg.accessToken) {
  throw new Error("config.json must include homeserverUrl and accessToken");
}

function json(status: number, payload: unknown): Response {
  return Response.json(payload, { status });
}

function parseAdminUserIds(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set<string>();

  const ids = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);

  return new Set(ids);
}

function parseAgentApiTokens(appConfig: AppConfig): Set<string> {
  const tokens: string[] = [];

  const envToken = nonEmptyText(process.env.AGENT_API_TOKEN);
  if (envToken) {
    tokens.push(envToken);
  }

  const envTokens = nonEmptyText(process.env.AGENT_API_TOKENS);
  if (envTokens) {
    tokens.push(
      ...envTokens
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    );
  }

  const cfgSingle = nonEmptyText(appConfig.agentApiToken);
  if (cfgSingle) {
    tokens.push(cfgSingle);
  }

  if (Array.isArray(appConfig.agentApiTokens)) {
    tokens.push(
      ...appConfig.agentApiTokens
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0),
    );
  }

  return new Set(tokens);
}

async function persistProjectModel(
  projectKey: string,
  model: string | null,
): Promise<void> {
  const rawConfig = await readFile(CONFIG_JSON_PATH, "utf8");

  let parsedConfig: unknown;
  try {
    parsedConfig = JSON.parse(rawConfig) as unknown;
  } catch {
    throw new Error("config.json is not valid JSON");
  }

  if (typeof parsedConfig !== "object" || parsedConfig === null || Array.isArray(parsedConfig)) {
    throw new Error("config.json root must be a JSON object");
  }

  const configObject = parsedConfig as Record<string, unknown>;
  const projects = configObject.projects;

  if (typeof projects !== "object" || projects === null || Array.isArray(projects)) {
    throw new Error("config.json projects must be an object");
  }

  const project = (projects as Record<string, unknown>)[projectKey];

  if (typeof project !== "object" || project === null) {
    throw new Error(`project "${projectKey}" not found in config.json`);
  }

  const projectConfig = project as Record<string, unknown>;

  if (model === null) {
    delete projectConfig.model;
  } else {
    projectConfig.model = model;
  }

  await writeFile(CONFIG_JSON_PATH, `${JSON.stringify(configObject, null, 2)}\n`, "utf8");
}

async function persistProjectConfig(
  projectKey: string,
  projectConfig: ProjectConfig | null,
): Promise<void> {
  const rawConfig = await readFile(CONFIG_JSON_PATH, "utf8");

  let parsedConfig: unknown;
  try {
    parsedConfig = JSON.parse(rawConfig) as unknown;
  } catch {
    throw new Error("config.json is not valid JSON");
  }

  if (typeof parsedConfig !== "object" || parsedConfig === null || Array.isArray(parsedConfig)) {
    throw new Error("config.json root must be a JSON object");
  }

  const configObject = parsedConfig as Record<string, unknown>;
  const projects = configObject.projects;

  if (typeof projects !== "object" || projects === null || Array.isArray(projects)) {
    throw new Error("config.json projects must be an object");
  }

  const projectsObj = projects as Record<string, unknown>;

  if (projectConfig === null) {
    if (!projectsObj[projectKey]) {
      throw new Error(`project "${projectKey}" not found in config.json`);
    }
    delete projectsObj[projectKey];
  } else {
    projectsObj[projectKey] = projectConfig;
  }

  await writeFile(CONFIG_JSON_PATH, `${JSON.stringify(configObject, null, 2)}\n`, "utf8");
}

async function loadConfig(): Promise<void> {
  const rawConfig = await readFile(CONFIG_JSON_PATH, "utf8");

  let parsedConfig: unknown;
  try {
    parsedConfig = JSON.parse(rawConfig) as unknown;
  } catch {
    throw new Error("config.json is not valid JSON");
  }

  if (typeof parsedConfig !== "object" || parsedConfig === null || Array.isArray(parsedConfig)) {
    throw new Error("config.json root must be a JSON object");
  }

  const configObject = parsedConfig as Record<string, unknown>;

  if (!configObject.homeserverUrl || !configObject.accessToken) {
    throw new Error("config.json must include homeserverUrl and accessToken");
  }

  const projectsObj = configObject.projects;
  if (typeof projectsObj !== "object" || projectsObj === null || Array.isArray(projectsObj)) {
    throw new Error("config.json projects must be an object");
  }

  cfg.homeserverUrl = configObject.homeserverUrl as string;
  cfg.accessToken = configObject.accessToken as string;
  cfg.port = configObject.port as number | undefined;
  cfg.projects = projectsObj as Record<string, ProjectConfig>;
  cfg.adminUserIds = configObject.adminUserIds as string[] | undefined;
  cfg.managementRoomId = configObject.managementRoomId as string | undefined;
  cfg.agentApiToken = configObject.agentApiToken as string | undefined;
  cfg.agentApiTokens = configObject.agentApiTokens as string[] | undefined;
  cfg.redisUrl = configObject.redisUrl as string | undefined;
  cfg.redisHost = configObject.redisHost as string | undefined;
  cfg.redisPort = configObject.redisPort as number | undefined;
  cfg.redisPassword = configObject.redisPassword as string | undefined;
  cfg.redisDb = configObject.redisDb as number | undefined;

  projects = cfg.projects ?? {};
}

function toPlainHtml(text: string): string {
  return Bun.escapeHTML(text).replace(/\n/g, "<br>\n");
}

function toMarkdownHtml(text: string): string {
  const rendered = marked.parse(text, {
    async: false,
    breaks: true,
    gfm: true,
  });

  return typeof rendered === "string" ? rendered : toPlainHtml(text);
}

function buildMatrixContent(message: ParsedMessage): MatrixMessageContent {
  const formattedBody =
    message.format === "markdown"
      ? toMarkdownHtml(message.body)
      : toPlainHtml(message.body);

  return {
    msgtype: "m.text",
    body: message.body,
    format: "org.matrix.custom.html",
    formatted_body: formattedBody,
  };
}

function queueKey(projectKey: string, direction: QueueDirection): string {
  return `${projectKey}:${direction}`;
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
      command !== "help"
    ) {
      throw new Error(
        "allowedCliCommands entries must be one of: usage, stats, models, model, help",
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

function parseSenderAllowlist(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    throw new Error("senderAllowlist must be an array of user IDs");
  }

  const ids = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);

  if (ids.length === 0) {
    throw new Error("senderAllowlist must include at least one user ID");
  }

  return new Set(ids);
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

function isCommandOptionToken(
  token: string,
  longName: string,
  shortName?: string,
): boolean {
  if (token === `--${longName}` || token.startsWith(`--${longName}=`)) {
    return true;
  }

  if (!shortName) {
    return false;
  }

  return token === `-${shortName}` || token.startsWith(`-${shortName}=`);
}

function commandHasOption(
  command: string[],
  longName: string,
  shortName?: string,
): boolean {
  for (const token of command) {
    if (isCommandOptionToken(token, longName, shortName)) {
      return true;
    }
  }
  return false;
}

function isOpenCodeRunCommand(command: string[]): boolean {
  const executable = command[0];
  if (!executable) {
    return false;
  }

  const fileName = basename(executable).toLowerCase();
  if (fileName !== "opencode" && fileName !== "opencode.exe") {
    return false;
  }

  return command.some((token) => token === "run" || token === "r");
}

function prepareAutoOpenCodeCommand(
  command: string[],
  verbosity: AutoOpenCodeVerbosity,
  modelOverride?: string,
): PreparedAutoOpenCodeCommand {
  if (!isOpenCodeRunCommand(command)) {
    throw new Error("autoOpenCodeCommand must invoke `opencode run`");
  }

  const prepared: PreparedAutoOpenCodeCommand = {
    command: [...command],
  };

  if (!commandHasOption(prepared.command, "format", "f")) {
    prepared.command.push("--format", "json");
  }

  const needsThinking = verbosity === "thinking" || verbosity === "thinking-complete";
  if (needsThinking && !commandHasOption(prepared.command, "thinking")) {
    prepared.command.push("--thinking");
  }

  if (modelOverride && !commandHasOption(prepared.command, "model", "m")) {
    prepared.command.push("--model", modelOverride);
  }

  return prepared;
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
    const stateDir = parseString(
      project.stateDir,
      DEFAULT_AUTO_OPENCODE_STATE_DIR,
      "stateDir",
    );
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

function parseBlockSeconds(value: unknown, fallback: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }

  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    n = Number(value);
  } else {
    throw new Error("block_seconds must be a number");
  }

  if (!Number.isInteger(n) || n < 0 || n > 300) {
    throw new Error("block_seconds must be an integer between 0 and 300");
  }

  return n;
}

function resolveProject(projectKey: string): ProjectConfig {
  const project = projects[projectKey];
  if (!project) {
    throw new Error(`unknown project: ${projectKey}`);
  }
  if (!project.roomId) {
    throw new Error(`project "${projectKey}" has no roomId`);
  }
  return project;
}

function buildRoomToProjectMap(): Map<string, string> {
  const roomToProject = new Map<string, string>();

  for (const [projectKey, project] of Object.entries(projects)) {
    const roomId = nonEmptyText(project.roomId);
    if (!roomId) {
      continue;
    }

    const previous = roomToProject.get(roomId);
    if (previous && previous !== projectKey) {
      logEvent("warn", "config.room.duplicate", {
        projectKey,
        roomId,
        previousProjectKey: previous,
        selectedProjectKey: previous,
      });
      continue;
    }

    roomToProject.set(roomId, projectKey);
  }

  return roomToProject;
}

async function readBodyFromArgsOrStdin(args: string[]): Promise<string | null> {
  const positional = nonEmptyText(args.join(" "));
  if (positional) return positional;

  if (process.stdin.isTTY) return null;

  const raw = await new Response(Bun.stdin.stream()).text();
  return nonEmptyText(raw);
}

function resolveRedisConfig(appConfig: AppConfig): RedisConfig {
  const rawUrl =
    process.env.REDIS_URL ?? appConfig.redisUrl ?? "redis://localhost:6379/0";

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`invalid Redis URL: ${rawUrl}`);
  }

  if (url.protocol !== "redis:") {
    throw new Error(`unsupported Redis protocol in URL: ${url.protocol}`);
  }

  const host = process.env.REDIS_HOST ?? appConfig.redisHost ?? url.hostname;
  const portRaw =
    process.env.REDIS_PORT ??
    (appConfig.redisPort !== undefined
      ? String(appConfig.redisPort)
      : url.port || "6379");
  const dbRaw =
    process.env.REDIS_DB ??
    (appConfig.redisDb !== undefined
      ? String(appConfig.redisDb)
      : url.pathname.replace(/^\//, "") || "0");
  const timeoutRaw = process.env.REDIS_CONNECT_TIMEOUT_MS ?? "5000";

  const port = Number(portRaw);
  const db = Number(dbRaw);
  const connectTimeoutMs = Number(timeoutRaw);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`invalid Redis port: ${portRaw}`);
  }

  if (!Number.isInteger(db) || db < 0) {
    throw new Error(`invalid Redis DB index: ${dbRaw}`);
  }

  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs <= 0) {
    throw new Error(`invalid REDIS_CONNECT_TIMEOUT_MS: ${timeoutRaw}`);
  }

  const passwordFromUrl = url.password
    ? decodeURIComponent(url.password)
    : undefined;

  return {
    host,
    port,
    db,
    connectTimeoutMs,
    password:
      process.env.REDIS_PASSWORD ?? appConfig.redisPassword ?? passwordFromUrl,
  };
}

async function createRedisClient(redisConfig: RedisConfig): Promise<Redis> {
  const redisUrl = new URL("redis://localhost");
  redisUrl.hostname = redisConfig.host;
  redisUrl.port = String(redisConfig.port);
  redisUrl.pathname = `/${redisConfig.db}`;
  if (redisConfig.password) {
    redisUrl.username = "default";
    redisUrl.password = redisConfig.password;
  }

  const redis = new RedisClient(redisUrl.toString(), {
    connectionTimeout: redisConfig.connectTimeoutMs,
    maxRetries: 1,
  });

  try {
    await redis.connect();
    return redis;
  } catch (error: unknown) {
    redis.close();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to connect to Redis at ${redisConfig.host}:${redisConfig.port}/${redisConfig.db}: ${detail}`,
    );
  }
}

function createEnvelope(
  projectKey: string,
  roomId: string,
  body: string,
  format: MessageFormat,
  extras: { agent?: string; sender?: string },
): QueueEnvelope {
  return {
    id: crypto.randomUUID(),
    projectKey,
    roomId,
    body,
    format,
    receivedAt: new Date().toISOString(),
    agent: extras.agent,
    sender: extras.sender,
  };
}

function parseEnvelope(
  raw: string,
  fallbackProjectKey: string,
  fallbackRoomId: string,
): QueueEnvelope {
  let payload: unknown;

  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    payload = raw;
  }

  if (typeof payload === "string") {
    const body = nonEmptyText(payload);
    if (!body) {
      throw new Error("queue payload is empty");
    }

    return createEnvelope(
      fallbackProjectKey,
      fallbackRoomId,
      body,
      "markdown",
      {},
    );
  }

  if (typeof payload !== "object" || payload === null) {
    throw new Error("queue payload must be an object or string");
  }

  const obj = payload as Record<string, unknown>;

  const body =
    nonEmptyText(obj.body) ??
    nonEmptyText(obj.markdown) ??
    nonEmptyText(obj.message) ??
    nonEmptyText(obj.text);

  if (!body) {
    throw new Error("queue payload has no message body");
  }

  const candidateId = nonEmptyText(obj.id);
  const candidateProject = nonEmptyText(obj.projectKey);
  const candidateRoom = nonEmptyText(obj.roomId);
  const candidateReceivedAt = nonEmptyText(obj.receivedAt);

  return {
    id: candidateId ?? crypto.randomUUID(),
    projectKey: candidateProject ?? fallbackProjectKey,
    roomId: candidateRoom ?? fallbackRoomId,
    body,
    format: parseFormat(obj.format),
    agent: parseOptionalString(obj.agent),
    sender: parseOptionalString(obj.sender),
    receivedAt: candidateReceivedAt ?? new Date().toISOString(),
  };
}

async function readJsonOrNull(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function throwMatrixHttpError(
  response: Response,
  payload: unknown,
  fallbackDetail: string,
): never {
  const err = payload as { errcode?: unknown; error?: unknown };
  const errcode = typeof err?.errcode === "string" ? err.errcode : "M_UNKNOWN";
  const detail = typeof err?.error === "string"
    ? err.error
    : fallbackDetail || `HTTP ${response.status} ${response.statusText}`;
  throw new Error(`${errcode}: ${detail}`);
}

async function matrixRequest<T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  options: {
    query?: Record<string, string | undefined>;
    payload?: unknown;
    fallbackErrorDetail?: string;
  } = {},
): Promise<T> {
  const url = new URL(path, cfg.homeserverUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.accessToken}`,
  };

  let body: string | undefined;
  if (options.payload !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.payload);
  }

  const response = await fetch(url, {
    method,
    headers,
    body,
  });

  const payload = await readJsonOrNull(response);

  if (!response.ok) {
    throwMatrixHttpError(
      response,
      payload,
      options.fallbackErrorDetail ?? `HTTP ${response.status} ${response.statusText}`,
    );
  }

  return payload as T;
}

async function matrixGet<T>(
  path: string,
  query: Record<string, string | undefined>,
): Promise<T> {
  return matrixRequest<T>("GET", path, { query });
}

async function matrixPost<T>(path: string, payload: unknown): Promise<T> {
  return matrixRequest<T>("POST", path, { payload });
}

async function fetchBotUserId(): Promise<string | undefined> {
  try {
    const whoami = await matrixGet<MatrixWhoAmIResponse>(
      "/_matrix/client/v3/account/whoami",
      {},
    );
    return nonEmptyText(whoami.user_id) ?? undefined;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    logEvent("warn", "matrix.whoami.failed", {
      error: detail,
      message: "bot sender filtering disabled",
    });
    return undefined;
  }
}

async function syncMatrix(
  since: string | undefined,
  timeoutMs: number,
): Promise<MatrixSyncResponse> {
  return matrixGet<MatrixSyncResponse>("/_matrix/client/v3/sync", {
    timeout: String(timeoutMs),
    since,
  });
}

async function joinMatrixRoom(roomId: string): Promise<string | undefined> {
  const joined = await matrixPost<MatrixJoinRoomResponse>(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    {},
  );
  return nonEmptyText(joined.room_id) ?? undefined;
}

function toUserQueueEnvelope(
  event: MatrixTimelineEvent,
  projectKey: string,
  roomId: string,
  adminUserIds: Set<string>,
  botUserId?: string,
): QueueEnvelope | null {
  if (event.type !== "m.room.message") {
    return null;
  }

  const sender = nonEmptyText(event.sender);
  if (!sender) {
    return null;
  }

  if (botUserId && sender === botUserId) {
    return null;
  }

  if (adminUserIds.size > 0 && !adminUserIds.has(sender)) {
    return null;
  }

  if (typeof event.content !== "object" || event.content === null) {
    return null;
  }

  const content = event.content as Record<string, unknown>;
  const body = nonEmptyText(content.body);
  if (!body) {
    return null;
  }

  if (content["m.relates_to"] !== undefined) {
    return null;
  }

  const ts =
    typeof event.origin_server_ts === "number"
      ? new Date(event.origin_server_ts).toISOString()
      : new Date().toISOString();

  return {
    id: nonEmptyText(event.event_id) ?? crypto.randomUUID(),
    projectKey,
    roomId,
    body,
    format: "plain",
    sender,
    receivedAt: ts,
  };
}

async function sendToRoom(
  roomId: string,
  content: MatrixMessageContent,
): Promise<string> {
  const txnId = crypto.randomUUID();
  const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`;
  const payload = await matrixRequest<{ event_id?: unknown }>("PUT", path, {
    payload: content,
    fallbackErrorDetail: "Matrix request failed",
  });

  if (typeof payload.event_id !== "string") {
    throw new Error("Matrix response missing event_id");
  }

  return payload.event_id;
}

async function runCommandWithInput(
  command: string[],
  cwd: string,
  input: string,
  timeoutMs: number | null,
  handlers?: CommandStreamHandlers,
): Promise<CommandRunResult> {
  const executable = command[0];
  if (!executable) {
    throw new Error("command must include an executable");
  }

  return new Promise<CommandRunResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child: any = spawn(executable, command.slice(1), {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    let timeout: NodeJS.Timeout | null = null;
    if (timeoutMs !== null) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");

        setTimeout(() => {
          child.kill("SIGKILL");
        }, 1000).unref();
      }, timeoutMs);

      timeout.unref();
    }

    child.on("error", (error: Error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      settle(() => reject(error));
    });

    child.stdout.on("data", (chunk: string | Buffer) => {
      const text = chunk.toString();
      stdout = appendCapturedOutput(stdout, text);
      try {
        handlers?.onStdoutChunk?.(text);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        logEvent("warn", "command.stdout_handler.failed", {
          error: detail,
        });
      }
    });

    child.stderr.on("data", (chunk: string | Buffer) => {
      const text = chunk.toString();
      stderr = appendCapturedOutput(stderr, text);
      try {
        handlers?.onStderrChunk?.(text);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        logEvent("warn", "command.stderr_handler.failed", {
          error: detail,
        });
      }
    });

    child.stdin.on("error", () => {});
    child.stdin.end(input);

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      settle(() =>
        resolve({
          stdout,
          stderr,
          code,
          signal,
          timedOut,
        })
      );
    });
  });
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function splitCommandTokens(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escapeNext = false;

  for (const char of input) {
    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }

    if (char === "\\") {
      escapeNext = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escapeNext) {
    current += "\\";
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function parseAutoOpenCodeCliRequest(
  message: string,
  prefix: string,
): ParsedAutoOpenCodeCliRequest | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith(prefix)) {
    return null;
  }

  const nextChar = trimmed.charAt(prefix.length);
  if (nextChar && !/\s/.test(nextChar)) {
    return null;
  }

  const rest = trimmed.slice(prefix.length).trim();
  const tokens = splitCommandTokens(rest);
  const commandToken = tokens[0]?.toLowerCase() ?? "help";
  if (!AUTO_OPENCODE_CLI_ALLOWED_COMMANDS.has(commandToken as AutoOpenCodeCliCommand)) {
    return {
      command: "help",
      args: [],
    };
  }

  return {
    command: commandToken as AutoOpenCodeCliCommand,
    args: tokens.slice(1),
  };
}

function parsePositiveInteger(value: string, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function parseUsageCommandArgs(args: string[]): { model: string; days?: number; project?: string } {
  const model = nonEmptyText(args[0]);
  if (!model) {
    throw new Error("usage command requires a model (example: !oc usage openai/gpt-5.3-codex --days 30)");
  }

  let days: number | undefined;
  let project: string | undefined;

  for (let i = 1; i < args.length; i += 1) {
    const token = args[i];
    if (!token) {
      continue;
    }
    if (token === "--days") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("--days requires a value");
      }
      days = parsePositiveInteger(value, "days");
      i += 1;
      continue;
    }

    if (token.startsWith("--days=")) {
      days = parsePositiveInteger(token.slice("--days=".length), "days");
      continue;
    }

    if (token === "--project") {
      const value = nonEmptyText(args[i + 1]);
      if (!value) {
        throw new Error("--project requires a value");
      }
      project = value;
      i += 1;
      continue;
    }

    if (token.startsWith("--project=")) {
      const value = nonEmptyText(token.slice("--project=".length));
      if (!value) {
        throw new Error("--project requires a non-empty value");
      }
      project = value;
      continue;
    }

    throw new Error(`unsupported option for usage command: ${token}`);
  }

  return { model, days, project };
}

function parseStatsCommandArgs(args: string[]): string[] {
  const command = ["opencode", "stats"];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token) {
      continue;
    }
    if (token === "--days") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("--days requires a value");
      }
      parsePositiveInteger(value, "days");
      command.push("--days", value);
      i += 1;
      continue;
    }

    if (token.startsWith("--days=")) {
      const value = token.slice("--days=".length);
      parsePositiveInteger(value, "days");
      command.push(`--days=${value}`);
      continue;
    }

    if (token === "--models") {
      const maybeValue = args[i + 1];
      if (maybeValue && !maybeValue.startsWith("--")) {
        parsePositiveInteger(maybeValue, "models");
        command.push("--models", maybeValue);
        i += 1;
      } else {
        command.push("--models");
      }
      continue;
    }

    if (token.startsWith("--models=")) {
      const value = token.slice("--models=".length);
      if (value.length > 0) {
        parsePositiveInteger(value, "models");
      }
      command.push(`--models=${value}`);
      continue;
    }

    if (token === "--project") {
      const value = nonEmptyText(args[i + 1]);
      if (!value) {
        throw new Error("--project requires a value");
      }
      command.push("--project", value);
      i += 1;
      continue;
    }

    if (token.startsWith("--project=")) {
      const value = nonEmptyText(token.slice("--project=".length));
      if (!value) {
        throw new Error("--project requires a non-empty value");
      }
      command.push(`--project=${value}`);
      continue;
    }

    throw new Error(`unsupported option for stats command: ${token}`);
  }

  return command;
}

function parseModelsCommandArgs(args: string[]): string[] {
  const command = ["opencode", "models"];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token) {
      continue;
    }
    if (token === "--verbose" || token === "--refresh") {
      command.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      throw new Error(`unsupported option for models command: ${token}`);
    }

    if (command.length > 2) {
      throw new Error("models command accepts at most one provider positional argument");
    }
    command.push(token);
  }

  return command;
}

type ParsedModelCommandAction =
  | { action: "show" }
  | { action: "reset" }
  | { action: "set"; model: string };

function parseModelCommandArgs(args: string[]): ParsedModelCommandAction {
  if (args.length === 0) {
    return { action: "show" };
  }

  if (args.length > 1) {
    throw new Error("model command accepts exactly one argument: <model-id> or reset");
  }

  const value = nonEmptyText(args[0]);
  if (!value) {
    throw new Error("model command requires a model value or `reset`");
  }

  if (value.toLowerCase() === "reset") {
    return { action: "reset" };
  }

  return { action: "set", model: value };
}

function extractModelUsageBlock(output: string, model: string): string | null {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  const needle = model.toLowerCase();
  const start = lines.findIndex((line) => line.toLowerCase().includes(needle));
  if (start < 0) {
    return null;
  }

  const block: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      break;
    }
    if (i > start && line.includes("├") && !line.includes("│")) {
      break;
    }
    if (i > start && line.includes("└") && !line.includes("│")) {
      break;
    }
    if (line.trim().length === 0 && block.length > 0) {
      break;
    }
    block.push(line);
  }

  const compact = block.join("\n").trim();
  return compact.length > 0 ? compact : null;
}

function autoOpenCodeCliHelp(prefix: string): string {
  return [
    `OpenCode command mode is available with the ${prefix} prefix.`,
    "",
    `- ${prefix} usage <model> [--days N] [--project KEY]`,
    `- ${prefix} stats [--days N] [--models [N]] [--project KEY]`,
    `- ${prefix} models [provider] [--verbose] [--refresh]`,
    `- ${prefix} model [<model-id>|reset]`,
    `- ${prefix} help`,
  ].join("\n");
}

type ParsedManagementCommand =
  | { action: "list" }
  | { action: "create"; projectKey: string; roomId: string; projectWorkingDirectory: string }
  | { action: "delete"; projectKey: string }
  | { action: "show"; projectKey: string }
  | { action: "reload" }
  | { action: "help" };

function parseManagementCommandArgs(args: string[]): ParsedManagementCommand {
  const command = args[0]?.toLowerCase();

  if (!command || command === "help") {
    return { action: "help" };
  }

  if (command === "list") {
    return { action: "list" };
  }

  if (command === "reload") {
    return { action: "reload" };
  }

  if (command === "show") {
    const projectKey = nonEmptyText(args[1]);
    if (!projectKey) {
      throw new Error("project show requires a project name");
    }
    return { action: "show", projectKey };
  }

  if (command === "create") {
    const projectKey = nonEmptyText(args[1]);
    if (!projectKey) {
      throw new Error("project create requires a project name");
    }

    let roomId: string | undefined;
    let projectWorkingDirectory: string | undefined;

    for (let i = 2; i < args.length; i += 1) {
      const token = args[i];
      if (!token) continue;

      if (token === "--room" || token === "-r") {
        const parsed = nonEmptyText(args[i + 1]);
        roomId = parsed === null ? undefined : parsed;
        if (!roomId) {
          throw new Error("--room requires a room ID value");
        }
        i += 1;
        continue;
      }

      if (token.startsWith("--room=") || token.startsWith("-r=")) {
        const value = token.includes("=") ? token.split("=")[1] : undefined;
        const parsed = nonEmptyText(value ?? args[i + 1]);
        roomId = parsed === null ? undefined : parsed;
        if (!roomId) {
          throw new Error("--room requires a room ID value");
        }
        if (!token.includes("=")) {
          i += 1;
        }
        continue;
      }

      if (token === "--path" || token === "-p") {
        const parsed = nonEmptyText(args[i + 1]);
        projectWorkingDirectory = parsed === null ? undefined : parsed;
        if (!projectWorkingDirectory) {
          throw new Error("--path requires a directory path value");
        }
        i += 1;
        continue;
      }

      if (token.startsWith("--path=") || token.startsWith("-p=")) {
        const value = token.includes("=") ? token.split("=")[1] : undefined;
        const parsed = nonEmptyText(value ?? args[i + 1]);
        projectWorkingDirectory = parsed === null ? undefined : parsed;
        if (!projectWorkingDirectory) {
          throw new Error("--path requires a directory path value");
        }
        if (!token.includes("=")) {
          i += 1;
        }
        continue;
      }

      throw new Error(`unknown option: ${token}`);
    }

    if (!roomId) {
      throw new Error("project create requires --room <roomId>");
    }

    if (!projectWorkingDirectory) {
      throw new Error("project create requires --path <directory>");
    }

    return { action: "create", projectKey, roomId, projectWorkingDirectory };
  }

  if (command === "delete") {
    const projectKey = nonEmptyText(args[1]);
    if (!projectKey) {
      throw new Error("project delete requires a project name");
    }
    return { action: "delete", projectKey };
  }

  throw new Error(`unknown project command: ${command}`);
}

function managementCommandHelp(): string {
  return [
    "Project management commands:",
    "",
    "- !project list",
    "  Show all configured projects",
    "",
    "- !project create <name> --room <roomId> --path <directory>",
    "  Create a new project",
    "",
    "- !project delete <name>",
    "  Delete a project (use with caution)",
    "",
    "- !project show <name>",
    "  Display project configuration",
    "",
    "- !project reload",
    "  Hot-reload config from disk",
    "",
    "- !project help",
    "  Show this help message",
  ].join("\n");
}

function generalHelp(commandPrefix: string): string {
  return [
    "Available commands:",
    "",
    "General commands:",
    `- !help - Show this help message`,
    "",
    "OpenCode CLI commands:",
    `- ${commandPrefix} usage <model> [--days N] [--project KEY]`,
    `- ${commandPrefix} stats [--days N] [--models [N]] [--project KEY]`,
    `- ${commandPrefix} models [provider] [--verbose] [--refresh]`,
    `- ${commandPrefix} model [<model-id>|reset]`,
    `- ${commandPrefix} help`,
    "",
    "Project management commands (management room only):",
    "- !project list",
    "- !project create <name> --room <roomId> --path <directory>",
    "- !project delete <name>",
    "- !project show <name>",
    "- !project reload",
    "- !project help",
  ].join("\n");
}

async function executeManagementCommand(
  command: ParsedManagementCommand,
  currentProjects: Record<string, ProjectConfig>,
): Promise<string> {
  if (command.action === "help") {
    return managementCommandHelp();
  }

  if (command.action === "list") {
    if (Object.keys(currentProjects).length === 0) {
      return "No projects configured.";
    }

    const lines: string[] = ["Configured projects:", ""];
    for (const [key, project] of Object.entries(currentProjects)) {
      lines.push(`- ${key}: ${project.roomId}`);
      if (project.projectWorkingDirectory) {
        lines.push(`  working directory: ${project.projectWorkingDirectory}`);
      }
    }
    return lines.join("\n");
  }

  if (command.action === "show") {
    const project = currentProjects[command.projectKey];
    if (!project) {
      return `Project "${command.projectKey}" not found.`;
    }

    return [
      `Project: ${command.projectKey}`,
      "",
      "```json",
      JSON.stringify(project, null, 2),
      "```",
    ].join("\n");
  }

  if (command.action === "reload") {
    await loadConfig();
    const projectCount = Object.keys(projects).length;
    return [
      `Config hot-reloaded successfully.`,
      "",
      `Loaded ${projectCount} project(s).`,
    ].join("\n");
  }

  if (command.action === "create") {
    if (currentProjects[command.projectKey]) {
      return `Project "${command.projectKey}" already exists. Use !project delete first to remove it.`;
    }

    const newProject: ProjectConfig = {
      roomId: command.roomId,
      projectWorkingDirectory: command.projectWorkingDirectory,
      senderAllowlist: [],
      command: ["opencode", "run", "--format", "json"],
      timeoutSeconds: 3600,
      verbosity: "thinking",
      progressUpdates: true,
      stateDir: ".matrix-agent-state",
      ackTemplate: "Received. Starting OpenCode job {{job_id}}.",
      progressTemplate: "OpenCode {{phase}} (job {{job_id}}).",
      contextTailLines: 60,
    };

    await persistProjectConfig(command.projectKey, newProject);
    await loadConfig();

    return [
      `Created project "${command.projectKey}".`,
      "",
      "```json",
      JSON.stringify(newProject, null, 2),
      "```",
      "",
      "Config hot-reloaded successfully.",
    ].join("\n");
  }

  if (command.action === "delete") {
    if (!currentProjects[command.projectKey]) {
      return `Project "${command.projectKey}" not found.`;
    }

    await persistProjectConfig(command.projectKey, null);
    await loadConfig();

    return [
      `Deleted project "${command.projectKey}".`,
      "",
      "Config hot-reloaded successfully.",
    ].join("\n");
  }

  return "Unknown command.";
}

async function executeAutoOpenCodeCliCommand(
  request: ParsedAutoOpenCodeCliRequest,
  autoProject: AutoOpenCodeProject,
): Promise<string> {
  if (request.command === "help") {
    return autoOpenCodeCliHelp(autoProject.commandPrefix);
  }

  if (!autoProject.allowedCliCommands.has(request.command)) {
    throw new Error(
      `command ${request.command} is disabled for this project (allowed: ${[...autoProject.allowedCliCommands].join(", ")})`,
    );
  }

  if (request.command === "model") {
    const action = parseModelCommandArgs(request.args);
    const current = autoProject.model;

    if (action.action === "show") {
      return current
        ? [
          `Model override for project \`${autoProject.projectKey}\` is \`${current}\`.`,
          "",
          `Use \`${autoProject.commandPrefix} model reset\` to fall back to OpenCode defaults.`,
        ].join("\n")
        : [
          `No project model override is set for \`${autoProject.projectKey}\`.`,
          "",
          "OpenCode will use its configured default model.",
          `Set one with \`${autoProject.commandPrefix} model <model-id>\`.`,
        ].join("\n");
    }

    if (action.action === "reset") {
      if (!current) {
        return [
          `No project model override is set for \`${autoProject.projectKey}\`.`,
          "",
          "Nothing to reset.",
        ].join("\n");
      }

      await persistProjectModel(autoProject.projectKey, null);
      await loadConfig();
      return [
        `Cleared project model override for \`${autoProject.projectKey}\`.`,
        "",
        "OpenCode will now use its configured default model.",
        "",
        "Config hot-reloaded successfully.",
      ].join("\n");
    }

    await persistProjectModel(autoProject.projectKey, action.model);
    await loadConfig();
    return [
      `Set model override for \`${autoProject.projectKey}\` to \`${action.model}\`.`,
      "",
      "New OpenCode runs in this project will use that model.",
      "",
      "Config hot-reloaded successfully.",
    ].join("\n");
  }

  let command: string[];
  let modelFilter: string | null = null;

  if (request.command === "usage") {
    const { model, days, project } = parseUsageCommandArgs(request.args);
    modelFilter = model;
    command = ["opencode", "stats", "--models"];
    if (days !== undefined) {
      command.push("--days", String(days));
    }
    if (project) {
      command.push("--project", project);
    }
  } else if (request.command === "stats") {
    command = parseStatsCommandArgs(request.args);
  } else {
    command = parseModelsCommandArgs(request.args);
  }

  const result = await runCommandWithInput(
    command,
    autoProject.cwd,
    "",
    autoProject.commandTimeoutMs,
  );

  if (result.timedOut) {
    throw new Error(
      `command timed out after ${Math.round(autoProject.commandTimeoutMs / 1000)}s`,
    );
  }

  if (result.code !== 0) {
    const stderr = nonEmptyText(stripAnsi(result.stderr));
    const stdout = nonEmptyText(stripAnsi(result.stdout));
    throw new Error(stderr ?? stdout ?? `command exited with code ${result.code ?? "null"}`);
  }

  const cleaned = stripAnsi(result.stdout).trim();
  if (!cleaned) {
    throw new Error("command produced no output");
  }

  if (request.command === "usage" && modelFilter) {
    const modelBlock = extractModelUsageBlock(cleaned, modelFilter);
    if (!modelBlock) {
      return [
        `No usage section found for model \`${modelFilter}\`.`,
        "",
        "Try running one of:",
        `- ${autoProject.commandPrefix} stats --models`,
        `- ${autoProject.commandPrefix} models`,
      ].join("\n");
    }

    return [
      `Usage for \`${modelFilter}\`:`,
      "",
      "```text",
      truncateText(modelBlock, AUTO_OPENCODE_MAX_CONTEXT_CHARS),
      "```",
    ].join("\n");
  }

  return [
    `Ran \`${command.join(" ")}\``,
    "",
    "```text",
    truncateText(cleaned, AUTO_OPENCODE_MAX_CONTEXT_CHARS),
    "```",
  ].join("\n");
}

function resolveAutoOpenCodeStatePaths(autoProject: AutoOpenCodeProject): AutoOpenCodeStatePaths {
  const rootDir = join(autoProject.stateDir, autoProject.projectKey, autoProject.agent);
  return {
    rootDir,
    inboxLogPath: join(rootDir, "inbox.log"),
    outboxLogPath: join(rootDir, "outbox.log"),
    rollingSummaryPath: join(rootDir, "rolling-summary.md"),
    currentContextPath: join(rootDir, "current-context.md"),
  };
}

async function readTextFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function ensureAutoOpenCodeState(autoProject: AutoOpenCodeProject): Promise<AutoOpenCodeStatePaths> {
  const paths = resolveAutoOpenCodeStatePaths(autoProject);
  await mkdir(paths.rootDir, { recursive: true });
  return paths;
}

async function appendTurnLog(
  path: string,
  timestamp: string,
  actor: string,
  body: string,
): Promise<void> {
  const entry = `[${timestamp}] ${actor}\n${body}\n\n`;
  await appendFile(path, entry, "utf8");
}

async function buildRollingSummary(
  paths: AutoOpenCodeStatePaths,
  autoProject: AutoOpenCodeProject,
): Promise<string> {
  const inbox = await readTextFileOrEmpty(paths.inboxLogPath);
  const outbox = await readTextFileOrEmpty(paths.outboxLogPath);
  const inboxTail = tailLines(inbox, autoProject.contextTailLines);
  const outboxTail = tailLines(outbox, autoProject.contextTailLines);

  const summary = [
    "# Rolling Conversation Summary",
    "",
    `Project: ${autoProject.projectKey}`,
    `Agent: ${autoProject.agent}`,
    "",
    "## Recent Incoming",
    inboxTail || "(none)",
    "",
    "## Recent Outgoing",
    outboxTail || "(none)",
  ].join("\n");

  const truncated = truncateText(summary, AUTO_OPENCODE_MAX_CONTEXT_CHARS);
  await writeFile(paths.rollingSummaryPath, truncated, "utf8");
  return truncated;
}

function buildCurrentContext(
  envelope: QueueEnvelope,
  summary: string,
  jobId: string,
): string {
  const userBody = truncateText(envelope.body, AUTO_OPENCODE_MAX_MESSAGE_CHARS);
  return truncateText(
    [
      "# Matrix Task",
      "",
      `Job ID: ${jobId}`,
      `Project: ${envelope.projectKey}`,
      `Room: ${envelope.roomId}`,
      `Sender: ${envelope.sender ?? "unknown"}`,
      `Received At: ${envelope.receivedAt}`,
      `Event ID: ${envelope.id}`,
      "",
      "## Current User Message",
      userBody,
      "",
      "---",
      "",
      summary,
      "",
      "---",
      "",
      "Respond to the user in a concise, actionable way.",
    ].join("\n"),
    AUTO_OPENCODE_MAX_CONTEXT_CHARS,
  );
}

async function prepareAutoOpenCodeContext(
  envelope: QueueEnvelope,
  autoProject: AutoOpenCodeProject,
  jobId: string,
): Promise<{ paths: AutoOpenCodeStatePaths; context: string }> {
  const paths = await ensureAutoOpenCodeState(autoProject);
  await appendTurnLog(
    paths.inboxLogPath,
    envelope.receivedAt,
    envelope.sender ?? "unknown",
    truncateText(envelope.body, AUTO_OPENCODE_MAX_MESSAGE_CHARS),
  );

  const summary = await buildRollingSummary(paths, autoProject);
  const context = buildCurrentContext(envelope, summary, jobId);
  await writeFile(paths.currentContextPath, context, "utf8");
  return { paths, context };
}

async function runAutoOpenCodePrompt(
  prompt: string,
  autoProject: AutoOpenCodeProject,
  handlers?: AutoOpenCodeStreamHandlers,
): Promise<string> {
  const prepared = prepareAutoOpenCodeCommand(
    autoProject.command,
    autoProject.verbosity,
    autoProject.model,
  );

  let stdoutLineBuffer = "";
  let streamedText = "";
  let streamedReasoningText = "";
  let streamedOutputText = "";
  let streamError: string | null = null;

  const parseStdoutLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(trimmed) as unknown;
    } catch {
      return;
    }

    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return;
    }

    const obj = payload as Record<string, unknown>;
    const event = parseOpenCodeStreamEvent(obj);
    if (event.phase) {
      handlers?.onStreamPhase?.(event.phase);
    }

    if (event.reasoningTitle) {
      handlers?.onThinkingTitle?.(event.reasoningTitle);
    }

    if (event.text) {
      streamedText = appendStreamText(streamedText, event.text);
      if (event.isReasoning) {
        streamedReasoningText = appendStreamText(streamedReasoningText, event.text);
      } else {
        streamedOutputText = appendStreamText(streamedOutputText, event.text);
      }
      handlers?.onStreamText?.(event.text, event.isReasoning);
    }

    if (event.error && !streamError) {
      streamError = event.error;
    }
  };

  const commandStreamHandlers: CommandStreamHandlers = {
    onStdoutChunk: (chunk: string) => {
      stdoutLineBuffer += chunk;
      while (true) {
        const newlineIndex = stdoutLineBuffer.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }

        const line = stdoutLineBuffer.slice(0, newlineIndex);
        stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
        parseStdoutLine(line);
      }
    },
  };

  const result = await runCommandWithInput(
    prepared.command,
    autoProject.cwd,
    prompt,
    autoProject.timeoutMs,
    commandStreamHandlers,
  );

  if (stdoutLineBuffer.trim()) {
    parseStdoutLine(stdoutLineBuffer);
  }

  if (result.timedOut) {
    const timeoutSeconds = autoProject.timeoutMs === null
      ? "unknown"
      : `${Math.round(autoProject.timeoutMs / 1000)}s`;
    throw new Error(
      `command timed out after ${timeoutSeconds}`,
    );
  }

  if (streamError) {
    throw new Error(streamError);
  }

  if (result.code !== 0) {
    const stderr = nonEmptyText(result.stderr);
    const stdout = nonEmptyText(result.stdout);
    const signalInfo = result.signal ? ` (signal ${result.signal})` : "";
    throw new Error(
      `command exited with code ${result.code ?? "null"}${signalInfo}${
        stderr ? `: ${stderr}` : ""
      }${!stderr && stdout ? `: ${stdout}` : ""}`,
    );
  }

  const output = nonEmptyText(streamedOutputText) ??
    nonEmptyText(streamedReasoningText) ??
    nonEmptyText(streamedText) ??
    extractJsonLinesText(result.stdout) ??
    tryDecodeJsonMessageText(result.stdout) ??
    nonEmptyText(result.stdout);

  if (!output) {
    throw new Error("command produced no final output");
  }

  return output;
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

async function parseJsonObject(req: Request): Promise<JsonObject> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("content-type must be application/json");
  }

  let payload: unknown;
  try {
    payload = (await req.json()) as unknown;
  } catch {
    throw new Error("invalid JSON body");
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("request body must be a JSON object");
  }

  return payload as JsonObject;
}

function authorizeAgentRequest(req: Request, tokens: Set<string>): Response | null {
  if (tokens.size === 0) {
    return json(503, {
      error:
        "agent API auth is not configured; set config.agentApiToken(s) or AGENT_API_TOKEN(S)",
    });
  }

  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return json(401, { error: "missing bearer token" });
  }

  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    return json(401, { error: "missing bearer token" });
  }

  if (!tokens.has(token)) {
    return json(403, { error: "invalid bearer token" });
  }

  return null;
}

function parseProjectKeyFromPayload(payload: JsonObject): string {
  const projectKey = nonEmptyText(payload.project) ?? nonEmptyText(payload.project_key);
  if (!projectKey) {
    throw new Error("missing project (or project_key)");
  }
  return projectKey;
}

function parseAgentPollRequest(payload: JsonObject): AgentPollRequest {
  const agent = parseOptionalString(payload.agent);
  const blockSeconds = parseBlockSeconds(payload.block_seconds, 30);

  return {
    projectKey: parseProjectKeyFromPayload(payload),
    agent,
    blockSeconds,
  };
}

function parseAgentSendRequest(payload: JsonObject): AgentSendRequest {
  const markdown = nonEmptyText(payload.markdown);
  const body =
    nonEmptyText(payload.body) ??
    markdown ??
    nonEmptyText(payload.message) ??
    nonEmptyText(payload.text);

  if (!body) {
    throw new Error("missing message body");
  }

  const format = markdown && !nonEmptyText(payload.body)
    ? "markdown"
    : parseFormat(payload.format);

  return {
    projectKey: parseProjectKeyFromPayload(payload),
    body,
    format,
    agent: parseOptionalString(payload.agent),
  };
}

async function handleAgentPoll(
  req: Request,
  apiRedis: Redis,
  authTokens: Set<string>,
): Promise<Response> {
  const authError = authorizeAgentRequest(req, authTokens);
  if (authError) {
    return authError;
  }

  let parsed: AgentPollRequest;
  try {
    const payload = await parseJsonObject(req);
    parsed = parseAgentPollRequest(payload);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return json(400, { error: detail });
  }

  let project: ProjectConfig;
  try {
    project = resolveProject(parsed.projectKey);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return json(404, { error: detail });
  }

  try {
    const key = queueKey(parsed.projectKey, "user");
    const rawPayload =
      parsed.blockSeconds > 0
        ? (await apiRedis.blpop(key, parsed.blockSeconds))?.[1] ?? null
        : await apiRedis.lpop(key);

    if (rawPayload === null) {
      return json(200, {
        ok: true,
        projectKey: parsed.projectKey,
        queueKey: key,
        message: null,
      });
    }

    const message = parseEnvelope(rawPayload, parsed.projectKey, project.roomId);
    return json(200, {
      ok: true,
      projectKey: parsed.projectKey,
      queueKey: key,
      message,
      polledBy: parsed.agent ?? null,
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return json(502, { error: detail });
  }
}

async function handleAgentSend(
  req: Request,
  apiRedis: Redis,
  authTokens: Set<string>,
): Promise<Response> {
  const authError = authorizeAgentRequest(req, authTokens);
  if (authError) {
    return authError;
  }

  let parsed: AgentSendRequest;
  try {
    const payload = await parseJsonObject(req);
    parsed = parseAgentSendRequest(payload);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return json(400, { error: detail });
  }

  let project: ProjectConfig;
  try {
    project = resolveProject(parsed.projectKey);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return json(404, { error: detail });
  }

  try {
    const envelope = createEnvelope(
      parsed.projectKey,
      project.roomId,
      parsed.body,
      parsed.format,
      { agent: parsed.agent },
    );

    const key = queueKey(parsed.projectKey, "agent");
    const queueLength = await apiRedis.rpush(key, JSON.stringify(envelope));

    return json(200, {
      ok: true,
      queued: true,
      projectKey: parsed.projectKey,
      roomId: project.roomId,
      queueKey: key,
      queueLength,
      eventId: envelope.id,
      receivedAt: envelope.receivedAt,
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return json(502, { error: detail });
  }
}

async function handleMetrics(apiRedis: Redis): Promise<Response> {
  try {
    const queueDepth = await collectQueueDepth(
      apiRedis,
      Object.keys(projects),
      queueKey,
    );
    return json(200, {
      ok: true,
      service: "matrix-relay-core",
      generatedAt: new Date().toISOString(),
      queueDepth,
      ...buildMetricsSnapshot(),
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    recordFailure("metrics_endpoint");
    logEvent("error", "http.metrics.failed", {
      error: detail,
    });
    return json(502, { error: detail });
  }
}

function printUsage() {
  console.log(`matrix-relay-core

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
  commandPrefix: "!oc"                                 # in-room command prefix for opencode CLI shortcuts
  allowedCliCommands: ["usage","stats","models","model","help"] # command allowlist
  commandTimeoutSeconds: 30                            # timeout for prefixed in-room opencode commands
  timeoutSeconds: 300                                  # timeout per message (0 disables timeout + forces 15m heartbeat)
  heartbeatSeconds: 45                                 # periodic heartbeat for debug mode (0 disables)
  verbosity: "output"                                  # output|thinking|thinking-complete|debug
  senderAllowlist: ["@admin:your-server"]              # required
  progressUpdates: true                                # default true
  stateDir: ".matrix-agent-state"                      # default
  projectWorkingDirectory: "/abs/path/to/project"      # default: current relay-core cwd
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

  const project = resolveProject(projectKey);
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

  const project = resolveProject(projectKey);
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

async function runOutboundLoop(
  outboundRedis: Redis,
  queueToProject: Map<string, string>,
): Promise<never> {
  const queueNames = [...queueToProject.keys()];

  while (true) {
    try {
      const popped = await outboundRedis.blpop(...queueNames, 5);
      if (popped === null || popped.length < 2) {
        continue;
      }

      const poppedQueue = popped[0];
      const rawPayload = popped[1];

      const projectKey = queueToProject.get(poppedQueue);
      if (!projectKey) {
        recordFailure("outbound_unknown_queue");
        logEvent("error", "outbound.queue.unknown", {
          queue: poppedQueue,
          error: "unknown queue key from Redis",
        });
        continue;
      }

      const project = resolveProject(projectKey);
      const envelope = parseEnvelope(rawPayload, projectKey, project.roomId);
      const startedAt = Date.now();

      try {
        const eventId = await sendToRoom(
          envelope.roomId,
          buildMatrixContent({
            body: envelope.body,
            format: envelope.format,
            agent: envelope.agent,
          }),
        );
        const durationMs = Date.now() - startedAt;
        recordProcessingLatency("outbound_send", durationMs);
        logEvent("info", "outbound.send.success", {
          projectKey,
          queue: poppedQueue,
          sender: envelope.sender ?? null,
          durationMs,
          roomId: envelope.roomId,
          queuedEventId: envelope.id,
          matrixEventId: eventId,
        });
      } catch (error: unknown) {
        const detail =
          error instanceof Error
            ? error.message
            : "failed to send Matrix message";
        recordFailure("outbound_send", projectKey);
        const durationMs = Date.now() - startedAt;
        recordProcessingLatency("outbound_send", durationMs);
        logEvent("error", "outbound.send.failed", {
          projectKey,
          queue: poppedQueue,
          sender: envelope.sender ?? null,
          durationMs,
          roomId: envelope.roomId,
          queuedEventId: envelope.id,
          error: detail,
          requeued: true,
        });

        await outboundRedis.lpush(poppedQueue, rawPayload);
        await Bun.sleep(1000);
      }
    } catch (error: unknown) {
      const detail =
        error instanceof Error ? error.message : "worker loop failed";
      recordFailure("outbound_loop");
      logEvent("error", "outbound.loop.error", {
        error: detail,
      });
      await Bun.sleep(1000);
    }
  }
}

async function runAutoOpenCodeProjectWorker(
  autoOpenCodeRedis: Redis,
  userQueue: string,
  autoProject: AutoOpenCodeProject,
): Promise<never> {
  const projectDedup = new Map<string, number>();

  while (true) {
    try {
      const popped = await autoOpenCodeRedis.blpop(userQueue, 5);
      if (popped === null || popped.length < 2) {
        continue;
      }

      const poppedQueue = popped[0];
      const rawPayload = popped[1];

      if (poppedQueue !== userQueue) {
        recordFailure("auto_opencode_unexpected_queue", autoProject.projectKey);
        logEvent("error", "auto_opencode.queue.unexpected", {
          projectKey: autoProject.projectKey,
          queue: poppedQueue,
          expectedQueue: userQueue,
        });
        continue;
      }

      const envelope = parseEnvelope(
        rawPayload,
        autoProject.projectKey,
        autoProject.roomId,
      );
      const agentQueue = queueKey(autoProject.projectKey, "agent");
      const sender = envelope.sender ?? "unknown";

      if (!envelope.sender || !autoProject.senderAllowlist.has(envelope.sender)) {
        logEvent("info", "auto_opencode.message.skipped", {
          projectKey: autoProject.projectKey,
          queue: poppedQueue,
          sender,
          reason: "sender_not_allowlisted",
          queuedUserEventId: envelope.id,
        });
        continue;
      }

      if (markAndCheckDuplicate(projectDedup, envelope.id)) {
        logEvent("info", "auto_opencode.message.skipped", {
          projectKey: autoProject.projectKey,
          queue: poppedQueue,
          sender,
          reason: "duplicate_event",
          queuedUserEventId: envelope.id,
        });
        continue;
      }

      const cliRequest = parseAutoOpenCodeCliRequest(
        envelope.body,
        autoProject.commandPrefix,
      );
      if (cliRequest) {
        const startedAt = Date.now();
        try {
          const response = await executeAutoOpenCodeCliCommand(cliRequest, autoProject);
          const outbound = await enqueueAutoOpenCodeMessage(
            autoOpenCodeRedis,
            autoProject,
            truncateText(response, AUTO_OPENCODE_MAX_CONTEXT_CHARS),
            "markdown",
          );
          const durationMs = Date.now() - startedAt;
          recordProcessingLatency("auto_opencode_cli", durationMs);
          logEvent("info", "auto_opencode.cli.completed", {
            projectKey: autoProject.projectKey,
            queue: poppedQueue,
            sender,
            durationMs,
            command: cliRequest.command,
            queuedUserEventId: envelope.id,
            queuedAgentEventId: outbound.id,
          });
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : "OpenCode command failed";
          const durationMs = Date.now() - startedAt;
          recordFailure("auto_opencode_cli", autoProject.projectKey);
          recordProcessingLatency("auto_opencode_cli", durationMs);
          const outbound = await enqueueAutoOpenCodeMessage(
            autoOpenCodeRedis,
            autoProject,
            `OpenCode command failed: ${detail}`,
            "plain",
          );
          logEvent("warn", "auto_opencode.cli.failed", {
            projectKey: autoProject.projectKey,
            queue: poppedQueue,
            sender,
            durationMs,
            command: cliRequest.command,
            queuedUserEventId: envelope.id,
            queuedAgentEventId: outbound.id,
            error: detail,
          });
        }
        continue;
      }

      const jobId = crypto.randomUUID();
      const startedAt = Date.now();
      const debugStatusEnabled =
        autoProject.verbosity === "debug" && autoProject.progressUpdates;
      const streamPreviewEnabled =
        autoProject.verbosity !== "output" && autoProject.progressUpdates;
      const streamPhaseEventsEnabled =
        autoProject.verbosity === "debug" && autoProject.progressUpdates;

      try {
        let ack: QueueEnvelope | null = null;
        if (autoProject.verbosity === "debug") {
          ack = await enqueueAutoOpenCodeStatus(
            autoOpenCodeRedis,
            autoProject,
            autoProject.ackTemplate,
            "started",
            jobId,
            sender,
          );
        } else if (autoProject.verbosity === "output") {
          ack = await enqueueAutoOpenCodeMessage(
            autoOpenCodeRedis,
            autoProject,
            "Received.",
            "plain",
          );
        }

        if (debugStatusEnabled) {
          await enqueueAutoOpenCodeStatus(
            autoOpenCodeRedis,
            autoProject,
            autoProject.progressTemplate,
            "planning",
            jobId,
            sender,
          );
        }

        const { paths, context } = await prepareAutoOpenCodeContext(
          envelope,
          autoProject,
          jobId,
        );

        if (debugStatusEnabled) {
          await enqueueAutoOpenCodeStatus(
            autoOpenCodeRedis,
            autoProject,
            autoProject.progressTemplate,
            "executing",
            jobId,
            sender,
          );
        }

        const statusPromises = new Set<Promise<void>>();
        const noTimeoutMode = autoProject.timeoutMs === null;
        const isOpenCodeCommand = isOpenCodeRunCommand(autoProject.command);
        const heartbeatIntervalMs = noTimeoutMode
          ? AUTO_OPENCODE_INFINITE_TIMEOUT_HEARTBEAT_MS
          : autoProject.heartbeatMs;
        const heartbeatEnabled = debugStatusEnabled && heartbeatIntervalMs > 0 &&
          (noTimeoutMode || (!isOpenCodeCommand && autoProject.progressUpdates));

        const queueStatus = (phase: string, source: "heartbeat" | "stream"): void => {
          const pending = enqueueAutoOpenCodeStatus(
            autoOpenCodeRedis,
            autoProject,
            autoProject.progressTemplate,
            phase,
            jobId,
            sender,
          )
            .then(() => undefined)
            .catch((error: unknown) => {
              const detail = error instanceof Error ? error.message : String(error);
              logEvent("warn", "auto_opencode.status.enqueue_failed", {
                projectKey: autoProject.projectKey,
                queue: userQueue,
                sender,
                jobId,
                source,
                error: detail,
              });
            });

          statusPromises.add(pending);
          void pending.finally(() => statusPromises.delete(pending));
        };
        const queueStreamPreview = (preview: string): void => {
          const normalized = preview.replace(/\r\n/g, "\n");
          if (!/\S/.test(normalized)) {
            return;
          }

          for (
            let start = 0;
            start < normalized.length;
            start += AUTO_OPENCODE_MAX_MESSAGE_CHARS
          ) {
            const chunk = normalized.slice(
              start,
              start + AUTO_OPENCODE_MAX_MESSAGE_CHARS,
            );
            const pending = enqueueAutoOpenCodeMessage(
              autoOpenCodeRedis,
              autoProject,
              chunk,
              "markdown",
            )
              .then(() => undefined)
              .catch((error: unknown) => {
                const detail = error instanceof Error ? error.message : String(error);
                logEvent("warn", "auto_opencode.stream.enqueue_failed", {
                  projectKey: autoProject.projectKey,
                  queue: userQueue,
                  sender,
                  jobId,
                  error: detail,
                });
              });

            statusPromises.add(pending);
            void pending.finally(() => statusPromises.delete(pending));
          }
        };

        let heartbeatTimer: NodeJS.Timeout | null = null;
        if (heartbeatEnabled) {
          heartbeatTimer = setInterval(() => {
            const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
            const phase = noTimeoutMode
              ? `heartbeat (${elapsedSeconds}s elapsed; timeout=0)`
              : `heartbeat (${elapsedSeconds}s elapsed)`;
            queueStatus(phase, "heartbeat");
          }, heartbeatIntervalMs);
          heartbeatTimer.unref();
        }

        let streamText = "";
        let streamReasoningText = "";
        let latestStreamPhase = "executing";
        let lastStreamSentPhase: string | null = null;
        let lastStreamSentAt = 0;
        let lastStreamSentChars = 0;
        const thinkingTitlesSent = new Set<string>();

        const queueThinkingTitle = (title: string): void => {
          const normalized = title.replace(/\s+/g, " ").trim();
          if (!normalized) {
            return;
          }

          const clipped = truncateInline(normalized, 180);
          if (thinkingTitlesSent.has(clipped)) {
            return;
          }

          thinkingTitlesSent.add(clipped);
          queueStreamPreview(clipped);
          const now = Date.now();
          lastStreamSentPhase = latestStreamPhase;
          lastStreamSentAt = now;
          lastStreamSentChars = streamText.length;
        };

        const maybeSendStreamUpdate = (force: boolean): void => {
          if (!streamPreviewEnabled) {
            return;
          }

          if (autoProject.verbosity === "thinking") {
            if (force && thinkingTitlesSent.size === 0 && /\S/.test(streamReasoningText)) {
              const fallbackTitle = streamReasoningText
                .replace(/\r\n/g, "\n")
                .split(/\n{2,}/)[0]
                ?.split("\n")[0]
                ?.trim();
              if (fallbackTitle) {
                queueThinkingTitle(fallbackTitle);
              }
            }
            return;
          }

          const now = Date.now();
          const grownChars = streamText.length - lastStreamSentChars;
          if (!force) {
            if (grownChars < AUTO_OPENCODE_STREAM_UPDATE_MIN_CHARS) {
              return;
            }
            if (now - lastStreamSentAt < AUTO_OPENCODE_STREAM_UPDATE_MIN_INTERVAL_MS) {
              return;
            }
          } else if (grownChars <= 0) {
            return;
          }

          if (autoProject.verbosity === "thinking-complete") {
            const delta = formatThinkingStreamDelta(streamText, lastStreamSentChars);
            if (!delta.trim()) {
              lastStreamSentPhase = latestStreamPhase;
              lastStreamSentAt = now;
              lastStreamSentChars = streamText.length;
              return;
            }
            queueStreamPreview(delta);
          } else {
            const preview = streamText
              .slice(Math.max(0, streamText.length - AUTO_OPENCODE_STREAM_PREVIEW_MAX_CHARS))
              .replace(/\s+/g, " ")
              .trim();

            if (!preview) {
              return;
            }

            const previewMessage = truncateInline(preview, 280);
            const phase = `${latestStreamPhase}: ${previewMessage}`;
            queueStatus(phase, "stream");
          }
          lastStreamSentPhase = latestStreamPhase;
          lastStreamSentAt = now;
          lastStreamSentChars = streamText.length;
        };

        let reply = "";
        try {
          reply = await runAutoOpenCodePrompt(
            context,
            autoProject,
            {
              onStreamPhase: (phase: string) => {
                latestStreamPhase = phase;
                if (!streamPhaseEventsEnabled) {
                  return;
                }

                const now = Date.now();
                if (
                  phase !== lastStreamSentPhase &&
                  now - lastStreamSentAt >= AUTO_OPENCODE_STREAM_UPDATE_MIN_INTERVAL_MS
                ) {
                  queueStatus(`stream:${phase}`, "stream");
                  lastStreamSentPhase = phase;
                  lastStreamSentAt = now;
                }
              },
              onStreamText: (text: string, isReasoning: boolean) => {
                streamText = appendStreamText(streamText, text);
                if (isReasoning) {
                  streamReasoningText = appendStreamText(streamReasoningText, text);
                }
                maybeSendStreamUpdate(false);
              },
              onThinkingTitle: (title: string) => {
                if (autoProject.verbosity !== "thinking") {
                  return;
                }
                queueThinkingTitle(title);
              },
            },
          );
          maybeSendStreamUpdate(true);
        } finally {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
          }
          if (statusPromises.size > 0) {
            await Promise.allSettled([...statusPromises]);
          }
        }

        const finalText = truncateText(reply, AUTO_OPENCODE_MAX_CONTEXT_CHARS);
        const suppressFinalOutput = autoProject.verbosity === "thinking-complete" &&
          streamPreviewEnabled &&
          /\S/.test(streamText);
        const outbound = suppressFinalOutput
          ? null
          : await enqueueAutoOpenCodeMessage(
            autoOpenCodeRedis,
            autoProject,
            finalText,
            "markdown",
          );

        if (debugStatusEnabled) {
          await enqueueAutoOpenCodeStatus(
            autoOpenCodeRedis,
            autoProject,
            autoProject.progressTemplate,
            "finalizing",
            jobId,
            sender,
          );
        }

        await appendTurnLog(
          paths.outboxLogPath,
          new Date().toISOString(),
          autoProject.agent,
          finalText,
        );

        const durationMs = Date.now() - startedAt;
        recordProcessingLatency("auto_opencode_job", durationMs);
        logEvent("info", "auto_opencode.job.completed", {
          projectKey: autoProject.projectKey,
          queue: poppedQueue,
          sender,
          jobId,
          durationMs,
          agentQueue,
          queuedUserEventId: envelope.id,
          ackEventId: ack?.id ?? null,
          queuedAgentEventId: outbound?.id ?? null,
          suppressedFinalOutput: suppressFinalOutput,
        });
      } catch (error: unknown) {
        const detail =
          error instanceof Error ? error.message : "auto-opencode command failed";
        const durationMs = Date.now() - startedAt;
        recordFailure("auto_opencode_job", autoProject.projectKey);
        recordProcessingLatency("auto_opencode_job", durationMs);

        const failureBody = `OpenCode job ${jobId} failed: ${detail}`;
        const outbound = await enqueueAutoOpenCodeMessage(
          autoOpenCodeRedis,
          autoProject,
          failureBody,
          "plain",
        );
        logEvent("error", "auto_opencode.job.failed", {
          projectKey: autoProject.projectKey,
          queue: poppedQueue,
          sender,
          jobId,
          durationMs,
          agentQueue,
          queuedUserEventId: envelope.id,
          queuedAgentEventId: outbound.id,
          error: detail,
        });
      }
    } catch (error: unknown) {
      const detail =
        error instanceof Error ? error.message : "auto-opencode worker loop failed";
      recordFailure("auto_opencode_worker_loop", autoProject.projectKey);
      logEvent("error", "auto_opencode.worker.loop_error", {
        projectKey: autoProject.projectKey,
        queue: userQueue,
        error: detail,
      });
      await Bun.sleep(1000);
    }
  }
}

async function runAutoOpenCodeProjectSupervisor(
  redisConfig: RedisConfig,
  userQueue: string,
  autoProject: AutoOpenCodeProject,
  workerClients: Set<Redis>,
): Promise<never> {
  let crashCount = 0;

  while (true) {
    let workerRedis: Redis | null = null;
    try {
      workerRedis = await createRedisClient(redisConfig);
      workerClients.add(workerRedis);
      crashCount = 0;
      await runAutoOpenCodeProjectWorker(workerRedis, userQueue, autoProject);
    } catch (error: unknown) {
      crashCount += 1;
      const detail =
        error instanceof Error ? error.message : "auto-opencode worker crashed";
      recordWorkerRestart(autoProject.projectKey);
      recordFailure("auto_opencode_worker_crash", autoProject.projectKey);
      const backoffMs = Math.min(
        AUTO_OPENCODE_WORKER_RESTART_MAX_DELAY_MS,
        AUTO_OPENCODE_WORKER_RESTART_BASE_DELAY_MS *
          2 ** Math.min(crashCount - 1, 5),
      );
      logEvent("error", "auto_opencode.worker.crashed", {
        projectKey: autoProject.projectKey,
        queue: userQueue,
        error: detail,
        restartInMs: backoffMs,
        crashCount,
      });
      await Bun.sleep(backoffMs);
    } finally {
      if (workerRedis) {
        workerClients.delete(workerRedis);
        workerRedis.close();
      }
    }
  }
}

async function runInboundLoop(
  inboundRedis: Redis,
  roomToProject: Map<string, string>,
  adminUserIds: Set<string>,
  botUserId?: string,
  managementRoomId?: string,
): Promise<never> {
  let since = nonEmptyText(await inboundRedis.get(SYNC_TOKEN_KEY)) ?? undefined;

  if (!since) {
    try {
      const syncStartedAt = Date.now();
      const bootstrap = await syncMatrix(undefined, 0);
      const next = nonEmptyText(bootstrap.next_batch);
      if (next) {
        since = next;
        await inboundRedis.set(SYNC_TOKEN_KEY, next);
      }
      const durationMs = Date.now() - syncStartedAt;
      recordProcessingLatency("inbound_sync", durationMs);
      logEvent("info", "inbound.sync.bootstrap.initialized", {
        durationMs,
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      recordFailure("inbound_sync_bootstrap");
      logEvent("error", "inbound.sync.bootstrap.failed", {
        error: detail,
      });
      await Bun.sleep(1000);
    }
  }

  while (true) {
    try {
      const syncStartedAt = Date.now();
      const syncResponse = await syncMatrix(since, 30000);
      recordProcessingLatency("inbound_sync", Date.now() - syncStartedAt);
      const next = nonEmptyText(syncResponse.next_batch);
      if (next) {
        since = next;
        await inboundRedis.set(SYNC_TOKEN_KEY, next);
      }

      const invitedRooms = syncResponse.rooms?.invite ?? {};
      for (const roomId of Object.keys(invitedRooms)) {
        const projectKey = roomToProject.get(roomId);
        const isManagementRoom = managementRoomId && roomId === managementRoomId;

        try {
          const joinedRoomId = await joinMatrixRoom(roomId);
          if (projectKey) {
            logEvent("info", "inbound.room.auto_joined", {
              projectKey,
              roomId: joinedRoomId ?? roomId,
            });
          } else if (isManagementRoom) {
            logEvent("info", "inbound.room.management_joined", {
              roomId: joinedRoomId ?? roomId,
            });
          } else {
            logEvent("info", "inbound.room.unconfigured_joined", {
              roomId: joinedRoomId ?? roomId,
            });
          }
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error);
          if (projectKey) {
            recordFailure("inbound_auto_join", projectKey);
            logEvent("error", "inbound.room.auto_join_failed", {
              projectKey,
              error: detail,
              roomId,
            });
          } else {
            logEvent("error", "inbound.room.unconfigured_join_failed", {
              error: detail,
              roomId,
            });
          }
        }
      }

      const joinedRooms = syncResponse.rooms?.join ?? {};
      for (const [roomId, roomState] of Object.entries(joinedRooms)) {
        const projectKey = roomToProject.get(roomId);

        const isManagementRoom = managementRoomId && roomId === managementRoomId;

        const events = roomState.timeline?.events;
        if (!Array.isArray(events)) {
          continue;
        }

        for (const rawEvent of events) {
          const event = rawEvent as MatrixTimelineEvent;

          if (isManagementRoom) {
            const sender = nonEmptyText(event.sender);
            if (!sender) continue;
            if (botUserId && sender === botUserId) continue;
            if (adminUserIds.size > 0 && !adminUserIds.has(sender)) continue;

            if (typeof event.content !== "object" || event.content === null) continue;
            const content = event.content as Record<string, unknown>;
            const body = nonEmptyText(content.body);
            if (!body) continue;
            if (content["m.relates_to"] !== undefined) continue;

            const trimmed = body.trim();
            if (trimmed.startsWith("!help")) {
              let response: string;
              try {
                response = generalHelp("!oc");
              } catch (error: unknown) {
                const detail = error instanceof Error ? error.message : String(error);
                response = `Error: ${detail}`;
              }

              try {
                await sendToRoom(
                  roomId,
                  buildMatrixContent({ body: response, format: "markdown" }),
                );
                logEvent("info", "help.command.executed", {
                  roomId,
                  sender,
                });
              } catch (error: unknown) {
                const detail = error instanceof Error ? error.message : String(error);
                logEvent("error", "help.command.response_failed", {
                  roomId,
                  sender,
                  error: detail,
                });
              }
              continue;
            }

            if (!trimmed.startsWith("!project")) continue;

            const tokens = splitCommandTokens(trimmed.slice("!project".length).trim());
            let response: string;
            try {
              const parsed = parseManagementCommandArgs(tokens);
              response = await executeManagementCommand(parsed, projects);
            } catch (error: unknown) {
              const detail = error instanceof Error ? error.message : String(error);
              response = `Error: ${detail}`;
            }

            try {
              await sendToRoom(
                roomId,
                buildMatrixContent({ body: response, format: "markdown" }),
              );
              logEvent("info", "management.command.executed", {
                roomId,
                sender,
                command: tokens[0] ?? "unknown",
              });
            } catch (error: unknown) {
              const detail = error instanceof Error ? error.message : String(error);
              logEvent("error", "management.command.response_failed", {
                roomId,
                sender,
                error: detail,
              });
            }
            continue;
          }

          const content = event.content as Record<string, unknown>;
          const body = nonEmptyText(content.body);
          if (!body) continue;
          if (content["m.relates_to"] !== undefined) continue;

          const trimmed = body.trim();
          if (trimmed.startsWith("!help")) {
            let response: string;
            try {
              response = generalHelp("!oc");
            } catch (error: unknown) {
              const detail = error instanceof Error ? error.message : String(error);
              response = `Error: ${detail}`;
            }

            try {
              await sendToRoom(
                roomId,
                buildMatrixContent({ body: response, format: "markdown" }),
              );
              logEvent("info", "help.command.executed", {
                roomId,
                projectKey: projectKey ?? null,
              });
            } catch (error: unknown) {
              const detail = error instanceof Error ? error.message : String(error);
              logEvent("error", "help.command.response_failed", {
                roomId,
                projectKey: projectKey ?? null,
                error: detail,
              });
            }
            continue;
          }

          if (!projectKey) {
            const sender = nonEmptyText(event.sender);
            if (!sender) continue;
            if (botUserId && sender === botUserId) continue;

            const content = event.content as Record<string, unknown>;
            const body = nonEmptyText(content.body);
            if (!body) continue;
            if (content["m.relates_to"] !== undefined) continue;

            try {
              await sendToRoom(
                roomId,
                buildMatrixContent({ body: "There is no project configured for this channel. Please configure a project using the management room.", format: "plain" }),
              );
              logEvent("info", "inbound.room.unconfigured_message_response", {
                roomId,
                sender,
              });
            } catch (error: unknown) {
              const detail = error instanceof Error ? error.message : String(error);
              logEvent("error", "inbound.room.unconfigured_message_failed", {
                roomId,
                sender,
                error: detail,
              });
            }
            continue;
          }

          const envelope = toUserQueueEnvelope(
            event,
            projectKey,
            roomId,
            adminUserIds,
            botUserId,
          );

          if (!envelope) {
            continue;
          }

          const key = queueKey(projectKey, "user");
          const enqueueStartedAt = Date.now();
          const queueLength = await inboundRedis.rpush(key, JSON.stringify(envelope));
          const durationMs = Date.now() - enqueueStartedAt;
          recordProcessingLatency("inbound_enqueue", durationMs);
          logEvent("info", "inbound.message.enqueued", {
            projectKey,
            queue: key,
            sender: envelope.sender ?? null,
            durationMs,
            roomId,
            eventId: envelope.id,
            queueLength,
          });
        }
      }
    } catch (error: unknown) {
      const detail =
        error instanceof Error ? error.message : "matrix sync failed";
      recordFailure("inbound_sync");
      logEvent("error", "inbound.loop.error", {
        error: detail,
      });
      await Bun.sleep(1000);
    }
  }
}

async function startHttpFacade(
  apiRedis: Redis,
  authTokens: Set<string>,
  port: number,
) {
  return Bun.serve({
    port,
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method.toUpperCase();

      if ((path === "/health" || path === "/v1/health") && method === "GET") {
        return json(200, {
          ok: true,
          service: "matrix-relay-core",
          authConfigured: authTokens.size > 0,
        });
      }

      if (path === "/v1/metrics" && method === "GET") {
        return handleMetrics(apiRedis);
      }

      if (path === "/v1/agent/poll" && method === "POST") {
        return handleAgentPoll(req, apiRedis, authTokens);
      }

      if (path === "/v1/agent/send" && method === "POST") {
        return handleAgentSend(req, apiRedis, authTokens);
      }

      return json(404, { error: "not found" });
    },
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
  const roomToProject = buildRoomToProjectMap();
  const queueToProject = new Map<string, string>();
  for (const [projectKey] of Object.entries(projects)) {
    queueToProject.set(queueKey(projectKey, "agent"), projectKey);
  }
  const autoOpenCodeQueueToProject = buildAutoOpenCodeMap();
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

  const botUserId = await fetchBotUserId();
  const authTokens = parseAgentApiTokens(cfg);

  const outboundRedis = await createRedisClient(redisConfig);
  const inboundRedis = await createRedisClient(redisConfig);
  const apiRedis = await createRedisClient(redisConfig);
  const autoOpenCodeWorkerClients = new Set<Redis>();

  const port = resolvePort();
  const server = await startHttpFacade(apiRedis, authTokens, port);

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

  runOutboundLoop(outboundRedis, queueToProject).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    recordFailure("outbound_loop_fatal");
    logEvent("error", "outbound.loop.fatal", {
      error: detail,
    });
  });

  runInboundLoop(
    inboundRedis,
    roomToProject,
    adminUserIds,
    botUserId,
    cfg.managementRoomId,
  ).catch(
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      recordFailure("inbound_loop_fatal");
      logEvent("error", "inbound.loop.fatal", {
        error: detail,
      });
    },
  );

  for (const [userQueue, autoProject] of autoOpenCodeQueueToProject.entries()) {
    runAutoOpenCodeProjectSupervisor(
      redisConfig,
      userQueue,
      autoProject,
      autoOpenCodeWorkerClients,
    ).catch(
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
