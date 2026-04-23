import { logEvent, recordFailure, recordProcessingLatency, recordWorkerRestart } from "../metrics";
import { parseSenderAllowlist } from "../sender-allowlist";
import { nonEmptyText } from "../text";
import { type ProjectConfig } from "./config";
import { type HarnessAdapter } from "./harness";
import { type Redis, type RedisConfig } from "./redis";
import { type QueueDirection, type QueueEnvelope } from "../types/contracts";

export type FinalOutputWorkerProject = {
  projectKey: string;
  project: ProjectConfig;
  adapter: HarnessAdapter;
};

export type RunFinalOutputProjectWorkerOptions = {
  redis: Redis;
  project: FinalOutputWorkerProject;
  parseEnvelope: (raw: string, fallbackProjectKey: string, fallbackRoomId: string) => QueueEnvelope;
  queueKey: (projectKey: string, direction: QueueDirection) => string;
  createEnvelope: (
    projectKey: string,
    roomId: string,
    body: string,
    format: "plain" | "markdown",
    extras: { agent?: string; sender?: string },
  ) => QueueEnvelope;
};

export async function runFinalOutputProjectWorker(
  options: RunFinalOutputProjectWorkerOptions,
): Promise<never> {
  const { redis, project, parseEnvelope, queueKey, createEnvelope } = options;
  const senderAllowlist = parseSenderAllowlist(project.project.senderAllowlist);
  const userQueue = queueKey(project.projectKey, "user");
  const agentQueue = queueKey(project.projectKey, "agent");

  while (true) {
    try {
      const popped = await redis.blpop(userQueue, 5);
      if (popped === null || popped.length < 2) {
        continue;
      }

      const rawPayload = popped[1];
      const envelope = parseEnvelope(
        rawPayload,
        project.projectKey,
        project.project.roomId,
      );

      if (!envelope.sender || !senderAllowlist.has(envelope.sender)) {
        logEvent("info", "harness.message.skipped", {
          projectKey: project.projectKey,
          harness: project.adapter.harness,
          reason: "sender_not_allowlisted",
          sender: envelope.sender ?? "unknown",
          queuedUserEventId: envelope.id,
        });
        continue;
      }

      const startedAt = Date.now();
      try {
        if (!project.adapter.run) {
          throw new Error(`${project.adapter.harness} adapter has no run implementation`);
        }

        const output = await project.adapter.run({
          projectKey: project.projectKey,
          project: project.project,
          envelope,
        });

        const outbound = createEnvelope(
          project.projectKey,
          project.project.roomId,
          output.body,
          output.format,
          {
            agent:
              output.agent ??
              nonEmptyText(project.project.agent) ??
              nonEmptyText(project.project.prefix) ??
              project.adapter.harness,
          },
        );
        await redis.rpush(agentQueue, JSON.stringify(outbound));

        const durationMs = Date.now() - startedAt;
        recordProcessingLatency("harness_job", durationMs);
        logEvent("info", "harness.job.completed", {
          projectKey: project.projectKey,
          harness: project.adapter.harness,
          durationMs,
          queuedUserEventId: envelope.id,
          queuedAgentEventId: outbound.id,
        });
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        const durationMs = Date.now() - startedAt;
        recordFailure("harness_job", project.projectKey);
        recordProcessingLatency("harness_job", durationMs);

        const harnessLabel = project.adapter.harness[0]?.toUpperCase() +
          project.adapter.harness.slice(1);
        const outbound = createEnvelope(
          project.projectKey,
          project.project.roomId,
          `${harnessLabel} job failed: ${detail}`,
          "plain",
          {
            agent:
              nonEmptyText(project.project.agent) ??
              nonEmptyText(project.project.prefix) ??
              project.adapter.harness,
          },
        );
        await redis.rpush(agentQueue, JSON.stringify(outbound));

        logEvent("warn", "harness.job.failed", {
          projectKey: project.projectKey,
          harness: project.adapter.harness,
          durationMs,
          queuedUserEventId: envelope.id,
          queuedAgentEventId: outbound.id,
          error: detail,
        });
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      recordFailure("harness_worker_loop", project.projectKey);
      logEvent("error", "harness.worker.loop_error", {
        projectKey: project.projectKey,
        harness: project.adapter.harness,
        error: detail,
      });
      await Bun.sleep(1000);
    }
  }
}

export type RunFinalOutputProjectSupervisorOptions = {
  redisConfig: RedisConfig;
  project: FinalOutputWorkerProject;
  workerClients: Set<Redis>;
  restartBaseDelayMs: number;
  restartMaxDelayMs: number;
  createRedisClient: (config: RedisConfig) => Promise<Redis>;
  runWorker: (
    workerRedis: Redis,
    project: FinalOutputWorkerProject,
  ) => Promise<never>;
};

export async function runFinalOutputProjectSupervisor(
  options: RunFinalOutputProjectSupervisorOptions,
): Promise<never> {
  const {
    redisConfig,
    project,
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
      await runWorker(workerRedis, project);
    } catch (error: unknown) {
      crashCount += 1;
      const detail = error instanceof Error ? error.message : String(error);
      recordWorkerRestart(project.projectKey);
      recordFailure("harness_worker_crash", project.projectKey);
      const backoffMs = Math.min(
        restartMaxDelayMs,
        restartBaseDelayMs * 2 ** Math.min(crashCount - 1, 5),
      );

      logEvent("error", "harness.worker.crashed", {
        projectKey: project.projectKey,
        harness: project.adapter.harness,
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
