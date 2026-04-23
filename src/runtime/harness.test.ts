import { describe, expect, test } from "bun:test";
import {
  resolveHarnessAdapter,
  resolveProjectHarnessAdapter,
} from "./harness";

describe("runtime/harness", () => {
  test("resolves opencode adapter", () => {
    const adapter = resolveHarnessAdapter("opencode");
    expect(adapter.harness).toBe("opencode");
    expect(adapter.available).toBe(true);
  });

  test("resolves codex and claude adapters", () => {
    const codex = resolveProjectHarnessAdapter("alpha", {
      roomId: "!alpha:example.org",
      harness: "codex",
      senderAllowlist: ["@alice:example.org"],
      command: ["bun", "-e", "process.stdout.write('ok')"],
    });

    const claude = resolveProjectHarnessAdapter("beta", {
      roomId: "!beta:example.org",
      harness: "claude",
      senderAllowlist: ["@bob:example.org"],
      command: ["bun", "-e", "process.stdout.write('ok')"],
    });

    expect(codex.harness).toBe("codex");
    expect(codex.available).toBe(true);
    expect(typeof codex.run).toBe("function");
    expect(claude.harness).toBe("claude");
    expect(claude.available).toBe(true);
    expect(typeof claude.run).toBe("function");
  });
});
