import { RedisClient } from "bun";
import { nonEmptyText, parseFormat, parseOptionalString, type MessageFormat } from "../text";

export type QueueDirection = "agent" | "user";

export type QueueEnvelope = {
  id: string;
  projectKey: string;
  roomId: string;
  body: string;
  format: MessageFormat;
  agent?: string;
  sender?: string;
  receivedAt: string;
};

export type Redis = RedisClient;

export type RedisConfig = {
  host: string;
  port: number;
  password?: string;
  db: number;
  connectTimeoutMs: number;
};

export type RedisConfigSource = {
  redisUrl?: string;
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
  redisDb?: number;
};

export function queueKey(projectKey: string, direction: QueueDirection): string {
  return `${projectKey}:${direction}`;
}

export function resolveRedisConfig(appConfig: RedisConfigSource): RedisConfig {
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

export async function createRedisClient(redisConfig: RedisConfig): Promise<Redis> {
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

export function createEnvelope(
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

export function parseEnvelope(
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
