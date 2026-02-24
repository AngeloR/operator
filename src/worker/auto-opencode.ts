import { appendStreamText, formatThinkingStreamDelta } from "../opencode-stream";
import { logEvent, recordFailure, recordProcessingLatency, recordWorkerRestart } from "../metrics";
import { type MessageFormat, truncateInline, truncateText } from "../text";
import { type QueueDirection, type QueueEnvelope, type Redis, type RedisConfig } from "../runtime/redis";

export type AutoOpenCodeVerbosity = "debug" | "thinking" | "thinking-complete" | "output";

export type AutoOpenCodeCliCommand = "usage" | "stats" | "models" | "model" | "start" | "help";

export type ParsedAutoOpenCodeCliRequest = {
  command: AutoOpenCodeCliCommand;
  args: string[];
};

export type AutoOpenCodeProject = {
  projectKey: string;
  roomId: string;
  agent: string;
  model?: string;
  command: string[];
  commandPrefix: string;
  allowedCliCommands: Set<AutoOpenCodeCliCommand>;
  commandTimeoutMs: number;
  timeoutMs: number | null;
  heartbeatMs: number;
  verbosity: AutoOpenCodeVerbosity;
  progressUpdates: boolean;
  stateDir: string;
  cwd: string;
  senderAllowlist: Set<string>;
  ackTemplate: string;
  progressTemplate: string;
  contextTailLines: number;
};

export type AutoOpenCodeStreamHandlers = {
  onStreamPhase?: (phase: string) => void;
  onStreamText?: (text: string, isReasoning: boolean) => void;
  onThinkingTitle?: (title: string) => void;
};

export type ActiveAutoOpenCodeRun = {
  jobId: string;
  roomId: string;
  startedAt: number;
  sender: string;
  abortController: AbortController;
  stopRequestedBy: string | null;
};

export type RunAutoOpenCodeProjectWorkerOptions = {
  autoOpenCodeRedis: Redis;
  userQueue: string;
  autoProject: AutoOpenCodeProject;
  constants: {
    maxMessageChars: number;
    maxContextChars: number;
    infiniteTimeoutHeartbeatMs: number;
    streamUpdateMinIntervalMs: number;
    streamUpdateMinChars: number;
    streamPreviewMaxChars: number;
  };
  deps: {
    parseEnvelope: (raw: string, fallbackProjectKey: string, fallbackRoomId: string) => QueueEnvelope;
    queueKey: (projectKey: string, direction: QueueDirection) => string;
    markAndCheckDuplicate: (projectDedup: Map<string, number>, eventId: string) => boolean;
    parseAutoOpenCodeCliRequest: (
      body: string,
      commandPrefix: string,
    ) => ParsedAutoOpenCodeCliRequest | null;
    executeAutoOpenCodeCliCommand: (
      request: ParsedAutoOpenCodeCliRequest,
      autoProject: AutoOpenCodeProject,
    ) => Promise<string>;
    enqueueAutoOpenCodeMessage: (
      redis: Redis,
      autoProject: AutoOpenCodeProject,
      body: string,
      format: MessageFormat,
    ) => Promise<QueueEnvelope>;
    enqueueAutoOpenCodeStatus: (
      redis: Redis,
      autoProject: AutoOpenCodeProject,
      template: string,
      phase: string,
      jobId: string,
      sender: string,
    ) => Promise<QueueEnvelope>;
    prepareAutoOpenCodeContext: (
      envelope: QueueEnvelope,
      autoProject: AutoOpenCodeProject,
      jobId: string,
    ) => Promise<{ paths: { outboxLogPath: string }; context: string }>;
    isOpenCodeRunCommand: (command: string[]) => boolean;
    runAutoOpenCodePrompt: (
      prompt: string,
      autoProject: AutoOpenCodeProject,
      handlers?: AutoOpenCodeStreamHandlers,
      abortSignal?: AbortSignal,
    ) => Promise<string>;
    appendTurnLog: (
      targetPath: string,
      timestamp: string,
      speaker: string,
      text: string,
    ) => Promise<void>;
    setActiveRun: (projectKey: string, run: ActiveAutoOpenCodeRun) => void;
    getStopRequestedBy: (projectKey: string) => string | null;
    clearActiveRun: (projectKey: string, jobId: string) => void;
    isStoppedError: (error: unknown) => boolean;
  };
};

