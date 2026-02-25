import { buildInitialSenderAllowlist } from "../sender-allowlist";
import { nonEmptyText } from "../text";
import { renderManagementCommandHelp } from "../copy/management";
import {
  loadConfig,
  persistProjectConfig,
  type AppConfig,
  type ProjectConfig,
} from "../runtime/config";

export type ParsedManagementCommand =
  | { action: "list" }
  | { action: "create"; projectKey: string; roomId: string; projectWorkingDirectory: string }
  | { action: "delete"; projectKey: string }
  | { action: "show"; projectKey: string }
  | { action: "reload" }
  | { action: "help" };

export type ExecuteManagementCommandOptions = {
  command: ParsedManagementCommand;
  currentProjects: Record<string, ProjectConfig>;
  senderUserId: string;
  commandPrefix: string;
  configPath: string;
  appConfig: AppConfig;
};

type ExecuteManagementCommandResult = {
  response: string;
  projects: Record<string, ProjectConfig>;
};

export function parseManagementCommandArgs(args: string[]): ParsedManagementCommand {
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

export function managementCommandHelp(commandPrefix: string): string {
  return renderManagementCommandHelp(commandPrefix);
}

export async function executeManagementCommand(
  options: ExecuteManagementCommandOptions,
): Promise<ExecuteManagementCommandResult> {
  const { command, currentProjects, senderUserId, commandPrefix, configPath, appConfig } = options;

  if (command.action === "help") {
    return {
      response: managementCommandHelp(commandPrefix),
      projects: currentProjects,
    };
  }

  if (command.action === "list") {
    if (Object.keys(currentProjects).length === 0) {
      return { response: "No projects configured.", projects: currentProjects };
    }

    const lines: string[] = ["Configured projects:", ""];
    for (const [key, project] of Object.entries(currentProjects)) {
      lines.push(`- ${key}: ${project.roomId}`);
      if (project.projectWorkingDirectory) {
        lines.push(`  working directory: ${project.projectWorkingDirectory}`);
      }
    }
    return { response: lines.join("\n"), projects: currentProjects };
  }

  if (command.action === "show") {
    const project = currentProjects[command.projectKey];
    if (!project) {
      return {
        response: `Project "${command.projectKey}" not found.`,
        projects: currentProjects,
      };
    }

    return {
      response: [
        `Project: ${command.projectKey}`,
        "",
        "```json",
        JSON.stringify(project, null, 2),
        "```",
      ].join("\n"),
      projects: currentProjects,
    };
  }

  if (command.action === "reload") {
    const reloadedProjects = await loadConfig(configPath, appConfig);
    const projectCount = Object.keys(reloadedProjects).length;
    return {
      response: [
        "Config hot-reloaded successfully.",
        "",
        `Loaded ${projectCount} project(s).`,
      ].join("\n"),
      projects: reloadedProjects,
    };
  }

  if (command.action === "create") {
    if (currentProjects[command.projectKey]) {
      return {
        response: `Project "${command.projectKey}" already exists. Use ${commandPrefix} delete first to remove it.`,
        projects: currentProjects,
      };
    }

    const newProject: ProjectConfig = {
      roomId: command.roomId,
      projectWorkingDirectory: command.projectWorkingDirectory,
      senderAllowlist: buildInitialSenderAllowlist(senderUserId),
      command: ["opencode", "run", "--format", "json"],
      timeoutSeconds: 3600,
      verbosity: "thinking",
      progressUpdates: true,
      stateDir: ".operator-state",
      ackTemplate: "Received. Starting OpenCode job {{job_id}}.",
      progressTemplate: "OpenCode {{phase}} (job {{job_id}}).",
      contextTailLines: 60,
    };

    await persistProjectConfig(configPath, command.projectKey, newProject);
    const reloadedProjects = await loadConfig(configPath, appConfig);

    return {
      response: [
        `Created project "${command.projectKey}".`,
        "",
        "```json",
        JSON.stringify(newProject, null, 2),
        "```",
        "",
        `Added ${senderUserId} to senderAllowlist by default.`,
        "",
        "Config hot-reloaded successfully.",
      ].join("\n"),
      projects: reloadedProjects,
    };
  }

  if (!currentProjects[command.projectKey]) {
    return {
      response: `Project "${command.projectKey}" not found.`,
      projects: currentProjects,
    };
  }

  await persistProjectConfig(configPath, command.projectKey, null);
  const reloadedProjects = await loadConfig(configPath, appConfig);

  return {
    response: [
      `Deleted project "${command.projectKey}".`,
      "",
      "Config hot-reloaded successfully.",
    ].join("\n"),
    projects: reloadedProjects,
  };
}
