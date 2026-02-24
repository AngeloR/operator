import { spawn } from "node:child_process";
import {
  appendCapturedOutput,
  appendStreamText,
  extractJsonLinesText,
  parseOpenCodeStreamEvent,
  tryDecodeJsonMessageText,
} from "../opencode-stream";
import { logEvent } from "../metrics";
import { nonEmptyText } from "../text";
import {
  type AutoOpenCodeProject,
  type AutoOpenCodeStreamHandlers,
} from "../worker/auto-opencode";

export type CommandRunResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
};

export type CommandStreamHandlers = {
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
};

type PreparedAutoOpenCodeCommand = {
  command: string[];
};

export class AutoOpenCodeStoppedError extends Error {
  readonly requestedBy: string | null;

  constructor(requestedBy: string | null) {
    super("OpenCode job stopped by user request");
    this.name = "AutoOpenCodeStoppedError";
    this.requestedBy = requestedBy;
  }
}

function isCommandOptionToken(
  token: string,
  longName: string,
  shortName?: string,
): boolean {
  if (token === `--${longName}` || token.startsWith(`--${longName}=`)) {
    return true;
  }

  if (!shortName) {
    return false;
  }

  return token === `-${shortName}` || token.startsWith(`-${shortName}=`);
}

function commandHasOption(
  command: string[],
  longName: string,
  shortName?: string,
): boolean {
  for (const token of command) {
    if (isCommandOptionToken(token, longName, shortName)) {
      return true;
    }
  }
  return false;
}

export function isOpenCodeRunCommand(command: string[]): boolean {
  const executable = command[0];
  if (!executable) {
    return false;
  }

  const normalized = executable.replace(/\\/g, "/");
  const fileName = normalized.split("/").pop()?.toLowerCase();
  if (fileName !== "opencode" && fileName !== "opencode.exe") {
    return false;
  }

  return command.some((token) => token === "run" || token === "r");
}

function prepareAutoOpenCodeCommand(
  command: string[],
  verbosity: AutoOpenCodeProject["verbosity"],
  modelOverride?: string,
): PreparedAutoOpenCodeCommand {
  if (!isOpenCodeRunCommand(command)) {
    throw new Error("autoOpenCodeCommand must invoke `opencode run`");
  }

  const prepared: PreparedAutoOpenCodeCommand = {
    command: [...command],
  };

  if (!commandHasOption(prepared.command, "format", "f")) {
    prepared.command.push("--format", "json");
  }

  const needsThinking = verbosity === "thinking" || verbosity === "thinking-complete";
  if (needsThinking && !commandHasOption(prepared.command, "thinking")) {
    prepared.command.push("--thinking");
  }

  if (modelOverride && !commandHasOption(prepared.command, "model", "m")) {
    prepared.command.push("--model", modelOverride);
  }

  return prepared;
}

export async function runCommandWithInput(
  command: string[],
  cwd: string,
  input: string,
  timeoutMs: number | null,
  handlers?: CommandStreamHandlers,
  abortSignal?: AbortSignal,
): Promise<CommandRunResult> {
  const executable = command[0];
  if (!executable) {
    throw new Error("command must include an executable");
  }

  return new Promise<CommandRunResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child: any = spawn(executable, command.slice(1), {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const terminateChild = (reason: "timeout" | "abort"): void => {
      if (reason === "timeout") {
        timedOut = true;
      }
      if (reason === "abort") {
        aborted = true;
      }

      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
      }, 1000).unref();
    };

    let timeout: NodeJS.Timeout | null = null;
    if (timeoutMs !== null) {
      timeout = setTimeout(() => {
        terminateChild("timeout");
      }, timeoutMs);

      timeout.unref();
    }

    const onAbort = () => {
      terminateChild("abort");
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("error", (error: Error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      settle(() => reject(error));
    });

    child.stdout.on("data", (chunk: string | Buffer) => {
      const text = chunk.toString();
      stdout = appendCapturedOutput(stdout, text);
      try {
        handlers?.onStdoutChunk?.(text);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        logEvent("warn", "command.stdout_handler.failed", {
          error: detail,
        });
      }
    });

    child.stderr.on("data", (chunk: string | Buffer) => {
      const text = chunk.toString();
      stderr = appendCapturedOutput(stderr, text);
      try {
        handlers?.onStderrChunk?.(text);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        logEvent("warn", "command.stderr_handler.failed", {
          error: detail,
        });
      }
    });

    child.stdin.on("error", () => {});
    child.stdin.end(input);

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      settle(() =>
        resolve({
          stdout,
          stderr,
          code,
          signal,
          timedOut,
          aborted,
        })
      );
    });
  });
}

