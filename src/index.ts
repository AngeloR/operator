import config from "../config.json";
import Redis from "ioredis";
import { marked } from "marked";
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

type ProjectConfig = {
  roomId: string;
  prefix?: string;
  autoCodex?: boolean;
  autoCodexAgent?: string;
  autoCodexCommand?: string[];
  autoCodexTimeoutSeconds?: number;
  autoCodexHeartbeatSeconds?: number;
  autoCodexVerbosity?: string;
  autoCodexDebug?: boolean;
  autoCodexProgressUpdates?: boolean;
  autoCodexStateDir?: string;
  autoCodexCwd?: string;
  autoCodexSenderAllowlist?: string[];
  autoCodexAckTemplate?: string;
  autoCodexProgressTemplate?: string;
  autoCodexContextTailLines?: number;
};

type AppConfig = {
  homeserverUrl: string;
  accessToken: string;
  port?: number;
  projects: Record<string, ProjectConfig>;
  adminUserIds?: string[];
  agentApiToken?: string;
  agentApiTokens?: string[];
  redisUrl?: string;
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
  redisDb?: number;
};

type MessageFormat = "markdown" | "plain";
type QueueDirection = "agent" | "user";
type AutoCodexVerbosity = "debug" | "thinking" | "output";

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

type AutoCodexProject = {
  projectKey: string;
  roomId: string;
  agent: string;
  command: string[];
  timeoutMs: number | null;
  heartbeatMs: number;
  verbosity: AutoCodexVerbosity;
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

type PreparedAutoCodexCommand = {
  command: string[];
  outputLastMessagePath: string | null;
  cleanupOutputLastMessagePath: boolean;
  jsonStreamEnabled: boolean;
};

type AutoCodexStatePaths = {
  rootDir: string;
  inboxLogPath: string;
  outboxLogPath: string;
  rollingSummaryPath: string;
  currentContextPath: string;
};

type AutoCodexStreamHandlers = {
  onStreamPhase?: (phase: string) => void;
  onStreamText?: (text: string) => void;
};

type LogLevel = "info" | "warn" | "error";

type LogContext = {
  projectKey?: string | null;
  jobId?: string | null;
  queue?: string | null;
  sender?: string | null;
  durationMs?: number | null;
  [key: string]: unknown;
};

type LatencyAccumulator = {
  count: number;
  sumMs: number;
  minMs: number | null;
  maxMs: number | null;
  samplesMs: number[];
};

type MetricsState = {
  workerRestarts: {
    total: number;
    byProject: Map<string, number>;
  };
  failures: {
    total: number;
    byCategory: Map<string, number>;
    byProject: Map<string, number>;
  };
  processingLatency: {
    overall: LatencyAccumulator;
    byOperation: Map<string, LatencyAccumulator>;
  };
};

const cfg = config as AppConfig;
const projects = cfg.projects ?? {};
const SYNC_TOKEN_KEY = "matrix-agent:sync:next-batch:v1";
const DEFAULT_AUTO_CODEX_COMMAND = ["codex", "exec", "--skip-git-repo-check"];
const DEFAULT_AUTO_CODEX_TIMEOUT_SECONDS = 300;
const DEFAULT_AUTO_CODEX_HEARTBEAT_SECONDS = 45;
const AUTO_CODEX_INFINITE_TIMEOUT_HEARTBEAT_MS = 15 * 60 * 1000;
const DEFAULT_AUTO_CODEX_VERBOSITY: AutoCodexVerbosity = "output";
const DEFAULT_AUTO_CODEX_PROGRESS_UPDATES = true;
const DEFAULT_AUTO_CODEX_STATE_DIR = ".matrix-agent-state";
const DEFAULT_AUTO_CODEX_ACK_TEMPLATE =
  "Received your message. Starting Codex job {{job_id}}.";
const DEFAULT_AUTO_CODEX_PROGRESS_TEMPLATE = "Codex {{phase}} (job {{job_id}}).";
const DEFAULT_AUTO_CODEX_CONTEXT_TAIL_LINES = 60;
const AUTO_CODEX_MAX_MESSAGE_CHARS = 16_000;
const AUTO_CODEX_MAX_CONTEXT_CHARS = 24_000;
const AUTO_CODEX_DEDUP_WINDOW_MS = 30 * 60 * 1000;
const AUTO_CODEX_DEDUP_MAX_IDS = 2000;
const AUTO_CODEX_STREAM_UPDATE_MIN_INTERVAL_MS = 5000;
const AUTO_CODEX_STREAM_UPDATE_MIN_CHARS = 200;
const AUTO_CODEX_STREAM_PREVIEW_MAX_CHARS = 4000;
const AUTO_CODEX_WORKER_RESTART_BASE_DELAY_MS = 1000;
const AUTO_CODEX_WORKER_RESTART_MAX_DELAY_MS = 30_000;
const COMMAND_OUTPUT_CAPTURE_LIMIT_CHARS = 200_000;
const THINKING_LEADING_STATUS_PATTERN = /^\s*(?:\*\*)?thinking(?:\.{3}|…)(?:\*\*)?(?:\s*\n+|\s+)/i;
const THINKING_INLINE_TITLE_PATTERN = /(^|\n)(\*\*[^*\n]+\*\*)(?=[\p{L}\p{N}"'“‘(])/gu;
const THINKING_TITLE_CONTINUATION_START_PATTERN = /^[\p{L}\p{N}"'“‘(]/u;
const METRICS_LATENCY_SAMPLE_LIMIT = 2000;

function createLatencyAccumulator(): LatencyAccumulator {
  return {
    count: 0,
    sumMs: 0,
    minMs: null,
    maxMs: null,
    samplesMs: [],
  };
}

const metricsState: MetricsState = {
  workerRestarts: {
    total: 0,
    byProject: new Map<string, number>(),
  },
  failures: {
    total: 0,
    byCategory: new Map<string, number>(),
    byProject: new Map<string, number>(),
  },
  processingLatency: {
    overall: createLatencyAccumulator(),
    byOperation: new Map<string, LatencyAccumulator>(),
  },
};

function incrementCounter(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function mapToRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function logEvent(level: LogLevel, event: string, context: LogContext = {}): void {
  const payload: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    event,
    projectKey: context.projectKey ?? null,
    jobId: context.jobId ?? null,
    queue: context.queue ?? null,
    sender: context.sender ?? null,
    durationMs: context.durationMs ?? null,
  };

  for (const [key, value] of Object.entries(context)) {
    if (key in payload) {
      continue;
    }
    payload[key] = value;
  }

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

function recordFailure(category: string, projectKey?: string): void {
  metricsState.failures.total += 1;
  incrementCounter(metricsState.failures.byCategory, category);
  incrementCounter(metricsState.failures.byProject, projectKey ?? "global");
}

function recordWorkerRestart(projectKey: string): void {
  metricsState.workerRestarts.total += 1;
  incrementCounter(metricsState.workerRestarts.byProject, projectKey);
}

function recordLatencySample(accumulator: LatencyAccumulator, durationMs: number): void {
  const normalized = Math.max(0, Math.round(durationMs));
  accumulator.count += 1;
  accumulator.sumMs += normalized;
  accumulator.minMs = accumulator.minMs === null
    ? normalized
    : Math.min(accumulator.minMs, normalized);
  accumulator.maxMs = accumulator.maxMs === null
    ? normalized
    : Math.max(accumulator.maxMs, normalized);

  accumulator.samplesMs.push(normalized);
  if (accumulator.samplesMs.length > METRICS_LATENCY_SAMPLE_LIMIT) {
    accumulator.samplesMs.shift();
  }
}

function recordProcessingLatency(operation: string, durationMs: number): void {
  recordLatencySample(metricsState.processingLatency.overall, durationMs);

  let perOperation = metricsState.processingLatency.byOperation.get(operation);
  if (!perOperation) {
    perOperation = createLatencyAccumulator();
    metricsState.processingLatency.byOperation.set(operation, perOperation);
  }

  recordLatencySample(perOperation, durationMs);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }

  const index = Math.ceil((p / 100) * sorted.length) - 1;
  const bounded = Math.max(0, Math.min(sorted.length - 1, index));
  return sorted[bounded] ?? null;
}

function snapshotLatency(accumulator: LatencyAccumulator): Record<string, number | null> {
  if (accumulator.count === 0) {
    return {
      count: 0,
      sumMs: 0,
      minMs: null,
      maxMs: null,
      avgMs: null,
      p50Ms: null,
      p95Ms: null,
      sampleCount: 0,
    };
  }

  const sorted = [...accumulator.samplesMs].sort((a, b) => a - b);
  return {
    count: accumulator.count,
    sumMs: accumulator.sumMs,
    minMs: accumulator.minMs,
    maxMs: accumulator.maxMs,
    avgMs: Number((accumulator.sumMs / accumulator.count).toFixed(2)),
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    sampleCount: accumulator.samplesMs.length,
  };
}

async function collectQueueDepth(redis: Redis): Promise<{
  total: number;
  byQueue: Record<string, number>;
  byProject: Record<string, { user: number; agent: number; total: number }>;
}> {
  const byQueue: Record<string, number> = {};
  const byProject: Record<string, { user: number; agent: number; total: number }> = {};
  let total = 0;

  const projectKeys = Object.keys(projects);
  await Promise.all(
    projectKeys.map(async (projectKey) => {
      const userQueue = queueKey(projectKey, "user");
      const agentQueue = queueKey(projectKey, "agent");
      const [userDepth, agentDepth] = await Promise.all([
        redis.llen(userQueue),
        redis.llen(agentQueue),
      ]);

      byQueue[userQueue] = userDepth;
      byQueue[agentQueue] = agentDepth;
      byProject[projectKey] = {
        user: userDepth,
        agent: agentDepth,
        total: userDepth + agentDepth,
      };
    }),
  );

  for (const item of Object.values(byProject)) {
    total += item.total;
  }

  return { total, byQueue, byProject };
}

function buildMetricsSnapshot(): {
  workerRestarts: { total: number; byProject: Record<string, number> };
  failures: {
    total: number;
    byCategory: Record<string, number>;
    byProject: Record<string, number>;
  };
  processingLatency: {
    overall: Record<string, number | null>;
    byOperation: Record<string, Record<string, number | null>>;
  };
} {
  const byOperation: Record<string, Record<string, number | null>> = {};
  for (const [operation, stats] of metricsState.processingLatency.byOperation.entries()) {
    byOperation[operation] = snapshotLatency(stats);
  }

  return {
    workerRestarts: {
      total: metricsState.workerRestarts.total,
      byProject: mapToRecord(metricsState.workerRestarts.byProject),
    },
    failures: {
      total: metricsState.failures.total,
      byCategory: mapToRecord(metricsState.failures.byCategory),
      byProject: mapToRecord(metricsState.failures.byProject),
    },
    processingLatency: {
      overall: snapshotLatency(metricsState.processingLatency.overall),
      byOperation,
    },
  };
}

if (!cfg.homeserverUrl || !cfg.accessToken) {
  throw new Error("config.json must include homeserverUrl and accessToken");
}

function json(status: number, payload: unknown): Response {
  return Response.json(payload, { status });
}

function nonEmptyText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/\S/.test(value)) return null;
  return value.replace(/\r\n/g, "\n");
}

function parseFormat(value: unknown): MessageFormat {
  return value === "plain" ? "plain" : "markdown";
}

function parseAgent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseSender(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

function toPlainHtml(text: string): string {
  return Bun.escapeHTML(text).replace(/\n/g, "<br>\n");
}

function toMarkdownHtml(markdown: string): string {
  const renderer = new marked.Renderer();
  renderer.html = ({ text }) => Bun.escapeHTML(text);

  return marked(markdown, {
    async: false,
    gfm: true,
    breaks: true,
    renderer,
  });
}

function buildMatrixContent(message: ParsedMessage): MatrixMessageContent {
  return {
    msgtype: "m.text",
    body: message.body,
    format: "org.matrix.custom.html",
    formatted_body:
      message.format === "markdown"
        ? toMarkdownHtml(message.body)
        : toPlainHtml(message.body),
  };
}

function queueKey(projectKey: string, direction: QueueDirection): string {
  return `${projectKey}:${direction}`;
}

function parseAutoCodexBoolean(
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

function parseAutoCodexVerbosity(
  value: unknown,
  fallback: AutoCodexVerbosity,
): AutoCodexVerbosity {
  if (value === undefined) {
    return fallback;
  }

  const parsed = nonEmptyText(value)?.toLowerCase();
  if (!parsed) {
    throw new Error("autoCodexVerbosity must be a non-empty string");
  }

  if (parsed !== "debug" && parsed !== "thinking" && parsed !== "output") {
    throw new Error("autoCodexVerbosity must be one of: debug, thinking, output");
  }

  return parsed;
}

function parseAutoCodexString(
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

function parseAutoCodexCommand(value: unknown): string[] | null {
  if (value === undefined) {
    return null;
  }

  if (!Array.isArray(value)) {
    throw new Error("autoCodexCommand must be an array of strings");
  }

  const command = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);

  if (command.length === 0) {
    throw new Error("autoCodexCommand must include at least one token");
  }

  return command;
}

function parseAutoCodexCwd(value: unknown): string {
  if (value === undefined) {
    return process.cwd();
  }

  const parsed = nonEmptyText(value);
  if (!parsed) {
    throw new Error("autoCodexCwd must be a non-empty string");
  }

  return resolve(parsed);
}

function parseAutoCodexTimeoutSeconds(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_AUTO_CODEX_TIMEOUT_SECONDS;
  }

  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 3600) {
    throw new Error(
      "autoCodexTimeoutSeconds must be an integer between 0 and 3600 (0 disables timeout)",
    );
  }

  return n;
}

function parseAutoCodexHeartbeatSeconds(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_AUTO_CODEX_HEARTBEAT_SECONDS;
  }

  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 3600) {
    throw new Error("autoCodexHeartbeatSeconds must be an integer between 0 and 3600");
  }

  return n;
}

