export type MessageFormat = "markdown" | "plain";

export function nonEmptyText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/\S/.test(value)) return null;
  return value.replace(/\r\n/g, "\n");
}

export function parseFormat(value: unknown): MessageFormat {
  return value === "plain" ? "plain" : "markdown";
}

export function parseOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function truncateText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }

  const keep = Math.max(maxChars - 24, 0);
  return `${input.slice(0, keep)}\n\n[truncated]`;
}

export function tailLines(input: string, lineCount: number): string {
  if (!input) {
    return "";
  }

  const lines = input.replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= lineCount) {
    return input;
  }

  return lines.slice(lines.length - lineCount).join("\n");
}

export function truncateInline(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }

  if (maxChars <= 3) {
    return input.slice(0, maxChars);
  }

  return `${input.slice(0, maxChars - 3)}...`;
}
