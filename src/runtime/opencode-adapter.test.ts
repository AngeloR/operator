import { describe, expect, test } from "bun:test";
import { OpenCodeAdapter } from "./opencode-adapter";
import { type AppConfig, type ProjectConfig } from "./config";

function createAdapter(projects: Record<string, ProjectConfig> = {}) {
  const appConfig: AppConfig = {
    homeserverUrl: "https://matrix.example.org",
    accessToken: "token",
    projects,
  };

  let currentProjects = projects;
  return new OpenCodeAdapter({
    configPath: "/tmp/config.json",
    appConfig,
    getProjects: () => currentProjects,
    setProjects: (nextProjects) => {
      currentProjects = nextProjects;
    },
  });
}

describe("runtime/opencode-adapter", () => {
  test("buildProjectsByQueue applies default opencode command", () => {
    const adapter = createAdapter();
    const byQueue = adapter.buildProjectsByQueue({
      alpha: {
        roomId: "!alpha:example.org",
        senderAllowlist: ["@alice:example.org"],
      },
    });

    expect(byQueue.size).toBe(1);
    const [queue, project] = [...byQueue.entries()][0] ?? [];
    expect(queue).toBe("alpha:user");
    expect(project?.command).toEqual(["opencode", "run"]);
    expect(project?.commandPrefix).toBe("!op");
  });

  test("isStopMessage keeps legacy aliases", () => {
    const adapter = createAdapter();
    expect(adapter.isStopMessage("stop")).toBe(true);
    expect(adapter.isStopMessage("!stop")).toBe(true);
    expect(adapter.isStopMessage("!op stop")).toBe(true);
    expect(adapter.isStopMessage("continue")).toBe(false);
  });

  test("buildProjectsByQueue rejects non-opencode command", () => {
    const adapter = createAdapter();

    expect(() =>
      adapter.buildProjectsByQueue({
        alpha: {
          roomId: "!alpha:example.org",
          senderAllowlist: ["@alice:example.org"],
          command: ["bun", "run"],
        },
      })
    ).toThrow('project "alpha" has invalid command: expected opencode run');
  });
});
