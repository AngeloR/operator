import { type MessageFormat } from "../text";
import { type QueueEnvelope } from "../types/contracts";
import { type Harness, type ProjectConfig } from "./config";
import { claudeAdapter } from "./claude-adapter";
import { codexAdapter } from "./codex-adapter";

export type HarnessRunInput = {
  projectKey: string;
  project: ProjectConfig;
  envelope: QueueEnvelope;
};

export type HarnessRunOutput = {
  body: string;
  format: MessageFormat;
  agent?: string;
};

export type HarnessAdapter = {
  harness: Harness;
  available: boolean;
  unavailableReason?: string;
  validateProjectConfig: (projectKey: string, project: ProjectConfig) => void;
  run?: (input: HarnessRunInput) => Promise<HarnessRunOutput>;
  parseStreamEvent?: (payload: unknown) => unknown;
  handleRoomCommand?: (input: {
    projectKey: string;
    project: ProjectConfig;
    sender: string;
    body: string;
  }) => Promise<string | null>;
};

const HARNESS_REGISTRY: Record<Harness, HarnessAdapter> = {
  opencode: {
    harness: "opencode",
    available: true,
    validateProjectConfig: () => {},
  },
  codex: codexAdapter,
  claude: claudeAdapter,
};

export function resolveHarnessAdapter(harness: Harness): HarnessAdapter {
  return HARNESS_REGISTRY[harness];
}

export function resolveProjectHarnessAdapter(
  projectKey: string,
  project: ProjectConfig,
): HarnessAdapter {
  const harness = project.harness ?? "opencode";
  const adapter = resolveHarnessAdapter(harness);
  adapter.validateProjectConfig(projectKey, project);

  if (!adapter.available) {
    throw new Error(
      `project "${projectKey}" uses harness "${harness}", but it is not available yet: ${adapter.unavailableReason ?? "adapter unavailable"}`,
    );
  }

  return adapter;
}
