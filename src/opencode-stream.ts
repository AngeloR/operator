import { nonEmptyText, truncateInline } from "./text";

const COMMAND_OUTPUT_CAPTURE_LIMIT_CHARS = 200_000;
const THINKING_LEADING_STATUS_PATTERN =
  /^\s*(?:\*\*)?thinking(?:\.{3}|…)(?:\*\*)?(?:\s*\n+|\s+)/i;
const THINKING_INLINE_TITLE_PATTERN = /(^|\n)(\*\*[^*\n]+\*\*)(?=[\p{L}\p{N}"'“‘(])/gu;
const THINKING_TITLE_CONTINUATION_START_PATTERN = /^[\p{L}\p{N}"'“‘(]/u;

export type OpenCodeStreamEvent = {
  phase: string | null;
  text: string | null;
  reasoningTitle: string | null;
  isReasoning: boolean;
  error: string | null;
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function normalizeReasoningTitle(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const firstParagraph = trimmed.split(/\n{2,}/u)[0]?.trim() ?? "";
  if (!firstParagraph) {
    return null;
  }

  const firstLine = firstParagraph.split("\n")[0]?.trim() ?? "";
  if (!firstLine || firstLine.length > 180) {
    return null;
  }

  return truncateInline(firstLine.replace(/\s+/g, " "), 180);
}

function extractPart(payload: Record<string, unknown>): Record<string, unknown> | null {
  const rootPart = asObject(payload.part);
  if (rootPart) {
    return rootPart;
  }

  return asObject(asObject(payload.data)?.part);
}

function isReasoningPart(part: Record<string, unknown> | null): boolean {
  const partType = nonEmptyText(part?.type)?.toLowerCase();
  return partType === "reasoning" || partType === "thinking";
}

function parseReasoningTitleFromPayload(
  payload: Record<string, unknown>,
  eventType: string,
): string | null {
  if (eventType !== "message.part.updated") {
    return null;
  }

  const part = extractPart(payload);
  if (!part) {
    return null;
  }

  if (!isReasoningPart(part)) {
    return null;
  }

  const directTitle =
    nonEmptyText(part.title) ??
    nonEmptyText(part.summary) ??
    nonEmptyText(part.heading) ??
    nonEmptyText(part.name) ??
    nonEmptyText(asObject(part.metadata)?.title);
  if (directTitle) {
    return normalizeReasoningTitle(directTitle);
  }

  const text = extractStreamText(part);
  if (!text) {
    return null;
  }

  return normalizeReasoningTitle(text);
}

function parseErrorFromPayload(payload: Record<string, unknown>, eventType: string): string | null {
  if (eventType === "error") {
    const detail =
      nonEmptyText(payload.message) ??
      nonEmptyText(payload.detail) ??
      extractStreamText(payload.error) ??
      extractStreamText(payload);
    return detail ?? "OpenCode reported an error event";
  }

  const errorObj = asObject(payload.error);
  if (!errorObj) {
    return null;
  }

  return (
    nonEmptyText(errorObj.message) ??
    nonEmptyText(errorObj.detail) ??
    extractStreamText(errorObj)
  );
}

function normalizeEventType(payload: Record<string, unknown>): string {
  return (
    nonEmptyText(payload.type) ??
    nonEmptyText(payload.event) ??
    nonEmptyText(payload.phase) ??
    nonEmptyText(payload.stage) ??
    nonEmptyText(payload.status) ??
    ""
  ).toLowerCase();
}

export function parseOpenCodeStreamEvent(payload: Record<string, unknown>): OpenCodeStreamEvent {
  const eventType = normalizeEventType(payload);
  const phase = eventType ? truncateInline(eventType.replace(/\s+/g, " "), 80) : null;
  const partPayload = extractPart(payload);
  const isReasoning = isReasoningPart(partPayload);
  const text = partPayload
    ? extractStreamText(partPayload)
    : extractStreamText(payload);

  return {
    phase,
    text,
    reasoningTitle: parseReasoningTitleFromPayload(payload, eventType),
    isReasoning,
    error: parseErrorFromPayload(payload, eventType),
  };
}

export function appendCapturedOutput(current: string, chunk: string): string {
  if (!chunk) {
    return current;
  }

  const next = current + chunk;
  if (next.length <= COMMAND_OUTPUT_CAPTURE_LIMIT_CHARS) {
    return next;
  }

  return next.slice(next.length - COMMAND_OUTPUT_CAPTURE_LIMIT_CHARS);
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

export function appendStreamText(current: string, chunk: string): string {
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

export function formatThinkingStreamDelta(
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

export function extractStreamText(value: unknown, depth = 0): string | null {
  if (depth > 8) {
    return null;
  }

  if (typeof value === "string") {
    return nonEmptyText(value);
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

  const obj = asObject(value);
  if (!obj) {
    return null;
  }

  const primaryKeys = [
    "delta",
    "text",
    "output_text",
    "markdown",
    "body",
    "message",
    "content",
    "reasoning",
    "response",
  ];

  for (const key of primaryKeys) {
    const found = extractStreamText(obj[key], depth + 1);
    if (found) {
      return found;
    }
  }

  const containerKeys = [
    "part",
    "item",
    "data",
    "event",
    "output",
    "choices",
    "result",
    "messages",
    "parts",
    "summary",
  ];

  for (const key of containerKeys) {
    const found = extractStreamText(obj[key], depth + 1);
    if (found) {
      return found;
    }
  }

  return null;
}

export function tryDecodeJsonMessageText(value: string): string | null {
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

export function extractJsonLinesText(output: string): string | null {
  const normalized = output.replace(/\r\n/g, "\n");
  if (!normalized) {
    return null;
  }

  let combined = "";
  let nonReasoningCombined = "";
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

    const obj = asObject(payload);
    if (!obj) {
      continue;
    }

    const event = parseOpenCodeStreamEvent(obj);
    if (event.text) {
      combined = appendStreamText(combined, event.text);
      if (!event.isReasoning) {
        nonReasoningCombined = appendStreamText(nonReasoningCombined, event.text);
      }
    }
  }

  if (nonReasoningCombined) {
    return nonReasoningCombined;
  }

  if (combined) {
    return combined;
  }

  return tryDecodeJsonMessageText(normalized);
}
