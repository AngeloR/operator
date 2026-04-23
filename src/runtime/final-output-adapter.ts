import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { nonEmptyText } from "../text";
import { runCommandWithInput } from "./process";
import { type HarnessAdapter, type HarnessRunOutput } from "./harness";

const DEFAULT_TIMEOUT_SECONDS = 300;

export function createFinalOutputAdapter(harness: "codex" | "claude"): HarnessAdapter {
  return {
    harness,
    available: true,
    validateProjectConfig: (projectKey, project) => {
      const command = parseRequiredCommand(project.command, harness);
      const cwd = parseProjectWorkingDirectory(project.projectWorkingDirectory, harness);
      parseTimeoutSeconds(project.timeoutSeconds, harness);

      const senderAllowlist = project.senderAllowlist;
      if (!Array.isArray(senderAllowlist) || senderAllowlist.length === 0) {
        throw new Error(
          `project "${projectKey}" (${harness}) must define senderAllowlist with at least one user ID`,
        );
      }

      const executable = command[0] ?? "";
      assertExecutableAvailable(projectKey, harness, executable);

      if (!cwd) {
        throw new Error(
          `project "${projectKey}" (${harness}) has invalid projectWorkingDirectory`,
        );
      }
    },
    run: async ({ project, projectKey, envelope }): Promise<HarnessRunOutput> => {
      const command = parseRequiredCommand(project.command, harness);
      const cwd = parseProjectWorkingDirectory(project.projectWorkingDirectory, harness);
      const timeoutMs = parseTimeoutSeconds(project.timeoutSeconds, harness) * 1000;

      const result = await runCommandWithInput(
        command,
        cwd,
        envelope.body,
        timeoutMs === 0 ? null : timeoutMs,
      );

      if (result.timedOut) {
        throw new Error(`${harness} command timed out after ${timeoutMs / 1000}s`);
      }

      if (result.code !== 0) {
        const stderr = nonEmptyText(result.stderr);
        const stdout = nonEmptyText(result.stdout);
        const signalInfo = result.signal ? ` (signal ${result.signal})` : "";
        throw new Error(
          `${harness} command exited with code ${result.code ?? "null"}${signalInfo}${
            stderr ? `: ${stderr}` : ""
          }${!stderr && stdout ? `: ${stdout}` : ""}`,
        );
      }

      const output = nonEmptyText(result.stdout) ?? nonEmptyText(result.stderr);
      if (!output) {
        throw new Error(`${harness} command produced no output`);
      }

      return {
        body: output,
        format: "markdown",
        agent: nonEmptyText(project.agent) ?? harness,
      };
    },
  };
}

function parseRequiredCommand(value: unknown, harness: "codex" | "claude"): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${harness} projects must define command as an array of strings`);
  }

  const command = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);

  if (command.length === 0) {
    throw new Error(`${harness} projects must define a non-empty command`);
  }

  return command;
}

function parseProjectWorkingDirectory(value: unknown, harness: "codex" | "claude"): string {
  if (value === undefined) {
    return process.cwd();
  }

  const parsed = nonEmptyText(value);
  if (!parsed) {
    throw new Error(`${harness} projectWorkingDirectory must be a non-empty string`);
  }

  return resolve(parsed);
}

function parseTimeoutSeconds(value: unknown, harness: "codex" | "claude"): number {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_SECONDS;
  }

  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 3600) {
    throw new Error(
      `${harness} timeoutSeconds must be an integer between 0 and 3600 (0 disables timeout)`,
    );
  }

  return n;
}

function assertExecutableAvailable(
  projectKey: string,
  harness: "codex" | "claude",
  executable: string,
): void {
  const probe = spawnSync(executable, ["--version"], {
    stdio: "ignore",
  }) as { error?: NodeJS.ErrnoException };

  if (probe.error?.code === "ENOENT") {
    throw new Error(
      `project "${projectKey}" (${harness}) command executable not found: ${executable}`,
    );
  }
}
