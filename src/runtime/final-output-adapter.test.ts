import { describe, expect, test } from "bun:test";
import { resolveProjectHarnessAdapter } from "./harness";

function baseEnvelope() {
  return {
    id: "evt-1",
    projectKey: "alpha",
    roomId: "!alpha:example.org",
    body: "hello",
    format: "plain" as const,
    sender: "@alice:example.org",
    receivedAt: new Date().toISOString(),
  };
}

describe("runtime/final-output-adapter", () => {
  test("codex adapter returns final output", async () => {
    const adapter = resolveProjectHarnessAdapter("alpha", {
      roomId: "!alpha:example.org",
      harness: "codex",
      senderAllowlist: ["@alice:example.org"],
      command: ["bun", "-e", "const input = await Bun.stdin.text(); process.stdout.write(input.toUpperCase())"],
    });

    if (!adapter.run) {
      throw new Error("expected codex adapter run implementation");
    }

    const result = await adapter.run({
      projectKey: "alpha",
      project: {
        roomId: "!alpha:example.org",
        harness: "codex",
        senderAllowlist: ["@alice:example.org"],
        command: ["bun", "-e", "const input = await Bun.stdin.text(); process.stdout.write(input.toUpperCase())"],
      },
      envelope: baseEnvelope(),
    });

    expect(result.body).toBe("HELLO");
    expect(result.format).toBe("markdown");
    expect(result.agent).toBe("codex");
  });

  test("claude adapter returns final output", async () => {
    const adapter = resolveProjectHarnessAdapter("beta", {
      roomId: "!beta:example.org",
      harness: "claude",
      senderAllowlist: ["@alice:example.org"],
      command: ["bun", "-e", "const input = await Bun.stdin.text(); process.stdout.write(input + ' world')"],
    });

    if (!adapter.run) {
      throw new Error("expected claude adapter run implementation");
    }

    const result = await adapter.run({
      projectKey: "beta",
      project: {
        roomId: "!beta:example.org",
        harness: "claude",
        senderAllowlist: ["@alice:example.org"],
        command: ["bun", "-e", "const input = await Bun.stdin.text(); process.stdout.write(input + ' world')"],
      },
      envelope: baseEnvelope(),
    });

    expect(result.body).toBe("hello world");
    expect(result.format).toBe("markdown");
    expect(result.agent).toBe("claude");
  });

  test("codex adapter requires command", () => {
    expect(() =>
      resolveProjectHarnessAdapter("alpha", {
        roomId: "!alpha:example.org",
        harness: "codex",
        senderAllowlist: ["@alice:example.org"],
      }),
    ).toThrow("codex projects must define command as an array of strings");
  });

  test("claude adapter reports missing executable", () => {
    expect(() =>
      resolveProjectHarnessAdapter("alpha", {
        roomId: "!alpha:example.org",
        harness: "claude",
        senderAllowlist: ["@alice:example.org"],
        command: ["definitely-not-a-real-executable"],
      }),
    ).toThrow(
      'project "alpha" (claude) command executable not found: definitely-not-a-real-executable',
    );
  });
});
