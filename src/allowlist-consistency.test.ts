import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const rootDir = process.cwd();

describe("CLI allowlist consistency", () => {
  test("config example includes !op start in allowedCliCommands", async () => {
    const raw = await readFile(join(rootDir, "config.example.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      projects?: Record<string, { allowedCliCommands?: string[] }>;
    };

    const commands = parsed.projects?.operator?.allowedCliCommands ?? [];
    expect(commands).toContain("start");
  });

  test("runtime allowlist validation includes start", async () => {
    const source = await readFile(join(rootDir, "src", "index.ts"), "utf8");
    expect(source).toContain("allowedCliCommands entries must be one of: usage, stats, models, model, start, help");
    expect(source).toContain("DEFAULT_AUTO_OPENCODE_ALLOWED_CLI_COMMANDS = [\"usage\", \"stats\", \"models\", \"model\", \"start\", \"help\"]");
  });
});
