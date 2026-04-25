import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMatrixContent,
  buildThreadRelation,
  sendReadReceipt,
  sendLargeMessageAsAttachment,
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

  test("sendLargeMessageAsAttachment uploads media and sends m.file event", async () => {
    const fetchCalls: Array<{ path: string; method: string }> = [];
    const originalFetch = globalThis.fetch;
    let sentEventBody: Record<string, unknown> | null = null;

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      fetchCalls.push({ path: `${url.pathname}${url.search}`, method: init?.method ?? "GET" });

      if (url.pathname === "/_matrix/media/v3/upload") {
        const uploadBody = init?.body;
        expect(uploadBody).toBeInstanceOf(Uint8Array);
        expect(url.searchParams.get("filename")).toBe("agent-response-queue_123.md");
        return new Response(JSON.stringify({ content_uri: "mxc://example.org/upload123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.pathname.includes("/send/m.room.message/")) {
        sentEventBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ event_id: "$event-upload" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const eventId = await sendLargeMessageAsAttachment(
        { homeserverUrl: "https://matrix.example", accessToken: "token" },
        "!room:example.org",
        { body: "# Big markdown payload", format: "markdown" },
        "queue/123",
      );

      expect(eventId).toBe("$event-upload");
      expect(fetchCalls).toHaveLength(2);
      expect(fetchCalls[0]).toEqual({
        path: "/_matrix/media/v3/upload?filename=agent-response-queue_123.md",
        method: "POST",
      });
      expect(fetchCalls[1]?.method).toBe("PUT");
      expect(sentEventBody).not.toBeNull();
      expect(String(sentEventBody?.["msgtype"])).toBe("m.file");
      expect(String(sentEventBody?.["url"])).toBe("mxc://example.org/upload123");
      expect(String(sentEventBody?.["body"])).toBe("agent-response-queue_123.md");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sendReadReceipt posts m.read receipt for event", async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<{ path: string; method: string; body: string | undefined }> = [];

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      fetchCalls.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await sendReadReceipt(
        { homeserverUrl: "https://matrix.example", accessToken: "token" },
        "!room:example.org",
        "$event:example.org",
      );

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]).toEqual({
        path: "/_matrix/client/v3/rooms/!room%3Aexample.org/receipt/m.read/%24event%3Aexample.org",
        method: "POST",
        body: "{}",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
