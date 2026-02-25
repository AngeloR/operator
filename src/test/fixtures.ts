import { type QueueEnvelope } from "../runtime/redis";

export const TEST_PROJECT_KEY = "project-a";
export const TEST_ROOM_ID = "!room-a:example.org";

export function buildQueueEnvelope(overrides: Partial<QueueEnvelope> = {}): QueueEnvelope {
  return {
    id: "evt-1",
    projectKey: TEST_PROJECT_KEY,
    roomId: TEST_ROOM_ID,
    body: "hello",
    format: "markdown",
    receivedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