function parseAutoCodexContextTailLines(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_AUTO_CODEX_CONTEXT_TAIL_LINES;
  }

  const n = Number(value);
  if (!Number.isInteger(n) || n < 10 || n > 500) {
    throw new Error("autoCodexContextTailLines must be an integer between 10 and 500");
  }

  return n;
}

function parseAutoCodexSenderAllowlist(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    throw new Error("autoCodexSenderAllowlist must be an array of user IDs");
  }

  const ids = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);

  if (ids.length === 0) {
    throw new Error("autoCodexSenderAllowlist must include at least one user ID");
  }

  return new Set(ids);
}

function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) =>
    vars[key] ?? "",
  );
}

function truncateText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }

  const keep = Math.max(maxChars - 24, 0);
  return `${input.slice(0, keep)}\n\n[truncated]`;
}

function tailLines(input: string, lineCount: number): string {
  if (!input) {
    return "";
  }

  const lines = input.replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= lineCount) {
    return input;
  }

  return lines.slice(lines.length - lineCount).join("\n");
}

function appendCapturedOutput(current: string, chunk: string): string {
  if (!chunk) {
    return current;
  }

  const next = current + chunk;
  if (next.length <= COMMAND_OUTPUT_CAPTURE_LIMIT_CHARS) {
    return next;
  }

  return next.slice(next.length - COMMAND_OUTPUT_CAPTURE_LIMIT_CHARS);
}

