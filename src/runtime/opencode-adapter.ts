import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  executeAutoOpenCodeCliCommand,
  parseAutoOpenCodeCliRequest,
} from "../commands/opencode-cli";
import { parseSenderAllowlist } from "../sender-allowlist";
import { nonEmptyText } from "../text";
import {
  type AppConfig,
  type ProjectConfig,
} from "./config";
import {
  createEnvelope,
  parseEnvelope,
  queueKey,
  type Redis,
} from "./redis";
import {
  AutoOpenCodeStoppedError,
  isOpenCodeRunCommand,
  runAutoOpenCodePrompt,
  runCommandWithInput,
} from "./process";
import { appendTurnLog, prepareAutoOpenCodeContext } from "../worker/context-state";
import {
  runAutoOpenCodeProjectWorker,
  type ActiveAutoOpenCodeRun,
  type AutoOpenCodeCliCommand,
  type AutoOpenCodeProject,
  type AutoOpenCodeVerbosity,
} from "../worker/auto-opencode";

const DEFAULT_AUTO_OPENCODE_COMMAND = ["opencode", "run"];
const DEFAULT_AUTO_OPENCODE_COMMAND_PREFIX = "!op";
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
  "!agent stop",
  `${DEFAULT_AUTO_OPENCODE_COMMAND_PREFIX} stop`,
]);
const AUTO_OPENCODE_MAX_MESSAGE_CHARS = 16_000;
const AUTO_OPENCODE_MAX_CONTEXT_CHARS = 24_000;
const AUTO_OPENCODE_DEDUP_WINDOW_MS = 30 * 60 * 1000;
const AUTO_OPENCODE_DEDUP_MAX_IDS = 2000;
const AUTO_OPENCODE_STREAM_UPDATE_MIN_INTERVAL_MS = 5000;
const AUTO_OPENCODE_STREAM_UPDATE_MIN_CHARS = 200;
const AUTO_OPENCODE_STREAM_PREVIEW_MAX_CHARS = 4000;

export const DEFAULT_OPENCODE_COMMAND_PREFIX = DEFAULT_AUTO_OPENCODE_COMMAND_PREFIX;

export type OpenCodeAdapterOptions = {
  configPath: string;
  appConfig: AppConfig;
  getProjects: () => Record<string, ProjectConfig>;
  setProjects: (projects: Record<string, ProjectConfig>) => void;
};

export class OpenCodeAdapter {
  private readonly activeRuns = new Map<string, ActiveAutoOpenCodeRun>();

  constructor(private readonly options: OpenCodeAdapterOptions) {}

  isStopMessage(body: string): boolean {
    const normalized = body.trim().toLowerCase();
    return AUTO_OPENCODE_STOP_ALIASES.has(normalized);
  }

  requestStopForProject(projectKey: string, sender: string): {
    stopped: boolean;
    jobId: string | null;
  } {
    const active = this.activeRuns.get(projectKey);
    if (!active) {
      return { stopped: false, jobId: null };
    }

    active.stopRequestedBy = sender;
    active.abortController.abort();
    return { stopped: true, jobId: active.jobId };
  }

  buildProjectsByQueue(
    projects: Record<string, ProjectConfig>,
    eligibleProjectKeys?: Set<string>,
  ): Map<string, AutoOpenCodeProject> {
    const map = new Map<string, AutoOpenCodeProject>();

    for (const [projectKey, project] of Object.entries(projects)) {
      if (eligibleProjectKeys && !eligibleProjectKeys.has(projectKey)) {
        continue;
      }

      assertNoLegacyConfig(this.options.appConfig, projectKey, project);

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

  async validateProjects(projectsByQueue: Map<string, AutoOpenCodeProject>): Promise<void> {
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

  runProjectWorker(workerRedis: Redis, userQueue: string, autoProject: AutoOpenCodeProject): Promise<never> {
    return runAutoOpenCodeProjectWorker({
      autoOpenCodeRedis: workerRedis,
      userQueue,
      autoProject,
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
            configPath: this.options.configPath,
            appConfig: this.options.appConfig,
            currentProjects: this.options.getProjects(),
            maxContextChars: AUTO_OPENCODE_MAX_CONTEXT_CHARS,
            runCommandWithInput: async (command, cwd, input, timeoutMs) =>
              runCommandWithInput(command, cwd, input, timeoutMs),
          });
          this.options.setProjects(result.projects);
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
          this.activeRuns.set(projectKey, run);
        },
        getStopRequestedBy: (projectKey) => {
          const activeRun = this.activeRuns.get(projectKey);
          return activeRun?.stopRequestedBy ?? null;
        },
        clearActiveRun: (projectKey, jobId) => {
          const activeRun = this.activeRuns.get(projectKey);
          if (activeRun?.jobId === jobId) {
            this.activeRuns.delete(projectKey);
          }
        },
        isStoppedError: (error: unknown): boolean => error instanceof AutoOpenCodeStoppedError,
      },
    });
  }
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

function assertNoLegacyConfig(cfg: AppConfig, projectKey: string, project: ProjectConfig): void {
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

async function enqueueAutoOpenCodeMessage(
  redis: Redis,
  autoProject: AutoOpenCodeProject,
  body: string,
  format: "plain" | "markdown",
) {
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
) {
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