export async function runAutoOpenCodeProjectWorker(
  options: RunAutoOpenCodeProjectWorkerOptions,
): Promise<never> {
  const { autoOpenCodeRedis, userQueue, autoProject, constants, deps } = options;
  const projectDedup = new Map<string, number>();

  while (true) {
    try {
      const popped = await autoOpenCodeRedis.blpop(userQueue, 5);
      if (popped === null || popped.length < 2) {
        continue;
      }

      const poppedQueue = popped[0];
      const rawPayload = popped[1];

      if (poppedQueue !== userQueue) {
        recordFailure("auto_opencode_unexpected_queue", autoProject.projectKey);
        logEvent("error", "auto_opencode.queue.unexpected", {
          projectKey: autoProject.projectKey,
          queue: poppedQueue,
          expectedQueue: userQueue,
        });
        continue;
      }

      const envelope = deps.parseEnvelope(
        rawPayload,
        autoProject.projectKey,
        autoProject.roomId,
      );
      const agentQueue = deps.queueKey(autoProject.projectKey, "agent");
      const sender = envelope.sender ?? "unknown";

      if (!envelope.sender || !autoProject.senderAllowlist.has(envelope.sender)) {
        logEvent("info", "auto_opencode.message.skipped", {
          projectKey: autoProject.projectKey,
          queue: poppedQueue,
          sender,
          reason: "sender_not_allowlisted",
          queuedUserEventId: envelope.id,
        });
        continue;
      }

      if (deps.markAndCheckDuplicate(projectDedup, envelope.id)) {
        logEvent("info", "auto_opencode.message.skipped", {
          projectKey: autoProject.projectKey,
          queue: poppedQueue,
          sender,
          reason: "duplicate_event",
          queuedUserEventId: envelope.id,
        });
        continue;
      }

      const cliRequest = deps.parseAutoOpenCodeCliRequest(
        envelope.body,
        autoProject.commandPrefix,
      );
      if (cliRequest) {
        const startedAt = Date.now();
        try {
          const response = await deps.executeAutoOpenCodeCliCommand(cliRequest, autoProject);
          const outbound = await deps.enqueueAutoOpenCodeMessage(
            autoOpenCodeRedis,
            autoProject,
            truncateText(response, constants.maxContextChars),
            "markdown",
          );
          const durationMs = Date.now() - startedAt;
          recordProcessingLatency("auto_opencode_cli", durationMs);
          logEvent("info", "auto_opencode.cli.completed", {
            projectKey: autoProject.projectKey,
            queue: poppedQueue,
            sender,
            durationMs,
            command: cliRequest.command,
            queuedUserEventId: envelope.id,
            queuedAgentEventId: outbound.id,
          });
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : "OpenCode command failed";
          const durationMs = Date.now() - startedAt;
          recordFailure("auto_opencode_cli", autoProject.projectKey);
          recordProcessingLatency("auto_opencode_cli", durationMs);
          const outbound = await deps.enqueueAutoOpenCodeMessage(
            autoOpenCodeRedis,
            autoProject,
            `OpenCode command failed: ${detail}`,
            "plain",
          );
          logEvent("warn", "auto_opencode.cli.failed", {
            projectKey: autoProject.projectKey,
            queue: poppedQueue,
            sender,
            durationMs,
            command: cliRequest.command,
            queuedUserEventId: envelope.id,
            queuedAgentEventId: outbound.id,
            error: detail,
          });
        }
        continue;
      }

      const jobId = crypto.randomUUID();
      const startedAt = Date.now();
      const debugStatusEnabled =
        autoProject.verbosity === "debug" && autoProject.progressUpdates;
      const streamPreviewEnabled =
        autoProject.verbosity !== "output" && autoProject.progressUpdates;
      const streamPhaseEventsEnabled =
        autoProject.verbosity === "debug" && autoProject.progressUpdates;
      const abortController = new AbortController();

      deps.setActiveRun(autoProject.projectKey, {
        jobId,
        roomId: autoProject.roomId,
        startedAt,
        sender,
        abortController,
        stopRequestedBy: null,
      });

      try {
        let ack: QueueEnvelope | null = null;
        if (autoProject.verbosity === "debug") {
          ack = await deps.enqueueAutoOpenCodeStatus(
            autoOpenCodeRedis,
            autoProject,
            autoProject.ackTemplate,
            "started",
            jobId,
            sender,
          );
        } else if (autoProject.verbosity === "output") {
          ack = await deps.enqueueAutoOpenCodeMessage(
            autoOpenCodeRedis,
            autoProject,
            "Received.",
            "plain",
          );
        }

        if (debugStatusEnabled) {
          await deps.enqueueAutoOpenCodeStatus(
            autoOpenCodeRedis,
            autoProject,
            autoProject.progressTemplate,
            "planning",
            jobId,
            sender,
          );
        }

        const { paths, context } = await deps.prepareAutoOpenCodeContext(
          envelope,
          autoProject,
          jobId,
        );

        if (debugStatusEnabled) {
          await deps.enqueueAutoOpenCodeStatus(
            autoOpenCodeRedis,
            autoProject,
            autoProject.progressTemplate,
            "executing",
            jobId,
            sender,
          );
        }

        const statusPromises = new Set<Promise<void>>();
        const noTimeoutMode = autoProject.timeoutMs === null;
        const isOpenCodeCommand = deps.isOpenCodeRunCommand(autoProject.command);
        const heartbeatIntervalMs = noTimeoutMode
          ? constants.infiniteTimeoutHeartbeatMs
          : autoProject.heartbeatMs;
        const heartbeatEnabled = debugStatusEnabled && heartbeatIntervalMs > 0 &&
          (noTimeoutMode || (!isOpenCodeCommand && autoProject.progressUpdates));

        const queueStatus = (phase: string, source: "heartbeat" | "stream"): void => {
          const pending = deps.enqueueAutoOpenCodeStatus(
            autoOpenCodeRedis,
            autoProject,
            autoProject.progressTemplate,
            phase,
            jobId,
            sender,
          )
            .then(() => undefined)
            .catch((error: unknown) => {
              const detail = error instanceof Error ? error.message : String(error);
              logEvent("warn", "auto_opencode.status.enqueue_failed", {
                projectKey: autoProject.projectKey,
                queue: userQueue,
                sender,
                jobId,
                source,
                error: detail,
              });
            });

          statusPromises.add(pending);
          void pending.finally(() => statusPromises.delete(pending));
        };
        const queueStreamPreview = (preview: string): void => {
          const normalized = preview.replace(/\r\n/g, "\n");
          if (!/\S/.test(normalized)) {
            return;
          }

          for (
            let start = 0;
            start < normalized.length;
            start += constants.maxMessageChars
          ) {
            const chunk = normalized.slice(
              start,
              start + constants.maxMessageChars,
            );
            const pending = deps.enqueueAutoOpenCodeMessage(
              autoOpenCodeRedis,
              autoProject,
              chunk,
              "markdown",
            )
              .then(() => undefined)
              .catch((error: unknown) => {
                const detail = error instanceof Error ? error.message : String(error);
                logEvent("warn", "auto_opencode.stream.enqueue_failed", {
                  projectKey: autoProject.projectKey,
                  queue: userQueue,
                  sender,
                  jobId,
                  error: detail,
                });
              });

            statusPromises.add(pending);
            void pending.finally(() => statusPromises.delete(pending));
          }
        };

        let heartbeatTimer: NodeJS.Timeout | null = null;
        if (heartbeatEnabled) {
          heartbeatTimer = setInterval(() => {
            const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
            const phase = noTimeoutMode
              ? `heartbeat (${elapsedSeconds}s elapsed; timeout=0)`
              : `heartbeat (${elapsedSeconds}s elapsed)`;
            queueStatus(phase, "heartbeat");
          }, heartbeatIntervalMs);
          heartbeatTimer.unref();
        }

        let streamText = "";
        let streamReasoningText = "";
        let latestStreamPhase = "executing";
        let lastStreamSentPhase: string | null = null;
        let lastStreamSentAt = 0;
        let lastStreamSentChars = 0;
        const thinkingTitlesSent = new Set<string>();

        const queueThinkingTitle = (title: string): void => {
          const normalized = title.replace(/\s+/g, " ").trim();
          if (!normalized) {
            return;
          }

          const clipped = truncateInline(normalized, 180);
          if (thinkingTitlesSent.has(clipped)) {
            return;
          }

          thinkingTitlesSent.add(clipped);
          queueStreamPreview(clipped);
          const now = Date.now();
          lastStreamSentPhase = latestStreamPhase;
          lastStreamSentAt = now;
          lastStreamSentChars = streamText.length;
        };

        const maybeSendStreamUpdate = (force: boolean): void => {
          if (!streamPreviewEnabled) {
            return;
          }

          if (autoProject.verbosity === "thinking") {
            if (force && thinkingTitlesSent.size === 0 && /\S/.test(streamReasoningText)) {
              const fallbackTitle = streamReasoningText
                .replace(/\r\n/g, "\n")
                .split(/\n{2,}/)[0]
                ?.split("\n")[0]
                ?.trim();
              if (fallbackTitle) {
                queueThinkingTitle(fallbackTitle);
              }
            }
            return;
          }

          const now = Date.now();
          const grownChars = streamText.length - lastStreamSentChars;
          if (!force) {
            if (grownChars < constants.streamUpdateMinChars) {
              return;
            }
            if (now - lastStreamSentAt < constants.streamUpdateMinIntervalMs) {
              return;
            }
          } else if (grownChars <= 0) {
            return;
          }

          if (autoProject.verbosity === "thinking-complete") {
            const delta = formatThinkingStreamDelta(streamText, lastStreamSentChars);
            if (!delta.trim()) {
              lastStreamSentPhase = latestStreamPhase;
              lastStreamSentAt = now;
              lastStreamSentChars = streamText.length;
              return;
            }
            queueStreamPreview(delta);
          } else {
            const preview = streamText
              .slice(Math.max(0, streamText.length - constants.streamPreviewMaxChars))
              .replace(/\s+/g, " ")
              .trim();

            if (!preview) {
              return;
            }

            const previewMessage = truncateInline(preview, 280);
            const phase = `${latestStreamPhase}: ${previewMessage}`;
            queueStatus(phase, "stream");
          }
          lastStreamSentPhase = latestStreamPhase;
          lastStreamSentAt = now;
          lastStreamSentChars = streamText.length;
        };

        let reply = "";
        try {
          reply = await deps.runAutoOpenCodePrompt(
            context,
            autoProject,
            {
              onStreamPhase: (phase: string) => {
                latestStreamPhase = phase;
                if (!streamPhaseEventsEnabled) {
                  return;
                }

                const now = Date.now();
                if (
                  phase !== lastStreamSentPhase &&
                  now - lastStreamSentAt >= constants.streamUpdateMinIntervalMs
                ) {
                  queueStatus(`stream:${phase}`, "stream");
                  lastStreamSentPhase = phase;
                  lastStreamSentAt = now;
                }
              },
              onStreamText: (text: string, isReasoning: boolean) => {
                streamText = appendStreamText(streamText, text);
                if (isReasoning) {
                  streamReasoningText = appendStreamText(streamReasoningText, text);
                }
                maybeSendStreamUpdate(false);
              },
              onThinkingTitle: (title: string) => {
                if (autoProject.verbosity !== "thinking") {
                  return;
                }
                queueThinkingTitle(title);
              },
            },
            abortController.signal,
          );
          maybeSendStreamUpdate(true);
        } finally {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
          }
          if (statusPromises.size > 0) {
            await Promise.allSettled([...statusPromises]);
          }
        }

        const finalText = truncateText(reply, constants.maxContextChars);
        const suppressFinalOutput = autoProject.verbosity === "thinking-complete" &&
          streamPreviewEnabled &&
          /\S/.test(streamText);
        const outbound = suppressFinalOutput
          ? null
          : await deps.enqueueAutoOpenCodeMessage(
            autoOpenCodeRedis,
            autoProject,
            finalText,
            "markdown",
          );

        if (debugStatusEnabled) {
          await deps.enqueueAutoOpenCodeStatus(
            autoOpenCodeRedis,
            autoProject,
            autoProject.progressTemplate,
            "finalizing",
            jobId,
            sender,
          );
        }

        await deps.appendTurnLog(
          paths.outboxLogPath,
          new Date().toISOString(),
          autoProject.agent,
          finalText,
        );

        const durationMs = Date.now() - startedAt;
        recordProcessingLatency("auto_opencode_job", durationMs);
        logEvent("info", "auto_opencode.job.completed", {
          projectKey: autoProject.projectKey,
          queue: poppedQueue,
          sender,
          jobId,
          durationMs,
          agentQueue,
          queuedUserEventId: envelope.id,
          ackEventId: ack?.id ?? null,
          queuedAgentEventId: outbound?.id ?? null,
          suppressedFinalOutput: suppressFinalOutput,
        });
      } catch (error: unknown) {
        const requestedBy = deps.getStopRequestedBy(autoProject.projectKey);

        if (deps.isStoppedError(error)) {
          const durationMs = Date.now() - startedAt;
          recordProcessingLatency("auto_opencode_job", durationMs);
          logEvent("info", "auto_opencode.job.stopped", {
            projectKey: autoProject.projectKey,
            queue: poppedQueue,
            sender,
            jobId,
            durationMs,
            agentQueue,
            queuedUserEventId: envelope.id,
            requestedBy,
          });
          continue;
        }

        const detail =
          error instanceof Error ? error.message : "auto-opencode command failed";
        const durationMs = Date.now() - startedAt;
        recordFailure("auto_opencode_job", autoProject.projectKey);
        recordProcessingLatency("auto_opencode_job", durationMs);

        const failureBody = `OpenCode job ${jobId} failed: ${detail}`;
        const outbound = await deps.enqueueAutoOpenCodeMessage(
          autoOpenCodeRedis,
          autoProject,
          failureBody,
          "plain",
        );
        logEvent("error", "auto_opencode.job.failed", {
          projectKey: autoProject.projectKey,
          queue: poppedQueue,
          sender,
          jobId,
          durationMs,
          agentQueue,
          queuedUserEventId: envelope.id,
          queuedAgentEventId: outbound.id,
          error: detail,
        });
      } finally {
        deps.clearActiveRun(autoProject.projectKey, jobId);
      }
    } catch (error: unknown) {
      const detail =
        error instanceof Error ? error.message : "auto-opencode worker loop failed";
      recordFailure("auto_opencode_worker_loop", autoProject.projectKey);
      logEvent("error", "auto_opencode.worker.loop_error", {
        projectKey: autoProject.projectKey,
        queue: userQueue,
        error: detail,
      });
      await Bun.sleep(1000);
    }
  }
}