function truncateInline(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }

  if (maxChars <= 3) {
    return input.slice(0, maxChars);
  }

  return `${input.slice(0, maxChars - 3)}...`;
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

function readCommandOptionValue(
  command: string[],
  longName: string,
  shortName?: string,
): string | null {
  for (let i = 0; i < command.length; i += 1) {
    const token = command[i];
    if (!token) {
      continue;
    }

    const longPrefix = `--${longName}=`;
    if (token.startsWith(longPrefix)) {
      return token.slice(longPrefix.length);
    }

    if (token === `--${longName}`) {
      const next = command[i + 1];
      return typeof next === "string" ? next : null;
    }

    if (shortName) {
      const shortPrefix = `-${shortName}=`;
      if (token.startsWith(shortPrefix)) {
        return token.slice(shortPrefix.length);
      }
      if (token === `-${shortName}`) {
        const next = command[i + 1];
        return typeof next === "string" ? next : null;
      }
    }
  }

  return null;
}

function isCodexExecCommand(command: string[]): boolean {
  const executable = command[0];
  if (!executable) {
    return false;
  }

  const fileName = basename(executable).toLowerCase();
  if (fileName !== "codex" && fileName !== "codex.exe") {
    return false;
  }

  return command.some((token) => token === "exec" || token === "e");
}

