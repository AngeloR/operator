import { readFile, writeFile } from "node:fs/promises";
import { nonEmptyText } from "../text";

export type ProjectConfig = {
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

export type AppConfig = {
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

export function parseAdminUserIds(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set<string>();

  const ids = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);

  return new Set(ids);
}

export function parseAgentApiTokens(appConfig: AppConfig): Set<string> {
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

type ConfigDocument = Record<string, unknown>;

async function readConfigDocument(configPath: string): Promise<ConfigDocument> {
  const rawConfig = await readFile(configPath, "utf8");

  let parsedConfig: unknown;
  try {
    parsedConfig = JSON.parse(rawConfig) as unknown;
  } catch {
    throw new Error("config.json is not valid JSON");
  }

  if (typeof parsedConfig !== "object" || parsedConfig === null || Array.isArray(parsedConfig)) {
    throw new Error("config.json root must be a JSON object");
  }

  return parsedConfig as ConfigDocument;
}

function readProjectsObject(configObject: ConfigDocument): Record<string, unknown> {
  const projects = configObject.projects;

  if (typeof projects !== "object" || projects === null || Array.isArray(projects)) {
    throw new Error("config.json projects must be an object");
  }

  return projects as Record<string, unknown>;
}

export async function persistProjectModel(
  configPath: string,
  projectKey: string,
  model: string | null,
): Promise<void> {
  const configObject = await readConfigDocument(configPath);
  const projectsObj = readProjectsObject(configObject);
  const project = projectsObj[projectKey];

  if (typeof project !== "object" || project === null) {
    throw new Error(`project "${projectKey}" not found in config.json`);
  }

  const projectConfig = project as Record<string, unknown>;
  if (model === null) {
    delete projectConfig.model;
  } else {
    projectConfig.model = model;
  }

  await writeFile(configPath, `${JSON.stringify(configObject, null, 2)}\n`, "utf8");
}

export async function persistProjectConfig(
  configPath: string,
  projectKey: string,
  projectConfig: ProjectConfig | null,
): Promise<void> {
  const configObject = await readConfigDocument(configPath);
  const projectsObj = readProjectsObject(configObject);

  if (projectConfig === null) {
    if (!projectsObj[projectKey]) {
      throw new Error(`project "${projectKey}" not found in config.json`);
    }
    delete projectsObj[projectKey];
  } else {
    projectsObj[projectKey] = projectConfig;
  }

  await writeFile(configPath, `${JSON.stringify(configObject, null, 2)}\n`, "utf8");
}

export async function loadConfig(configPath: string, cfg: AppConfig): Promise<Record<string, ProjectConfig>> {
  const configObject = await readConfigDocument(configPath);

  if (!configObject.homeserverUrl || !configObject.accessToken) {
    throw new Error("config.json must include homeserverUrl and accessToken");
  }

  const projectsObj = readProjectsObject(configObject);

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

  return cfg.projects ?? {};
}

export function resolveProject(projects: Record<string, ProjectConfig>, projectKey: string): ProjectConfig {
  const project = projects[projectKey];
  if (!project) {
    throw new Error(`unknown project: ${projectKey}`);
  }
  if (!project.roomId) {
    throw new Error(`project "${projectKey}" has no roomId`);
  }
  return project;
}

export function buildRoomToProjectMap(
  projects: Record<string, ProjectConfig>,
  onDuplicateRoom: (payload: {
    projectKey: string;
    roomId: string;
    previousProjectKey: string;
    selectedProjectKey: string;
  }) => void,
): Map<string, string> {
  const roomToProject = new Map<string, string>();

  for (const [projectKey, project] of Object.entries(projects)) {
    const roomId = nonEmptyText(project.roomId);
    if (!roomId) {
      continue;
    }

    const previous = roomToProject.get(roomId);
    if (previous && previous !== projectKey) {
      onDuplicateRoom({
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
