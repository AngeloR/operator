import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMatrixContent,
  buildThreadRelation,
  splitMessageBodyForMatrix,
  toUserQueueEnvelope,
  utf8ByteLength,
} from "./matrix";

describe("runtime/matrix", () => {
  test("utf8ByteLength counts multibyte characters", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("🙂")).toBe(4);
  });

  test("splitMessageBodyForMatrix keeps each chunk under byte budget", () => {
    const line = "0123456789".repeat(60);
    const body = `${line}\n\n${line}\n\n${line}`;
    const chunks = splitMessageBodyForMatrix(body, 800);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(utf8ByteLength(chunk)).toBeLessThanOrEqual(800);
    }
  });

  test("splitMessageBodyForMatrix balances fenced code blocks in each chunk", () => {
    const codeLine = "x".repeat(1200);
    const body = [
      "Before",
      "",
      "```ts",
      codeLine,
      codeLine,
      "```",
      "",
      "After",
    ].join("\n");
    const chunks = splitMessageBodyForMatrix(body, 900);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const fenceMatches = chunk.match(/```/g) ?? [];
      expect(fenceMatches.length % 2).toBe(0);
    }
  });

  test("buildMatrixContent includes thread relation when provided", () => {
    const relation = buildThreadRelation("$root");
    const content = buildMatrixContent({ body: "hello", format: "plain" }, relation);

    expect(content["m.relates_to"]).toEqual(relation);
  });

  test("toUserQueueEnvelope downloads allowed text attachments", async () => {
    let fetchCalls = 0;
    const fetchMock = (async () => {
      fetchCalls += 1;
      return new Response("hello attachment", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }) as unknown as typeof fetch;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    const attachmentDir = await mkdtemp(join(tmpdir(), "matrix-attachment-test-"));

    try {
      const envelope = await toUserQueueEnvelope(
        { homeserverUrl: "https://matrix.example", accessToken: "token" },
        {
          type: "m.room.message",
          sender: "@alice:example.org",
          event_id: "$event",
          content: {
            msgtype: "m.file",
            body: "notes.md",
            url: "mxc://example.org/abc123",
            info: {
              mimetype: "text/markdown",
            },
          },
        },
        "project",
        "!room:example.org",
        new Set(),
        attachmentDir,
      );

      expect(envelope).not.toBeNull();
      expect(envelope?.attachments?.[0]?.downloadStatus).toBe("downloaded");
      expect(envelope?.attachments?.[0]?.kind).toBe("text");
      expect(envelope?.attachments?.[0]?.filename).toBe("notes.md");
      expect(envelope?.attachments?.[0]?.localPath).toContain(attachmentDir);
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(attachmentDir, { recursive: true, force: true });
    }
  });

  test("toUserQueueEnvelope rejects unsupported file extensions", async () => {
    let fetchCalls = 0;
    const fetchMock = (async () => {
      fetchCalls += 1;
      return new Response("ignored", { status: 200 });
    }) as unknown as typeof fetch;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    try {
      const envelope = await toUserQueueEnvelope(
        { homeserverUrl: "https://matrix.example", accessToken: "token" },
        {
          type: "m.room.message",
          sender: "@alice:example.org",
          event_id: "$event2",
          content: {
            msgtype: "m.file",
            body: "archive.zip",
            url: "mxc://example.org/zip123",
            info: {
              mimetype: "application/zip",
            },
          },
        },
        "project",
        "!room:example.org",
        new Set(),
      );

      expect(envelope).not.toBeNull();
      expect(envelope?.attachments?.[0]?.downloadStatus).toBe("rejected");
      expect(envelope?.attachments?.[0]?.error).toContain("only .txt, .md, and images");
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("toUserQueueEnvelope allows image attachments", async () => {
    let fetchCalls = 0;
    const fetchMock = (async () => {
      fetchCalls += 1;
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as unknown as typeof fetch;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    const attachmentDir = await mkdtemp(join(tmpdir(), "matrix-image-test-"));

    try {
      const envelope = await toUserQueueEnvelope(
        { homeserverUrl: "https://matrix.example", accessToken: "token" },
        {
          type: "m.room.message",
          sender: "@alice:example.org",
          event_id: "$event3",
          content: {
            msgtype: "m.image",
            body: "photo",
            url: "mxc://example.org/image123",
            info: {
              mimetype: "image/png",
            },
          },
        },
        "project",
        "!room:example.org",
        new Set(),
        attachmentDir,
      );

      expect(envelope?.attachments?.[0]?.kind).toBe("image");
      expect(envelope?.attachments?.[0]?.downloadStatus).toBe("downloaded");
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(attachmentDir, { recursive: true, force: true });
    }
  });
});