function prepareAutoCodexCommand(
  command: string[],
  cwd: string,
  defaultOutputLastMessagePath: string,
): PreparedAutoCodexCommand {
  const prepared: PreparedAutoCodexCommand = {
    command: [...command],
    outputLastMessagePath: null,
    cleanupOutputLastMessagePath: false,
    jsonStreamEnabled: false,
  };

  if (!isCodexExecCommand(command)) {
    return prepared;
  }

  prepared.jsonStreamEnabled = true;
  if (!commandHasOption(prepared.command, "json")) {
    prepared.command.push("--json");
  }

  const configuredPath = readCommandOptionValue(
    prepared.command,
    "output-last-message",
    "o",
  );
  if (configuredPath) {
    prepared.outputLastMessagePath = resolve(cwd, configuredPath);
  } else {
    prepared.outputLastMessagePath = defaultOutputLastMessagePath;
    prepared.cleanupOutputLastMessagePath = true;
    prepared.command.push("--output-last-message", defaultOutputLastMessagePath);
  }

  return prepared;
}

function findSuffixPrefixOverlap(left: string, right: string): number {
  const max = Math.min(left.length, right.length, 4096);
  for (let len = max; len > 0; len -= 1) {
    if (left.slice(left.length - len) === right.slice(0, len)) {
      return len;
    }
  }
  return 0;
}

function appendStreamText(current: string, chunk: string): string {
  const normalized = chunk.replace(/\r\n/g, "\n");
  if (!normalized) {
    return current;
  }

  if (!current) {
    return appendCapturedOutput("", normalized);
  }

  if (current.endsWith(normalized)) {
    return current;
  }

  const overlap = findSuffixPrefixOverlap(current, normalized);
  const next = current + normalized.slice(overlap);
  if (next.length <= COMMAND_OUTPUT_CAPTURE_LIMIT_CHARS) {
    return next;
  }
  return next.slice(next.length - COMMAND_OUTPUT_CAPTURE_LIMIT_CHARS);
}

function formatThinkingStreamDelta(
  streamText: string,
  lastStreamSentChars: number,
): string {
  let delta = streamText.slice(lastStreamSentChars).replace(/\r\n/g, "\n");
  if (!delta) {
    return delta;
  }

  if (lastStreamSentChars === 0) {
    delta = delta.replace(THINKING_LEADING_STATUS_PATTERN, "");
  }

  if (
    lastStreamSentChars > 0 &&
    streamText.slice(Math.max(0, lastStreamSentChars - 2), lastStreamSentChars).endsWith("**") &&
    THINKING_TITLE_CONTINUATION_START_PATTERN.test(delta)
  ) {
    delta = `\n\n${delta}`;
  }

  return delta.replace(THINKING_INLINE_TITLE_PATTERN, "$1$2\n\n");
}

function tryDecodeJsonMessageText(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const startsLikeJson = trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith('"');
  if (!startsLikeJson) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }

  if (typeof payload === "string") {
    return nonEmptyText(payload);
  }

  return extractStreamText(payload);
}

function extractJsonLinesText(output: string): string | null {
  const normalized = output.replace(/\r\n/g, "\n");
  if (!normalized) {
    return null;
  }

  let combined = "";
  for (const line of normalized.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }

    const text = extractStreamText(payload);
    if (text) {
      combined = appendStreamText(combined, text);
    }
  }

  if (combined) {
    return combined;
  }

  return tryDecodeJsonMessageText(normalized);
}

