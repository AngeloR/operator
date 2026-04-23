import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { marked } from "marked";
import { nonEmptyText, type MessageFormat } from "../text";
import { type QueueAttachment, type QueueEnvelope } from "../types/contracts";

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
  "m.relates_to"?: MatrixThreadRelation;
};

export type MatrixThreadRelation = {
  rel_type: "m.thread";
  event_id: string;
  is_falling_back: true;
  "m.in_reply_to": {
    event_id: string;
  };
};

const UTF8_ENCODER = new TextEncoder();
const ALLOWED_TEXT_EXTENSIONS = new Set(["txt", "md"]);
const DEFAULT_ATTACHMENT_DOWNLOAD_DIR = "/tmp/operator-attachments";

export type MatrixTimelineEvent = {
  type?: unknown;
  sender?: unknown;
  event_id?: unknown;
  origin_server_ts?: unknown;
  content?: unknown;
};

type MatrixMessageType = "m.text" | "m.file" | "m.image";

type MatrixInboundMessageContent = {
  msgtype?: unknown;
  body?: unknown;
  url?: unknown;
  info?: {
    mimetype?: unknown;
    size?: unknown;
  };
  file?: {
    url?: unknown;
  };
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

export function utf8ByteLength(text: string): number {
  return UTF8_ENCODER.encode(text).length;
}

function sliceByUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || !text) {
    return "";
  }

  let low = 0;
  let high = text.length;
  let best = "";

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid);
    const size = utf8ByteLength(candidate);
    if (size <= maxBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

function fenceTokenForLine(line: string): string | null {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("```")) {
    return "```";
  }
  if (trimmed.startsWith("~~~")) {
    return "~~~";
  }
  return null;
}

type ChunkState = {
  chunks: string[];
  current: string;
  openFence: string | null;
};

function appendChunkText(state: ChunkState, text: string): void {
  if (!text) {
    return;
  }

  state.current = state.current ? `${state.current}${text}` : text;
}

function finalizeChunk(state: ChunkState): void {
  if (!state.current) {
    return;
  }

  let finalized = state.current;
  if (state.openFence) {
    finalized = `${finalized}\n${state.openFence}`;
  }

  state.chunks.push(finalized);
  state.current = state.openFence ? `${state.openFence}\n` : "";
}

function appendLineWithinBudget(
  state: ChunkState,
  line: string,
  maxChunkBytes: number,
): void {
  let remaining = line;

  while (remaining.length > 0) {
    const prefix = state.current ? "\n" : "";
    const available = maxChunkBytes - utf8ByteLength(state.current) - utf8ByteLength(prefix);

    if (available <= 0) {
      finalizeChunk(state);
      continue;
    }

    const piece = sliceByUtf8Bytes(remaining, available);
    if (!piece) {
      finalizeChunk(state);
      continue;
    }

    appendChunkText(state, `${prefix}${piece}`);
    remaining = remaining.slice(piece.length);
    if (remaining.length > 0) {
      finalizeChunk(state);
    }
  }
}

export function splitMessageBodyForMatrix(body: string, maxChunkBytes: number): string[] {
  if (maxChunkBytes < 256) {
    throw new Error("maxChunkBytes must be at least 256");
  }

  const normalized = body.replace(/\r\n/g, "\n");
  if (!normalized) {
    return [""];
  }

  if (utf8ByteLength(normalized) <= maxChunkBytes) {
    return [normalized];
  }

  const lines = normalized.split("\n");
  const state: ChunkState = {
    chunks: [],
    current: "",
    openFence: null,
  };

  for (const line of lines) {
    const prefix = state.current ? "\n" : "";
    const candidate = `${state.current}${prefix}${line}`;

    if (utf8ByteLength(candidate) <= maxChunkBytes) {
      appendChunkText(state, `${prefix}${line}`);
    } else if (!state.current) {
      appendLineWithinBudget(state, line, maxChunkBytes);
    } else {
      finalizeChunk(state);
      if (utf8ByteLength(line) <= maxChunkBytes) {
        appendChunkText(state, line);
      } else {
        appendLineWithinBudget(state, line, maxChunkBytes);
      }
    }

    const token = fenceTokenForLine(line);
    if (token) {
      state.openFence = state.openFence === token ? null : token;
    }
  }

  if (state.current) {
    state.chunks.push(state.current);
  }

  return state.chunks.length > 0 ? state.chunks : [normalized];
}

export function buildThreadRelation(rootEventId: string): MatrixThreadRelation {
  return {
    rel_type: "m.thread",
    event_id: rootEventId,
    is_falling_back: true,
    "m.in_reply_to": {
      event_id: rootEventId,
    },
  };
}

