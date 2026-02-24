import { marked } from "marked";
import { nonEmptyText, type MessageFormat } from "../text";
import { type QueueEnvelope } from "./redis";

export type MatrixClientConfig = {
  homeserverUrl: string;
  accessToken: string;
};

export type ParsedMessage = {
  body: string;
  format: MessageFormat;
  agent?: string;
};

export type MatrixMessageContent = {
  msgtype: "m.text";
  body: string;
  format: "org.matrix.custom.html";
  formatted_body: string;
};

export type MatrixTimelineEvent = {
  type?: unknown;
  sender?: unknown;
  event_id?: unknown;
  origin_server_ts?: unknown;
  content?: unknown;
};

export type MatrixSyncResponse = {
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

export function buildMatrixContent(message: ParsedMessage): MatrixMessageContent {
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
  cfg: MatrixClientConfig,
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
  cfg: MatrixClientConfig,
  path: string,
  query: Record<string, string | undefined>,
): Promise<T> {
  return matrixRequest<T>(cfg, "GET", path, { query });
}

async function matrixPost<T>(cfg: MatrixClientConfig, path: string, payload: unknown): Promise<T> {
  return matrixRequest<T>(cfg, "POST", path, { payload });
}

export async function fetchBotUserId(
  cfg: MatrixClientConfig,
  onWhoAmIFailure: (detail: string) => void,
): Promise<string | undefined> {
  try {
    const whoami = await matrixGet<MatrixWhoAmIResponse>(
      cfg,
      "/_matrix/client/v3/account/whoami",
      {},
    );
    return nonEmptyText(whoami.user_id) ?? undefined;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    onWhoAmIFailure(detail);
    return undefined;
  }
}

export async function syncMatrix(
  cfg: MatrixClientConfig,
  since: string | undefined,
  timeoutMs: number,
): Promise<MatrixSyncResponse> {
  return matrixGet<MatrixSyncResponse>(cfg, "/_matrix/client/v3/sync", {
    timeout: String(timeoutMs),
    since,
  });
}

export async function joinMatrixRoom(
  cfg: MatrixClientConfig,
  roomId: string,
): Promise<string | undefined> {
  const joined = await matrixPost<MatrixJoinRoomResponse>(
    cfg,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    {},
  );
  return nonEmptyText(joined.room_id) ?? undefined;
}

export function toUserQueueEnvelope(
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

export async function sendToRoom(
  cfg: MatrixClientConfig,
  roomId: string,
  content: MatrixMessageContent,
): Promise<string> {
  const txnId = crypto.randomUUID();
  const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`;
  const payload = await matrixRequest<{ event_id?: unknown }>(cfg, "PUT", path, {
    payload: content,
    fallbackErrorDetail: "Matrix request failed",
  });

  if (typeof payload.event_id !== "string") {
    throw new Error("Matrix response missing event_id");
  }

  return payload.event_id;
}
