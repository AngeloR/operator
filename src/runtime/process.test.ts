import { describe, expect, test } from "bun:test";
import { isOpenCodeRunCommand, runCommandWithInput } from "./process";

describe("runtime/process", () => {
  test("detects OpenCode run invocations", () => {
    expect(isOpenCodeRunCommand(["opencode", "run"])).toBe(true);
    expect(isOpenCodeRunCommand(["/usr/local/bin/opencode", "r"])).toBe(true);
    expect(isOpenCodeRunCommand(["opencode", "models"])).toBe(false);
  });

  test("runCommandWithInput returns stdout on success", async () => {
    const result = await runCommandWithInput(
      ["bun", "-e", "const data = await Bun.stdin.text(); process.stdout.write(data.toUpperCase());"],
      process.cwd(),
      "hello",
      1000,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("HELLO");
    expect(result.timedOut).toBe(false);
  });

  test("runCommandWithInput marks timeout paths", async () => {
    const result = await runCommandWithInput(
      ["bun", "-e", "setTimeout(() => process.stdout.write('late'), 250);"],
      process.cwd(),
      "",
      25,
    );

    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  test("runCommandWithInput rejects invalid executables", async () => {
    await expect(
      runCommandWithInput(["definitely-not-a-real-executable"], process.cwd(), "", 1000),
    ).rejects.toThrow();
  });
});
