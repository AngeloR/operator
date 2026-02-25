import { describe, expect, test } from "bun:test";
import { parseEnvelope, resolveRedisConfig } from "./redis";
import { TEST_PROJECT_KEY, TEST_ROOM_ID, buildQueueEnvelope } from "../test/fixtures";

describe("runtime/redis", () => {
  test("resolveRedisConfig uses URL defaults", () => {
    const config = resolveRedisConfig({
      redisUrl: "redis://localhost:6380/2",
    });

    expect(config.host).toBe("localhost");
    expect(config.port).toBe(6380);
    expect(config.db).toBe(2);
  });

  test("parseEnvelope supports legacy raw string payloads", () => {
    const envelope = parseEnvelope("legacy message", TEST_PROJECT_KEY, TEST_ROOM_ID);

    expect(envelope.projectKey).toBe(TEST_PROJECT_KEY);
    expect(envelope.roomId).toBe(TEST_ROOM_ID);
    expect(envelope.body).toBe("legacy message");
    expect(envelope.format).toBe("markdown");
  });

  test("parseEnvelope parses structured payload contracts", () => {
    const raw = JSON.stringify(
      buildQueueEnvelope({
        id: "evt-2",
        body: "structured",
        format: "plain",
        sender: "@admin:example.org",
        agent: "opencode",
      }),
    );

    const envelope = parseEnvelope(raw, TEST_PROJECT_KEY, TEST_ROOM_ID);
    expect(envelope).toMatchObject({
      id: "evt-2",
      projectKey: TEST_PROJECT_KEY,
      roomId: TEST_ROOM_ID,
      body: "structured",
      format: "plain",
      sender: "@admin:example.org",
      agent: "opencode",
    });
  });

  test("parseEnvelope rejects payloads without body", () => {
    expect(() => parseEnvelope(JSON.stringify({ id: "evt-3" }), TEST_PROJECT_KEY, TEST_ROOM_ID)).toThrow(
      "queue payload has no message body",
    );
  });
});