export async function runAutoOpenCodePrompt(
  prompt: string,
  autoProject: AutoOpenCodeProject,
  handlers?: AutoOpenCodeStreamHandlers,
  abortSignal?: AbortSignal,
): Promise<string> {
  const prepared = prepareAutoOpenCodeCommand(
    autoProject.command,
    autoProject.verbosity,
    autoProject.model,
  );

  let stdoutLineBuffer = "";
  let streamedText = "";
  let streamedReasoningText = "";
  let streamedOutputText = "";
  let streamError: string | null = null;

  const parseStdoutLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(trimmed) as unknown;
    } catch {
      return;
    }

    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return;
    }

    const obj = payload as Record<string, unknown>;
    const event = parseOpenCodeStreamEvent(obj);
    if (event.phase) {
      handlers?.onStreamPhase?.(event.phase);
    }

    if (event.reasoningTitle) {
      handlers?.onThinkingTitle?.(event.reasoningTitle);
    }

    if (event.text) {
      streamedText = appendStreamText(streamedText, event.text);
      if (event.isReasoning) {
        streamedReasoningText = appendStreamText(streamedReasoningText, event.text);
      } else {
        streamedOutputText = appendStreamText(streamedOutputText, event.text);
      }
      handlers?.onStreamText?.(event.text, event.isReasoning);
    }

    if (event.error && !streamError) {
      streamError = event.error;
    }
  };

  const commandStreamHandlers: CommandStreamHandlers = {
    onStdoutChunk: (chunk: string) => {
      stdoutLineBuffer += chunk;
      while (true) {
        const newlineIndex = stdoutLineBuffer.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }

        const line = stdoutLineBuffer.slice(0, newlineIndex);
        stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
        parseStdoutLine(line);
      }
    },
  };

  const result = await runCommandWithInput(
    prepared.command,
    autoProject.cwd,
    prompt,
    autoProject.timeoutMs,
    commandStreamHandlers,
    abortSignal,
  );

  if (stdoutLineBuffer.trim()) {
    parseStdoutLine(stdoutLineBuffer);
  }

  if (result.timedOut) {
    const timeoutSeconds = autoProject.timeoutMs === null
      ? "unknown"
      : `${Math.round(autoProject.timeoutMs / 1000)}s`;
    throw new Error(
      `command timed out after ${timeoutSeconds}`,
    );
  }

  if (result.aborted) {
    throw new AutoOpenCodeStoppedError(null);
  }

  if (streamError) {
    throw new Error(streamError);
  }

  if (result.code !== 0) {
    const stderr = nonEmptyText(result.stderr);
    const stdout = nonEmptyText(result.stdout);
    const signalInfo = result.signal ? ` (signal ${result.signal})` : "";
    throw new Error(
      `command exited with code ${result.code ?? "null"}${signalInfo}${
        stderr ? `: ${stderr}` : ""
      }${!stderr && stdout ? `: ${stdout}` : ""}`,
    );
  }

  const output = nonEmptyText(streamedOutputText) ??
    nonEmptyText(streamedReasoningText) ??
    nonEmptyText(streamedText) ??
    extractJsonLinesText(result.stdout) ??
    tryDecodeJsonMessageText(result.stdout) ??
    nonEmptyText(result.stdout);

  if (!output) {
    throw new Error("command produced no final output");
  }

  return output;
}
