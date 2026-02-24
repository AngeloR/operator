import {
  buildMetricsSnapshot,
  collectQueueDepth,
  logEvent,
  recordFailure,
} from "../metrics";
import { nonEmptyText, parseFormat, parseOptionalString, type MessageFormat } from "../text";
import { type ProjectConfig } from "./config";
import {
  type QueueDirection,
  type QueueEnvelope,
  type Redis,
  type QueueEnvelope as Envelope,
} from "./redis";

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

type HttpFacadeDependencies = {
  apiRedis: Redis;
  authTokens: Set<string>;
  resolveProject: (projectKey: string) => ProjectConfig;
  projectKeys: () => string[];
  queueKey: (projectKey: string, direction: QueueDirection) => string;
  parseEnvelope: (
    raw: string,
    fallbackProjectKey: string,
    fallbackRoomId: string,
  ) => QueueEnvelope;
  createEnvelope: (
    projectKey: string,
    roomId: string,
    body: string,
    format: MessageFormat,
    extras: { agent?: string; sender?: string },
  ) => Envelope;
};

function json(status: number, payload: unknown): Response {
  return Response.json(payload, { status });
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

export async function startHttpFacade(
  deps: HttpFacadeDependencies,
  port: number,
) {
  const { apiRedis, authTokens } = deps;

  const handleAgentPoll = async (req: Request): Promise<Response> => {
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
      project = deps.resolveProject(parsed.projectKey);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return json(404, { error: detail });
    }

    try {
      const key = deps.queueKey(parsed.projectKey, "user");
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

      const message = deps.parseEnvelope(rawPayload, parsed.projectKey, project.roomId);
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
  };

  const handleAgentSend = async (req: Request): Promise<Response> => {
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
      project = deps.resolveProject(parsed.projectKey);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return json(404, { error: detail });
    }

    try {
      const envelope = deps.createEnvelope(
        parsed.projectKey,
        project.roomId,
        parsed.body,
        parsed.format,
        { agent: parsed.agent },
      );

      const key = deps.queueKey(parsed.projectKey, "agent");
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
  };

  const handleMetrics = async (): Promise<Response> => {
    try {
      const queueDepth = await collectQueueDepth(
        apiRedis,
        deps.projectKeys(),
        deps.queueKey,
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
  };

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
        return handleMetrics();
      }

      if (path === "/v1/agent/poll" && method === "POST") {
        return handleAgentPoll(req);
      }

      if (path === "/v1/agent/send" && method === "POST") {
        return handleAgentSend(req);
      }

      return json(404, { error: "not found" });
    },
  });
}
