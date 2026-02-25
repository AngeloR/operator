import { describe, expect, test } from "bun:test";
import {
  buildRoomToProjectMap,
  parseAdminUserIds,
  parseAgentApiTokens,
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
});
