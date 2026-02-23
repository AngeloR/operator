export function parseSenderAllowlist(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    throw new Error("senderAllowlist must be an array of user IDs");
  }

  const ids = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);

  if (ids.length === 0) {
    throw new Error("senderAllowlist must include at least one user ID");
  }

  return new Set(ids);
}

export function buildInitialSenderAllowlist(senderUserId: string): string[] {
  const sender = senderUserId.trim();
  if (sender.length === 0) {
    throw new Error("sender user ID is required to initialize senderAllowlist");
  }

  return [sender];
}
