import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildRoomToProjectMap,
  loadConfig,
  parseAdminUserIds,
  parseAgentApiTokens,
  parseProjectHarness,
  resolveProject,
  type AppConfig,
} from "./config";

const BASE_CONFIG: AppConfig = {
  homeserverUrl: "https://matrix.example.org",
  accessToken: "token",
  projects: {},
};

describe("runtime/config", () => {
  test("parseAdminUserIds trims values and drops empties", () => {
    const parsed = parseAdminUserIds([" @a:example.org ", "", "@b:example.org", 123]);
    expect(parsed).toEqual(new Set(["@a:example.org", "@b:example.org"]));
  });

  test("parseAgentApiTokens merges env and config tokens", () => {
    const previousSingle = process.env.AGENT_API_TOKEN;
    const previousMulti = process.env.AGENT_API_TOKENS;
    process.env.AGENT_API_TOKEN = "env-single";
    process.env.AGENT_API_TOKENS = "env-a, env-b";

    try {
      const tokens = parseAgentApiTokens({
        ...BASE_CONFIG,
        agentApiToken: "cfg-single",
        agentApiTokens: ["cfg-a", "cfg-b"],
      });

      expect(tokens).toEqual(
        new Set(["env-single", "env-a", "env-b", "cfg-single", "cfg-a", "cfg-b"]),
      );
    } finally {
      if (previousSingle === undefined) {
        delete process.env.AGENT_API_TOKEN;
      } else {
        process.env.AGENT_API_TOKEN = previousSingle;
      }

      if (previousMulti === undefined) {
        delete process.env.AGENT_API_TOKENS;
      } else {
        process.env.AGENT_API_TOKENS = previousMulti;
      }
    }
  });

  test("buildRoomToProjectMap keeps first duplicate and emits callback", () => {
    const duplicates: string[] = [];
    const map = buildRoomToProjectMap(
      {
        alpha: { roomId: "!same:example.org" },
        beta: { roomId: "!same:example.org" },
      },
      ({ projectKey, previousProjectKey }) => {
        duplicates.push(`${projectKey}->${previousProjectKey}`);
      },
    );

    expect(map.get("!same:example.org")).toBe("alpha");
    expect(duplicates).toEqual(["beta->alpha"]);
  });

  test("resolveProject validates project existence and roomId", () => {
    expect(() => resolveProject({}, "missing")).toThrow("unknown project: missing");
    expect(() => resolveProject({ bad: { roomId: "" } }, "bad")).toThrow(
      'project "bad" has no roomId',
    );
  });

  test("parseProjectHarness defaults to opencode", () => {
    expect(parseProjectHarness(undefined, "alpha")).toBe("opencode");
  });

  test("parseProjectHarness rejects invalid values", () => {
    expect(() => parseProjectHarness("unknown", "alpha")).toThrow(
      'project "alpha" has invalid harness: expected one of opencode, codex, claude',
    );
  });

  test("loadConfig defaults missing project harness to opencode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-agent-config-"));
    const configPath = join(dir, "config.json");

    await writeFile(
      configPath,
      JSON.stringify({
        homeserverUrl: "https://matrix.example.org",
        accessToken: "token",
        projects: {
          alpha: {
            roomId: "!alpha:example.org",
          },
        },
      }),
      "utf8",
    );

    try {
      const projects = await loadConfig(configPath, { ...BASE_CONFIG });
      expect(projects.alpha?.harness).toBe("opencode");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadConfig rejects invalid harness values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-agent-config-"));
    const configPath = join(dir, "config.json");

    await writeFile(
      configPath,
      JSON.stringify({
        homeserverUrl: "https://matrix.example.org",
        accessToken: "token",
        projects: {
          alpha: {
            roomId: "!alpha:example.org",
            harness: "bad-harness",
          },
        },
      }),
      "utf8",
    );

    try {
      await expect(loadConfig(configPath, { ...BASE_CONFIG })).rejects.toThrow(
        'project "alpha" has invalid harness: expected one of opencode, codex, claude',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