export type RunAutoOpenCodeProjectSupervisorOptions = {
  redisConfig: RedisConfig;
  userQueue: string;
  autoProject: AutoOpenCodeProject;
  workerClients: Set<Redis>;
  restartBaseDelayMs: number;
  restartMaxDelayMs: number;
  createRedisClient: (config: RedisConfig) => Promise<Redis>;
  runWorker: (workerRedis: Redis, userQueue: string, autoProject: AutoOpenCodeProject) => Promise<never>;
};

export async function runAutoOpenCodeProjectSupervisor(
  options: RunAutoOpenCodeProjectSupervisorOptions,
): Promise<never> {
  const {
    redisConfig,
    userQueue,
    autoProject,
    workerClients,
    restartBaseDelayMs,
    restartMaxDelayMs,
    createRedisClient,
    runWorker,
  } = options;
  let crashCount = 0;

  while (true) {
    let workerRedis: Redis | null = null;
    try {
      workerRedis = await createRedisClient(redisConfig);
      workerClients.add(workerRedis);
      crashCount = 0;
      await runWorker(workerRedis, userQueue, autoProject);
    } catch (error: unknown) {
      crashCount += 1;
      const detail =
        error instanceof Error ? error.message : "auto-opencode worker crashed";
      recordWorkerRestart(autoProject.projectKey);
      recordFailure("auto_opencode_worker_crash", autoProject.projectKey);
      const backoffMs = Math.min(
        restartMaxDelayMs,
        restartBaseDelayMs * 2 ** Math.min(crashCount - 1, 5),
      );
      logEvent("error", "auto_opencode.worker.crashed", {
        projectKey: autoProject.projectKey,
        queue: userQueue,
        error: detail,
        restartInMs: backoffMs,
        crashCount,
      });
      await Bun.sleep(backoffMs);
    } finally {
      if (workerRedis) {
        workerClients.delete(workerRedis);
        workerRedis.close();
      }
    }
  }
}
