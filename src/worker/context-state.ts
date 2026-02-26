import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tailLines, truncateText } from "../text";
import { type QueueEnvelope } from "../types/contracts";
import { type AutoOpenCodeProject } from "./auto-opencode";

export type AutoOpenCodeStatePaths = {
  rootDir: string;
  inboxLogPath: string;
  outboxLogPath: string;
  rollingSummaryPath: string;
  currentContextPath: string;
};

type ContextLimits = {
  maxMessageChars: number;
  maxContextChars: number;
};

function resolveAutoOpenCodeStatePaths(autoProject: AutoOpenCodeProject): AutoOpenCodeStatePaths {
  const rootDir = join(autoProject.stateDir, autoProject.projectKey, autoProject.agent);
  return {
    rootDir,
    inboxLogPath: join(rootDir, "inbox.log"),
    outboxLogPath: join(rootDir, "outbox.log"),
    rollingSummaryPath: join(rootDir, "rolling-summary.md"),
    currentContextPath: join(rootDir, "current-context.md"),
  };
}

async function readTextFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function ensureAutoOpenCodeState(autoProject: AutoOpenCodeProject): Promise<AutoOpenCodeStatePaths> {
  const paths = resolveAutoOpenCodeStatePaths(autoProject);
  await mkdir(paths.rootDir, { recursive: true });
  return paths;
}

export async function appendTurnLog(
  path: string,
  timestamp: string,
  actor: string,
  body: string,
): Promise<void> {
  const entry = `[${timestamp}] ${actor}\n${body}\n\n`;
  await appendFile(path, entry, "utf8");
}

async function buildRollingSummary(
  paths: AutoOpenCodeStatePaths,
  autoProject: AutoOpenCodeProject,
  limits: ContextLimits,
): Promise<string> {
  const inbox = await readTextFileOrEmpty(paths.inboxLogPath);
  const outbox = await readTextFileOrEmpty(paths.outboxLogPath);
  const inboxTail = tailLines(inbox, autoProject.contextTailLines);
  const outboxTail = tailLines(outbox, autoProject.contextTailLines);

  const summary = [
    "# Rolling Conversation Summary",
    "",
    `Project: ${autoProject.projectKey}`,
    `Agent: ${autoProject.agent}`,
    "",
    "## Recent Incoming",
    inboxTail || "(none)",
    "",
    "## Recent Outgoing",
    outboxTail || "(none)",
  ].join("\n");

  const truncated = truncateText(summary, limits.maxContextChars);
  await writeFile(paths.rollingSummaryPath, truncated, "utf8");
  return truncated;
}

function buildCurrentContext(
  envelope: QueueEnvelope,
  summary: string,
  jobId: string,
  limits: ContextLimits,
): string {
  const userBody = truncateText(envelope.body, limits.maxMessageChars);
  return truncateText(
    [
      "# Matrix Task",
      "",
      `Job ID: ${jobId}`,
      `Project: ${envelope.projectKey}`,
      `Room: ${envelope.roomId}`,
      `Sender: ${envelope.sender ?? "unknown"}`,
      `Received At: ${envelope.receivedAt}`,
      `Event ID: ${envelope.id}`,
      "",
      "## Current User Message",
      userBody,
      "",
      "---",
      "",
      summary,
      "",
      "---",
      "",
      "Respond to the user in a concise, actionable way.",
    ].join("\n"),
    limits.maxContextChars,
  );
}

export async function prepareAutoOpenCodeContext(
  envelope: QueueEnvelope,
  autoProject: AutoOpenCodeProject,
  jobId: string,
  limits: ContextLimits,
): Promise<{ paths: AutoOpenCodeStatePaths; context: string }> {
  const paths = await ensureAutoOpenCodeState(autoProject);
  await appendTurnLog(
    paths.inboxLogPath,
    envelope.receivedAt,
    envelope.sender ?? "unknown",
    truncateText(envelope.body, limits.maxMessageChars),
  );

  const summary = await buildRollingSummary(paths, autoProject, limits);
  const context = buildCurrentContext(envelope, summary, jobId, limits);
  await writeFile(paths.currentContextPath, context, "utf8");
  return { paths, context };
}
