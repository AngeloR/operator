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

  test("rejects unavailable harness adapters at project resolution", () => {
    expect(() =>
      resolveProjectHarnessAdapter("alpha", {
        roomId: "!alpha:example.org",
        harness: "codex",
      }),
    ).toThrow(
      'project "alpha" uses harness "codex", but it is not available yet: Codex adapter not implemented yet (planned for Phase 4)',
    );

    expect(() =>
      resolveProjectHarnessAdapter("beta", {
        roomId: "!beta:example.org",
        harness: "claude",
      }),
    ).toThrow(
      'project "beta" uses harness "claude", but it is not available yet: Claude adapter not implemented yet (planned for Phase 4)',
    );
  });
});
