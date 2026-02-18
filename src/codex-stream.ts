import { nonEmptyText } from "./text";

const COMMAND_OUTPUT_CAPTURE_LIMIT_CHARS = 200_000;
const THINKING_LEADING_STATUS_PATTERN =
  /^\s*(?:\*\*)?thinking(?:\.{3}|…)(?:\*\*)?(?:\s*\n+|\s+)/i;
const THINKING_INLINE_TITLE_PATTERN = /(^|\n)(\*\*[^*\n]+\*\*)(?=[\p{L}\p{N}"'“‘(])/gu;
const THINKING_TITLE_CONTINUATION_START_PATTERN = /^[\p{L}\p{N}"'“‘(]/u;

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

function normalizeThinkingTitle(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const withoutBold = trimmed.replace(/^\*\*([^*\n]+)\*\*$/u, "$1").trim();
  if (!withoutBold) {
    return null;
  }

  if (withoutBold.length > 180) {
    return null;
  }

  return withoutBold;
}

export function extractThinkingTitles(streamText: string): string[] {
  const formatted = formatThinkingStreamDelta(streamText, 0);
  if (!formatted) {
    return [];
  }

  const titles: string[] = [];
  const titlePattern = /(^|\n{2,})([^\n]+)\n{2,}/g;
  for (const match of formatted.matchAll(titlePattern)) {
    const candidate = match[2];
    if (!candidate) {
      continue;
    }

    const title = normalizeThinkingTitle(candidate);
    if (title) {
      titles.push(title);
    }
  }

  return titles;
}

export function extractStreamText(value: unknown, depth = 0): string | null {
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
