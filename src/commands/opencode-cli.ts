import { nonEmptyText, truncateText } from "../text";
import {
  loadConfig,
  persistProjectModel,
  type AppConfig,
  type ProjectConfig,
} from "../runtime/config";
import {
  type AutoOpenCodeCliCommand,
  type AutoOpenCodeProject,
  type ParsedAutoOpenCodeCliRequest,
} from "../worker/auto-opencode";

const AUTO_OPENCODE_CLI_ALLOWED_COMMANDS = new Set<AutoOpenCodeCliCommand>([
  "usage",
  "stats",
  "models",
  "model",
  "start",
  "help",
]);

type ParsedModelCommandAction =
  | { action: "show" }
  | { action: "reset" }
  | { action: "set"; model: string };

export type CommandRunResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
};

export type ExecuteAutoOpenCodeCliCommandOptions = {
  request: ParsedAutoOpenCodeCliRequest;
  autoProject: AutoOpenCodeProject;
  configPath: string;
  appConfig: AppConfig;
  currentProjects: Record<string, ProjectConfig>;
  maxContextChars: number;
  runCommandWithInput: (
    command: string[],
    cwd: string,
    input: string,
    timeoutMs: number | null,
  ) => Promise<CommandRunResult>;
};

type ExecuteAutoOpenCodeCliCommandResult = {
  response: string;
  projects: Record<string, ProjectConfig>;
};

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function splitCommandTokens(input: string): string[] {
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

export function parseAutoOpenCodeCliRequest(
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
    throw new Error("usage command requires a model (example: !op usage openai/gpt-5.3-codex --days 30)");
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
    "Onboarding:",
    `- ${prefix} start`,
    "",
    "CLI shortcuts:",
    `- ${prefix} usage <model> [--days N] [--project KEY]`,
    `- ${prefix} stats [--days N] [--models [N]] [--project KEY]`,
    `- ${prefix} models [provider] [--verbose] [--refresh]`,
    `- ${prefix} model [<model-id>|reset]`,
    `- ${prefix} help`,
  ].join("\n");
}

function guidedStartFlow(commandPrefix: string): string {
  return [
    "Guided onboarding (first 10 minutes):",
    "",
    "1) Confirm command wiring",
    `   - Run: ${commandPrefix} help`,
    "   - Expected: command list appears in this room",
    "",
    "2) Confirm OpenCode CLI availability",
    `   - Run: ${commandPrefix} models --verbose`,
    "   - Expected: available providers/models list",
    "",
    "3) Check project model override",
    `   - Run: ${commandPrefix} model`,
    `   - Optional: set one with ${commandPrefix} model <model-id>`,
    "",
    "4) Send your first real task",
    "   - Example prompt: Summarize this repository architecture in 5 bullets.",
    "",
    "5) Validate control flow",
    "   - Send: stop",
    "   - Expected: active job is cancelled and the bot waits for next instruction",
    "",
    "When all 5 steps pass, onboarding is complete.",
  ].join("\n");
}

export function generalHelp(commandPrefix: string, managementCommandPrefix: string): string {
  return [
    "Available commands:",
    "",
    "General commands:",
    "- !help - Show this help message",
    "- stop - Stop the current running job and wait",
    "",
    "OpenCode CLI commands:",
    `- ${commandPrefix} start`,
    `- ${commandPrefix} usage <model> [--days N] [--project KEY]`,
    `- ${commandPrefix} stats [--days N] [--models [N]] [--project KEY]`,
    `- ${commandPrefix} models [provider] [--verbose] [--refresh]`,
    `- ${commandPrefix} model [<model-id>|reset]`,
    `- ${commandPrefix} help`,
    "",
    "Project management commands (management room only):",
    `- ${managementCommandPrefix} list`,
    `- ${managementCommandPrefix} create <name> --room <roomId> --path <directory>`,
    `- ${managementCommandPrefix} delete <name>`,
    `- ${managementCommandPrefix} show <name>`,
    `- ${managementCommandPrefix} reload`,
    `- ${managementCommandPrefix} help`,
    "",
    `Tip: run ${managementCommandPrefix} help in the management room for command examples.`,
  ].join("\n");
}

export async function executeAutoOpenCodeCliCommand(
  options: ExecuteAutoOpenCodeCliCommandOptions,
): Promise<ExecuteAutoOpenCodeCliCommandResult> {
  const {
    request,
    autoProject,
    configPath,
    appConfig,
    currentProjects,
    maxContextChars,
    runCommandWithInput,
  } = options;

  if (request.command === "help") {
    return {
      response: autoOpenCodeCliHelp(autoProject.commandPrefix),
      projects: currentProjects,
    };
  }

  if (request.command === "start") {
    return {
      response: guidedStartFlow(autoProject.commandPrefix),
      projects: currentProjects,
    };
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
      return {
        response: current
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
          ].join("\n"),
        projects: currentProjects,
      };
    }

    if (action.action === "reset") {
      if (!current) {
        return {
          response: [
            `No project model override is set for \`${autoProject.projectKey}\`.`,
            "",
            "Nothing to reset.",
          ].join("\n"),
          projects: currentProjects,
        };
      }

      await persistProjectModel(configPath, autoProject.projectKey, null);
      const reloadedProjects = await loadConfig(configPath, appConfig);
      return {
        response: [
          `Cleared project model override for \`${autoProject.projectKey}\`.`,
          "",
          "OpenCode will now use its configured default model.",
          "",
          "Config hot-reloaded successfully.",
        ].join("\n"),
        projects: reloadedProjects,
      };
    }

    await persistProjectModel(configPath, autoProject.projectKey, action.model);
    const reloadedProjects = await loadConfig(configPath, appConfig);
    return {
      response: [
        `Set model override for \`${autoProject.projectKey}\` to \`${action.model}\`.`,
        "",
        "New OpenCode runs in this project will use that model.",
        "",
        "Config hot-reloaded successfully.",
      ].join("\n"),
      projects: reloadedProjects,
    };
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
      return {
        response: [
          `No usage section found for model \`${modelFilter}\`.`,
          "",
          "Try running one of:",
          `- ${autoProject.commandPrefix} stats --models`,
          `- ${autoProject.commandPrefix} models`,
        ].join("\n"),
        projects: currentProjects,
      };
    }

    return {
      response: [
        `Usage for \`${modelFilter}\`:`,
        "",
        "```text",
        truncateText(modelBlock, maxContextChars),
        "```",
      ].join("\n"),
      projects: currentProjects,
    };
  }

  return {
    response: [
      `Ran \`${command.join(" ")}\``,
      "",
      "```text",
      truncateText(cleaned, maxContextChars),
      "```",
    ].join("\n"),
    projects: currentProjects,
  };
}