export function buildMatrixContent(
  message: ParsedMessage,
  relatesTo?: MatrixThreadRelation,
): MatrixMessageContent {
  const formattedBody =
    message.format === "markdown"
      ? toMarkdownHtml(message.body)
      : toPlainHtml(message.body);

  return {
    msgtype: "m.text",
    body: message.body,
    format: "org.matrix.custom.html",
    formatted_body: formattedBody,
    ...(relatesTo ? { "m.relates_to": relatesTo } : {}),
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

function normalizeMatrixMsgType(value: unknown): MatrixMessageType | null {
  if (value === "m.text" || value === "m.file" || value === "m.image") {
    return value;
  }
  return null;
}

function parseMxcUri(value: unknown): { sourceMxc: string; serverName: string; mediaId: string } | null {
  const sourceMxc = nonEmptyText(value);
  if (!sourceMxc || !sourceMxc.startsWith("mxc://")) {
    return null;
  }

  const withoutScheme = sourceMxc.slice("mxc://".length);
  const slashIndex = withoutScheme.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= withoutScheme.length - 1) {
    return null;
  }

  const serverName = withoutScheme.slice(0, slashIndex);
  const mediaId = withoutScheme.slice(slashIndex + 1);
  if (!serverName || !mediaId) {
    return null;
  }

  return {
    sourceMxc,
    serverName,
    mediaId,
  };
}

function resolveAttachmentType(
  msgtype: MatrixMessageType,
  filename: string,
  mimeType?: string,
): QueueAttachment["kind"] | null {
  if (msgtype === "m.image") {
    return "image";
  }

  if (mimeType?.toLowerCase().startsWith("image/")) {
    return "image";
  }

  const extension = extname(filename).toLowerCase().replace(/^\./, "");
  if (ALLOWED_TEXT_EXTENSIONS.has(extension)) {
    return "text";
  }

  return null;
}

function sanitizeFilename(filename: string): string {
  const name = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  return nonEmptyText(name) ?? "attachment";
}

function parseSizeBytes(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

async function downloadMatrixAttachment(
  cfg: MatrixClientConfig,
  mxc: { sourceMxc: string; serverName: string; mediaId: string },
): Promise<{ data: Uint8Array; contentType?: string }> {
  const url = new URL(
    `/_matrix/client/v1/media/download/${encodeURIComponent(mxc.serverName)}/${encodeURIComponent(mxc.mediaId)}`,
    cfg.homeserverUrl,
  );

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`media download failed: HTTP ${response.status} ${response.statusText}`);
  }

  const data = new Uint8Array(await response.arrayBuffer());
  const contentType = nonEmptyText(response.headers.get("content-type") ?? undefined) ?? undefined;
  return { data, contentType };
}

async function buildInboundAttachment(
  cfg: MatrixClientConfig,
  content: MatrixInboundMessageContent,
  attachmentDownloadDir: string,
): Promise<QueueAttachment | null> {
  const msgtype = normalizeMatrixMsgType(content.msgtype);
  if (msgtype !== "m.file" && msgtype !== "m.image") {
    return null;
  }

  if (content.file && typeof content.file === "object") {
    return {
      id: crypto.randomUUID(),
      filename: nonEmptyText(content.body) ?? "attachment",
      kind: msgtype === "m.image" ? "image" : "text",
      sourceMxc: nonEmptyText(content.file.url) ?? "",
      downloadStatus: "failed",
      error: "encrypted Matrix attachments are not supported yet",
    };
  }

  const rawUrl = nonEmptyText(content.url);
  const mxc = parseMxcUri(rawUrl);
  if (!mxc) {
    return {
      id: crypto.randomUUID(),
      filename: nonEmptyText(content.body) ?? "attachment",
      kind: msgtype === "m.image" ? "image" : "text",
      sourceMxc: nonEmptyText(rawUrl) ?? "",
      downloadStatus: "failed",
      error: "missing or invalid mxc url",
    };
  }

  const filename = nonEmptyText(content.body) ?? `${msgtype === "m.image" ? "image" : "file"}-${mxc.mediaId}`;
  const mimeType = nonEmptyText(content.info?.mimetype) ?? undefined;
  const sizeBytes = parseSizeBytes(content.info?.size);
  const kind = resolveAttachmentType(msgtype, filename, mimeType);

  if (!kind) {
    return {
      id: crypto.randomUUID(),
      filename,
      kind: msgtype === "m.image" ? "image" : "text",
      sourceMxc: mxc.sourceMxc,
      mimeType,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      downloadStatus: "rejected",
      error: "unsupported attachment type; only .txt, .md, and images are allowed",
    };
  }

  try {
    const downloaded = await downloadMatrixAttachment(cfg, mxc);
    const finalMimeType = mimeType ?? downloaded.contentType;
    const attachmentId = crypto.randomUUID();
    const safeName = sanitizeFilename(filename);
    const localPath = join(attachmentDownloadDir, `${attachmentId}-${safeName}`);
    await mkdir(attachmentDownloadDir, { recursive: true });
    await writeFile(localPath, downloaded.data);

    return {
      id: attachmentId,
      filename,
      kind,
      sourceMxc: mxc.sourceMxc,
      mimeType: finalMimeType,
      sizeBytes: sizeBytes ?? downloaded.data.length,
      localPath,
      downloadStatus: "downloaded",
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      id: crypto.randomUUID(),
      filename,
      kind,
      sourceMxc: mxc.sourceMxc,
      mimeType,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      downloadStatus: "failed",
      error: detail,
    };
  }
}

export async function toUserQueueEnvelope(
  cfg: MatrixClientConfig,
  event: MatrixTimelineEvent,
  projectKey: string,
  roomId: string,
  adminUserIds: Set<string>,
  attachmentDownloadDir = DEFAULT_ATTACHMENT_DOWNLOAD_DIR,
  botUserId?: string,
): Promise<QueueEnvelope | null> {
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

  const content = event.content as MatrixInboundMessageContent;
  const msgtype = normalizeMatrixMsgType(content.msgtype);
  if (!msgtype) {
    return null;
  }

  const body = nonEmptyText(content.body);
  if (!body) {
    return null;
  }

  if ((content as Record<string, unknown>)["m.relates_to"] !== undefined) {
    return null;
  }

  const attachment = await buildInboundAttachment(cfg, content, attachmentDownloadDir);

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
    ...(attachment ? { attachments: [attachment] } : {}),
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