function extractStreamText(value: unknown, depth = 0): string | null {
  if (depth > 6) {
    return null;
  }

  if (typeof value === "string") {
    const parsed = nonEmptyText(value);
    return parsed;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractStreamText(item, depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof value !== "object" || value === null) {
    return null;
  }

  const obj = value as Record<string, unknown>;
  const primaryKeys = ["delta", "text", "output_text", "markdown", "body", "message"];
  for (const key of primaryKeys) {
    const found = extractStreamText(obj[key], depth + 1);
    if (found) {
      return found;
    }
  }

  const containerKeys = [
    "content",
    "item",
    "data",
    "event",
    "response",
    "output",
    "choices",
    "result",
    "messages",
  ];
  for (const key of containerKeys) {
    const found = extractStreamText(obj[key], depth + 1);
    if (found) {
      return found;
    }
  }

  return null;
}

function buildAutoCodexMap(): Map<string, AutoCodexProject> {
  const map = new Map<string, AutoCodexProject>();

  for (const [projectKey, project] of Object.entries(projects)) {
    if (project.autoCodex !== true) {
      continue;
    }

    const roomId = nonEmptyText(project.roomId);
    if (!roomId) {
      throw new Error(`project "${projectKey}" has autoCodex enabled but no roomId`);
    }

    const command = parseAutoCodexCommand(project.autoCodexCommand) ??
      DEFAULT_AUTO_CODEX_COMMAND;
    const timeoutSeconds = parseAutoCodexTimeoutSeconds(
      project.autoCodexTimeoutSeconds,
    );
    const heartbeatSeconds = parseAutoCodexHeartbeatSeconds(
      project.autoCodexHeartbeatSeconds,
    );
    const verbosity = project.autoCodexVerbosity !== undefined
      ? parseAutoCodexVerbosity(
        project.autoCodexVerbosity,
        DEFAULT_AUTO_CODEX_VERBOSITY,
      )
      : project.autoCodexDebug !== undefined
      ? parseAutoCodexBoolean(
        project.autoCodexDebug,
        false,
        "autoCodexDebug",
      )
        ? "debug"
        : DEFAULT_AUTO_CODEX_VERBOSITY
      : DEFAULT_AUTO_CODEX_VERBOSITY;
    const progressUpdates = parseAutoCodexBoolean(
      project.autoCodexProgressUpdates,
      DEFAULT_AUTO_CODEX_PROGRESS_UPDATES,
      "autoCodexProgressUpdates",
    );
    const stateDir = parseAutoCodexString(
      project.autoCodexStateDir,
      DEFAULT_AUTO_CODEX_STATE_DIR,
      "autoCodexStateDir",
    );
    const cwd = parseAutoCodexCwd(project.autoCodexCwd);
    const senderAllowlist = parseAutoCodexSenderAllowlist(
      project.autoCodexSenderAllowlist,
    );
    const ackTemplate = parseAutoCodexString(
      project.autoCodexAckTemplate,
      DEFAULT_AUTO_CODEX_ACK_TEMPLATE,
      "autoCodexAckTemplate",
    );
    const progressTemplate = parseAutoCodexString(
      project.autoCodexProgressTemplate,
      DEFAULT_AUTO_CODEX_PROGRESS_TEMPLATE,
      "autoCodexProgressTemplate",
    );
    const contextTailLines = parseAutoCodexContextTailLines(
      project.autoCodexContextTailLines,
    );

    const queue = queueKey(projectKey, "user");
    const autoProject: AutoCodexProject = {
      projectKey,
      roomId,
      agent:
        nonEmptyText(project.autoCodexAgent) ??
        nonEmptyText(project.prefix) ??
        "codex",
      command,
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

async function validateAutoCodexProjects(
  projectsByQueue: Map<string, AutoCodexProject>,
): Promise<void> {
  for (const autoProject of projectsByQueue.values()) {
    let entry;
    try {
      entry = await stat(autoProject.cwd);
    } catch {
      throw new Error(
        `project "${autoProject.projectKey}" has invalid autoCodexCwd: directory not found (${autoProject.cwd})`,
      );
    }

    if (!entry.isDirectory()) {
      throw new Error(
        `project "${autoProject.projectKey}" has invalid autoCodexCwd: not a directory (${autoProject.cwd})`,
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
  const redis = new Redis({
    host: redisConfig.host,
    port: redisConfig.port,
    db: redisConfig.db,
    password: redisConfig.password,
    connectTimeout: redisConfig.connectTimeoutMs,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });

  redis.on("error", () => {});

  try {
    await redis.connect();
    return redis;
  } catch (error: unknown) {
    redis.disconnect(false);
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
    agent: parseAgent(obj.agent),
    sender: parseSender(obj.sender),
    receivedAt: candidateReceivedAt ?? new Date().toISOString(),
  };
}

async function matrixGet<T>(
  path: string,
  query: Record<string, string | undefined>,
): Promise<T> {
  const url = new URL(path, cfg.homeserverUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
    },
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const err = payload as { errcode?: unknown; error?: unknown };
    const errcode =
      typeof err?.errcode === "string" ? err.errcode : "M_UNKNOWN";
    const detail =
      typeof err?.error === "string"
        ? err.error
        : `HTTP ${response.status} ${response.statusText}`;
    throw new Error(`${errcode}: ${detail}`);
  }

  return payload as T;
}

async function matrixPost<T>(path: string, payload: unknown): Promise<T> {
  const url = new URL(path, cfg.homeserverUrl);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const err = data as { errcode?: unknown; error?: unknown };
    const errcode =
      typeof err?.errcode === "string" ? err.errcode : "M_UNKNOWN";
    const detail =
      typeof err?.error === "string"
        ? err.error
        : `HTTP ${response.status} ${response.statusText}`;
    throw new Error(`${errcode}: ${detail}`);
  }

  return data as T;
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
  const url = new URL(path, cfg.homeserverUrl);

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(content),
  });

  let payload: { event_id?: unknown; errcode?: unknown; error?: unknown } = {};
  try {
    payload = (await response.json()) as {
      event_id?: unknown;
      errcode?: unknown;
      error?: unknown;
    };
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const errcode =
      typeof payload.errcode === "string" ? payload.errcode : "M_UNKNOWN";
    const error =
      typeof payload.error === "string"
        ? payload.error
        : "Matrix request failed";
    throw new Error(`${errcode}: ${error}`);
  }

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

function resolveAutoCodexStatePaths(autoProject: AutoCodexProject): AutoCodexStatePaths {
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

async function ensureAutoCodexState(autoProject: AutoCodexProject): Promise<AutoCodexStatePaths> {
  const paths = resolveAutoCodexStatePaths(autoProject);
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
  paths: AutoCodexStatePaths,
  autoProject: AutoCodexProject,
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

  const truncated = truncateText(summary, AUTO_CODEX_MAX_CONTEXT_CHARS);
  await writeFile(paths.rollingSummaryPath, truncated, "utf8");
  return truncated;
}

function buildCurrentContext(
  envelope: QueueEnvelope,
  summary: string,
  jobId: string,
): string {
  const userBody = truncateText(envelope.body, AUTO_CODEX_MAX_MESSAGE_CHARS);
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
    AUTO_CODEX_MAX_CONTEXT_CHARS,
  );
}

async function prepareAutoCodexContext(
  envelope: QueueEnvelope,
  autoProject: AutoCodexProject,
  jobId: string,
): Promise<{ paths: AutoCodexStatePaths; context: string }> {
  const paths = await ensureAutoCodexState(autoProject);
  await appendTurnLog(
    paths.inboxLogPath,
    envelope.receivedAt,
    envelope.sender ?? "unknown",
    truncateText(envelope.body, AUTO_CODEX_MAX_MESSAGE_CHARS),
  );

  const summary = await buildRollingSummary(paths, autoProject);
  const context = buildCurrentContext(envelope, summary, jobId);
  await writeFile(paths.currentContextPath, context, "utf8");
  return { paths, context };
}

function extractStreamPhase(payload: Record<string, unknown>): string | null {
  const candidates = [
    nonEmptyText(payload.type),
    nonEmptyText(payload.event),
    nonEmptyText(payload.phase),
    nonEmptyText(payload.stage),
    nonEmptyText(payload.status),
  ];

  for (const candidate of candidates) {
    if (candidate) {
      return truncateInline(candidate.replace(/\s+/g, " "), 80);
    }
  }

  return null;
}

async function runAutoCodexPrompt(
  prompt: string,
  autoProject: AutoCodexProject,
  outputLastMessagePath: string,
  handlers?: AutoCodexStreamHandlers,
): Promise<string> {
  const prepared = prepareAutoCodexCommand(
    autoProject.command,
    autoProject.cwd,
    outputLastMessagePath,
  );

  let stdoutLineBuffer = "";
  let streamedText = "";

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
    const phase = extractStreamPhase(obj);
    if (phase) {
      handlers?.onStreamPhase?.(phase);
    }

    const text = extractStreamText(obj);
    if (text) {
      streamedText = appendStreamText(streamedText, text);
      handlers?.onStreamText?.(text);
    }
  };

  const commandStreamHandlers: CommandStreamHandlers | undefined = prepared.jsonStreamEnabled
    ? {
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
    }
    : undefined;

  if (prepared.outputLastMessagePath) {
    try {
      await unlink(prepared.outputLastMessagePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  const result = await runCommandWithInput(
    prepared.command,
    autoProject.cwd,
    prompt,
    autoProject.timeoutMs,
    commandStreamHandlers,
  );

  if (prepared.jsonStreamEnabled) {
    parseStdoutLine(stdoutLineBuffer);
  }

  try {
    if (result.timedOut) {
      const timeoutSeconds = autoProject.timeoutMs === null
        ? "unknown"
        : `${Math.round(autoProject.timeoutMs / 1000)}s`;
      throw new Error(
        `command timed out after ${timeoutSeconds}`,
      );
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

    let output: string | null = null;

    if (prepared.outputLastMessagePath) {
      const rawOutputFromFile = await readTextFileOrEmpty(
        prepared.outputLastMessagePath,
      );
      const outputFromFile = tryDecodeJsonMessageText(rawOutputFromFile) ??
        extractJsonLinesText(rawOutputFromFile) ??
        nonEmptyText(rawOutputFromFile);
      if (outputFromFile) {
        output = outputFromFile;
      }
    }

    if (!output && prepared.jsonStreamEnabled) {
      output = nonEmptyText(streamedText) ??
        extractJsonLinesText(result.stdout) ??
        nonEmptyText(result.stdout);
    }

    if (!output) {
      output = extractJsonLinesText(result.stdout) ??
        nonEmptyText(result.stdout);
    }

    if (!output) {
      throw new Error("command produced no final output");
    }

    return output;
  } finally {
    if (prepared.cleanupOutputLastMessagePath && prepared.outputLastMessagePath) {
      try {
        await unlink(prepared.outputLastMessagePath);
      } catch {
        // best effort cleanup only
      }
    }
  }
}

async function enqueueAutoCodexMessage(
  redis: Redis,
  autoProject: AutoCodexProject,
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

async function enqueueAutoCodexStatus(
  redis: Redis,
  autoProject: AutoCodexProject,
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

  return enqueueAutoCodexMessage(redis, autoProject, body, "markdown");
}

function cleanupDedupMap(
  projectDedup: Map<string, number>,
  now: number,
): void {
  for (const [eventId, ts] of projectDedup.entries()) {
    if (now - ts > AUTO_CODEX_DEDUP_WINDOW_MS) {
      projectDedup.delete(eventId);
    }
  }

  if (projectDedup.size <= AUTO_CODEX_DEDUP_MAX_IDS) {
    return;
  }

  const entries = [...projectDedup.entries()].sort((a, b) => a[1] - b[1]);
  const overflow = projectDedup.size - AUTO_CODEX_DEDUP_MAX_IDS;
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

function parseAgentPollRequest(payload: JsonObject): AgentPollRequest {
  const projectKey = nonEmptyText(payload.project) ?? nonEmptyText(payload.project_key);
  if (!projectKey) {
    throw new Error("missing project (or project_key)");
  }

  const agent = parseAgent(payload.agent);
  const blockSeconds = parseBlockSeconds(payload.block_seconds, 30);

  return {
    projectKey,
    agent,
    blockSeconds,
  };
}

function parseAgentSendRequest(payload: JsonObject): AgentSendRequest {
  const projectKey = nonEmptyText(payload.project) ?? nonEmptyText(payload.project_key);
  if (!projectKey) {
    throw new Error("missing project (or project_key)");
  }

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
    projectKey,
    body,
    format,
    agent: parseAgent(payload.agent),
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
    const queueDepth = await collectQueueDepth(apiRedis);
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

Project-level autoCodex (optional):
  autoCodex: true
  autoCodexAgent: "codex"                              # optional internal agent label (state/context)
  autoCodexCommand: ["codex","exec","--skip-git-repo-check"]  # relay auto-adds --json + --output-last-message for codex exec
  autoCodexTimeoutSeconds: 300                         # timeout per message (0 disables timeout + forces 15m heartbeat)
  autoCodexHeartbeatSeconds: 45                        # periodic heartbeat for non-codex timed runs (0 disables)
  autoCodexVerbosity: "output"                         # output|thinking|debug (default output)
  autoCodexSenderAllowlist: ["@admin:your-server"]    # required
  autoCodexProgressUpdates: true                       # default true
  autoCodexStateDir: ".matrix-agent-state"            # default
  autoCodexCwd: "/abs/path/to/project"                # default: current relay-core cwd
  autoCodexAckTemplate: "Starting Codex {{job_id}}."   # used when autoCodexVerbosity=debug
  autoCodexProgressTemplate: "Codex {{phase}} ({{job_id}})." # used for debug status updates
  autoCodexContextTailLines: 60                        # default

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
  const agent = parseAgent(getOption(cli, "agent"));
  const sender = parseSender(getOption(cli, "sender"));

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
      const popped = await outboundRedis.blpop(queueNames, 5);
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

async function runAutoCodexProjectWorker(
  autoCodexRedis: Redis,
  userQueue: string,
  autoProject: AutoCodexProject,
): Promise<never> {
  const projectDedup = new Map<string, number>();

  while (true) {
    try {
      const popped = await autoCodexRedis.blpop(userQueue, 5);
      if (popped === null || popped.length < 2) {
        continue;
      }

      const poppedQueue = popped[0];
      const rawPayload = popped[1];

      if (poppedQueue !== userQueue) {
        recordFailure("auto_codex_unexpected_queue", autoProject.projectKey);
        logEvent("error", "auto_codex.queue.unexpected", {
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
        logEvent("info", "auto_codex.message.skipped", {
          projectKey: autoProject.projectKey,
          queue: poppedQueue,
          sender,
          reason: "sender_not_allowlisted",
          queuedUserEventId: envelope.id,
        });
        continue;
      }

      if (markAndCheckDuplicate(projectDedup, envelope.id)) {
        logEvent("info", "auto_codex.message.skipped", {
          projectKey: autoProject.projectKey,
          queue: poppedQueue,
          sender,
          reason: "duplicate_event",
          queuedUserEventId: envelope.id,
        });
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
          ack = await enqueueAutoCodexStatus(
            autoCodexRedis,
            autoProject,
            autoProject.ackTemplate,
            "started",
            jobId,
            sender,
          );
        } else if (autoProject.verbosity === "output") {
          ack = await enqueueAutoCodexMessage(
            autoCodexRedis,
            autoProject,
            "Received.",
            "plain",
          );
        }

        if (debugStatusEnabled) {
          await enqueueAutoCodexStatus(
            autoCodexRedis,
            autoProject,
            autoProject.progressTemplate,
            "planning",
            jobId,
            sender,
          );
        }

        const { paths, context } = await prepareAutoCodexContext(
          envelope,
          autoProject,
          jobId,
        );

        if (debugStatusEnabled) {
          await enqueueAutoCodexStatus(
            autoCodexRedis,
            autoProject,
            autoProject.progressTemplate,
            "executing",
            jobId,
            sender,
          );
        }

        const statusPromises = new Set<Promise<void>>();
        const noTimeoutMode = autoProject.timeoutMs === null;
        const isCodexCommand = isCodexExecCommand(autoProject.command);
        const heartbeatIntervalMs = noTimeoutMode
          ? AUTO_CODEX_INFINITE_TIMEOUT_HEARTBEAT_MS
          : autoProject.heartbeatMs;
        const heartbeatEnabled = debugStatusEnabled && heartbeatIntervalMs > 0 &&
          (noTimeoutMode || (!isCodexCommand && autoProject.progressUpdates));

        const queueStatus = (phase: string, source: "heartbeat" | "stream"): void => {
          const pending = enqueueAutoCodexStatus(
            autoCodexRedis,
            autoProject,
            autoProject.progressTemplate,
            phase,
            jobId,
            sender,
          )
            .then(() => undefined)
            .catch((error: unknown) => {
              const detail = error instanceof Error ? error.message : String(error);
              logEvent("warn", "auto_codex.status.enqueue_failed", {
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
            start += AUTO_CODEX_MAX_MESSAGE_CHARS
          ) {
            const chunk = normalized.slice(
              start,
              start + AUTO_CODEX_MAX_MESSAGE_CHARS,
            );
            const pending = enqueueAutoCodexMessage(
              autoCodexRedis,
              autoProject,
              chunk,
              "markdown",
            )
              .then(() => undefined)
              .catch((error: unknown) => {
                const detail = error instanceof Error ? error.message : String(error);
                logEvent("warn", "auto_codex.stream.enqueue_failed", {
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
        let latestStreamPhase = "executing";
        let lastStreamSentPhase: string | null = null;
        let lastStreamSentAt = 0;
        let lastStreamSentChars = 0;

        const maybeSendStreamUpdate = (force: boolean): void => {
          if (!streamPreviewEnabled) {
            return;
          }

          const now = Date.now();
          const grownChars = streamText.length - lastStreamSentChars;
          if (!force) {
            if (grownChars < AUTO_CODEX_STREAM_UPDATE_MIN_CHARS) {
              return;
            }
            if (now - lastStreamSentAt < AUTO_CODEX_STREAM_UPDATE_MIN_INTERVAL_MS) {
              return;
            }
          } else if (grownChars <= 0) {
            return;
          }

          if (autoProject.verbosity === "thinking") {
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
              .slice(Math.max(0, streamText.length - AUTO_CODEX_STREAM_PREVIEW_MAX_CHARS))
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
          const outputLastMessagePath = join(paths.rootDir, `last-message-${jobId}.txt`);
          reply = await runAutoCodexPrompt(
            context,
            autoProject,
            outputLastMessagePath,
            {
              onStreamPhase: (phase: string) => {
                latestStreamPhase = phase;
                if (!streamPhaseEventsEnabled) {
                  return;
                }

                const now = Date.now();
                if (
                  phase !== lastStreamSentPhase &&
                  now - lastStreamSentAt >= AUTO_CODEX_STREAM_UPDATE_MIN_INTERVAL_MS
                ) {
                  queueStatus(`stream:${phase}`, "stream");
                  lastStreamSentPhase = phase;
                  lastStreamSentAt = now;
                }
              },
              onStreamText: (text: string) => {
                streamText = appendStreamText(streamText, text);
                maybeSendStreamUpdate(false);
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

        const finalText = truncateText(reply, AUTO_CODEX_MAX_CONTEXT_CHARS);

        if (debugStatusEnabled) {
          await enqueueAutoCodexStatus(
            autoCodexRedis,
            autoProject,
            autoProject.progressTemplate,
            "finalizing",
            jobId,
            sender,
          );
        }

        const outbound = await enqueueAutoCodexMessage(
          autoCodexRedis,
          autoProject,
          finalText,
          "markdown",
        );

        await appendTurnLog(
          paths.outboxLogPath,
          new Date().toISOString(),
          autoProject.agent,
          finalText,
        );

        const durationMs = Date.now() - startedAt;
        recordProcessingLatency("auto_codex_job", durationMs);
        logEvent("info", "auto_codex.job.completed", {
          projectKey: autoProject.projectKey,
          queue: poppedQueue,
          sender,
          jobId,
          durationMs,
          agentQueue,
          queuedUserEventId: envelope.id,
          ackEventId: ack?.id ?? null,
          queuedAgentEventId: outbound.id,
        });
      } catch (error: unknown) {
        const detail =
          error instanceof Error ? error.message : "auto-codex command failed";
        const durationMs = Date.now() - startedAt;
        recordFailure("auto_codex_job", autoProject.projectKey);
        recordProcessingLatency("auto_codex_job", durationMs);

        const failureBody = `Codex job ${jobId} failed: ${detail}`;
        const outbound = await enqueueAutoCodexMessage(
          autoCodexRedis,
          autoProject,
          failureBody,
          "plain",
        );
        logEvent("error", "auto_codex.job.failed", {
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
        error instanceof Error ? error.message : "auto-codex worker loop failed";
      recordFailure("auto_codex_worker_loop", autoProject.projectKey);
      logEvent("error", "auto_codex.worker.loop_error", {
        projectKey: autoProject.projectKey,
        queue: userQueue,
        error: detail,
      });
      await Bun.sleep(1000);
    }
  }
}

async function runAutoCodexProjectSupervisor(
  redisConfig: RedisConfig,
  userQueue: string,
  autoProject: AutoCodexProject,
  workerClients: Set<Redis>,
): Promise<never> {
  let crashCount = 0;

  while (true) {
    let workerRedis: Redis | null = null;
    try {
      workerRedis = await createRedisClient(redisConfig);
      workerClients.add(workerRedis);
      crashCount = 0;
      await runAutoCodexProjectWorker(workerRedis, userQueue, autoProject);
    } catch (error: unknown) {
      crashCount += 1;
      const detail =
        error instanceof Error ? error.message : "auto-codex worker crashed";
      recordWorkerRestart(autoProject.projectKey);
      recordFailure("auto_codex_worker_crash", autoProject.projectKey);
      const backoffMs = Math.min(
        AUTO_CODEX_WORKER_RESTART_MAX_DELAY_MS,
        AUTO_CODEX_WORKER_RESTART_BASE_DELAY_MS *
          2 ** Math.min(crashCount - 1, 5),
      );
      logEvent("error", "auto_codex.worker.crashed", {
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
        workerRedis.disconnect(false);
      }
    }
  }
}

async function runInboundLoop(
  inboundRedis: Redis,
  roomToProject: Map<string, string>,
  adminUserIds: Set<string>,
  botUserId?: string,
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
        if (!projectKey) {
          continue;
        }

        try {
          const joinedRoomId = await joinMatrixRoom(roomId);
          logEvent("info", "inbound.room.auto_joined", {
            projectKey,
            roomId: joinedRoomId ?? roomId,
          });
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error);
          recordFailure("inbound_auto_join", projectKey);
          logEvent("error", "inbound.room.auto_join_failed", {
            projectKey,
            error: detail,
            roomId,
          });
        }
      }

      const joinedRooms = syncResponse.rooms?.join ?? {};
      for (const [roomId, roomState] of Object.entries(joinedRooms)) {
        const projectKey = roomToProject.get(roomId);
        if (!projectKey) {
          continue;
        }

        const events = roomState.timeline?.events;
        if (!Array.isArray(events)) {
          continue;
        }

        for (const rawEvent of events) {
          const event = rawEvent as MatrixTimelineEvent;
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
  const autoCodexQueueToProject = buildAutoCodexMap();
  await validateAutoCodexProjects(autoCodexQueueToProject);

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
  const autoCodexWorkerClients = new Set<Redis>();

  const port = resolvePort();
  const server = await startHttpFacade(apiRedis, authTokens, port);

  logEvent("info", "daemon.online", {
    port: server.port,
    redisHost: redisConfig.host,
    redisPort: redisConfig.port,
    redisDb: redisConfig.db,
    outboundQueues: [...queueToProject.keys()],
    inboundRooms: [...roomToProject.keys()],
    autoCodexProjects: [...autoCodexQueueToProject.values()].map((item) => ({
      projectKey: item.projectKey,
      command: item.command,
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

  runInboundLoop(inboundRedis, roomToProject, adminUserIds, botUserId).catch(
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      recordFailure("inbound_loop_fatal");
      logEvent("error", "inbound.loop.fatal", {
        error: detail,
      });
    },
  );

  for (const [userQueue, autoProject] of autoCodexQueueToProject.entries()) {
    runAutoCodexProjectSupervisor(
      redisConfig,
      userQueue,
      autoProject,
      autoCodexWorkerClients,
    ).catch(
      (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        recordFailure("auto_codex_supervisor_fatal", autoProject.projectKey);
        logEvent("error", "auto_codex.supervisor.fatal", {
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
    outboundRedis.disconnect(false);
    inboundRedis.disconnect(false);
    apiRedis.disconnect(false);
    for (const workerRedis of autoCodexWorkerClients.values()) {
      workerRedis.disconnect(false);
    }
    autoCodexWorkerClients.clear();
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
    redis.disconnect(false);
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  logEvent("error", "process.fatal", {
    error: detail,
  });
  process.exit(1);
});
