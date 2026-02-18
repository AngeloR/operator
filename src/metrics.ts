import type Redis from "ioredis";

type LatencyAccumulator = {
  count: number;
  sumMs: number;
  minMs: number | null;
  maxMs: number | null;
  samplesMs: number[];
};

type MetricsState = {
  workerRestarts: {
    total: number;
    byProject: Map<string, number>;
  };
  failures: {
    total: number;
    byCategory: Map<string, number>;
    byProject: Map<string, number>;
  };
  processingLatency: {
    overall: LatencyAccumulator;
    byOperation: Map<string, LatencyAccumulator>;
  };
};

export type LogLevel = "info" | "warn" | "error";

export type LogContext = {
  projectKey?: string | null;
  jobId?: string | null;
  queue?: string | null;
  sender?: string | null;
  durationMs?: number | null;
  [key: string]: unknown;
};

const METRICS_LATENCY_SAMPLE_LIMIT = 2000;

function createLatencyAccumulator(): LatencyAccumulator {
  return {
    count: 0,
    sumMs: 0,
    minMs: null,
    maxMs: null,
    samplesMs: [],
  };
}

const metricsState: MetricsState = {
  workerRestarts: {
    total: 0,
    byProject: new Map<string, number>(),
  },
  failures: {
    total: 0,
    byCategory: new Map<string, number>(),
    byProject: new Map<string, number>(),
  },
  processingLatency: {
    overall: createLatencyAccumulator(),
    byOperation: new Map<string, LatencyAccumulator>(),
  },
};

function incrementCounter(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function mapToRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

export function logEvent(level: LogLevel, event: string, context: LogContext = {}): void {
  const payload: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    event,
    projectKey: context.projectKey ?? null,
    jobId: context.jobId ?? null,
    queue: context.queue ?? null,
    sender: context.sender ?? null,
    durationMs: context.durationMs ?? null,
  };

  for (const [key, value] of Object.entries(context)) {
    if (key in payload) {
      continue;
    }
    payload[key] = value;
  }

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

export function recordFailure(category: string, projectKey?: string): void {
  metricsState.failures.total += 1;
  incrementCounter(metricsState.failures.byCategory, category);
  incrementCounter(metricsState.failures.byProject, projectKey ?? "global");
}

export function recordWorkerRestart(projectKey: string): void {
  metricsState.workerRestarts.total += 1;
  incrementCounter(metricsState.workerRestarts.byProject, projectKey);
}

function recordLatencySample(accumulator: LatencyAccumulator, durationMs: number): void {
  const normalized = Math.max(0, Math.round(durationMs));
  accumulator.count += 1;
  accumulator.sumMs += normalized;
  accumulator.minMs = accumulator.minMs === null
    ? normalized
    : Math.min(accumulator.minMs, normalized);
  accumulator.maxMs = accumulator.maxMs === null
    ? normalized
    : Math.max(accumulator.maxMs, normalized);

  accumulator.samplesMs.push(normalized);
  if (accumulator.samplesMs.length > METRICS_LATENCY_SAMPLE_LIMIT) {
    accumulator.samplesMs.shift();
  }
}

export function recordProcessingLatency(operation: string, durationMs: number): void {
  recordLatencySample(metricsState.processingLatency.overall, durationMs);

  let perOperation = metricsState.processingLatency.byOperation.get(operation);
  if (!perOperation) {
    perOperation = createLatencyAccumulator();
    metricsState.processingLatency.byOperation.set(operation, perOperation);
  }

  recordLatencySample(perOperation, durationMs);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }

  const index = Math.ceil((p / 100) * sorted.length) - 1;
  const bounded = Math.max(0, Math.min(sorted.length - 1, index));
  return sorted[bounded] ?? null;
}

function snapshotLatency(accumulator: LatencyAccumulator): Record<string, number | null> {
  if (accumulator.count === 0) {
    return {
      count: 0,
      sumMs: 0,
      minMs: null,
      maxMs: null,
      avgMs: null,
      p50Ms: null,
      p95Ms: null,
      sampleCount: 0,
    };
  }

  const sorted = [...accumulator.samplesMs].sort((a, b) => a - b);
  return {
    count: accumulator.count,
    sumMs: accumulator.sumMs,
    minMs: accumulator.minMs,
    maxMs: accumulator.maxMs,
    avgMs: Number((accumulator.sumMs / accumulator.count).toFixed(2)),
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    sampleCount: accumulator.samplesMs.length,
  };
}

export async function collectQueueDepth(
  redis: Redis,
  projectKeys: string[],
  queueKey: (projectKey: string, direction: "agent" | "user") => string,
): Promise<{
  total: number;
  byQueue: Record<string, number>;
  byProject: Record<string, { user: number; agent: number; total: number }>;
}> {
  const byQueue: Record<string, number> = {};
  const byProject: Record<string, { user: number; agent: number; total: number }> = {};
  let total = 0;

  await Promise.all(
    projectKeys.map(async (projectKey) => {
      const userQueue = queueKey(projectKey, "user");
      const agentQueue = queueKey(projectKey, "agent");
      const [userDepth, agentDepth] = await Promise.all([
        redis.llen(userQueue),
        redis.llen(agentQueue),
      ]);

      byQueue[userQueue] = userDepth;
      byQueue[agentQueue] = agentDepth;
      byProject[projectKey] = {
        user: userDepth,
        agent: agentDepth,
        total: userDepth + agentDepth,
      };
    }),
  );

  for (const item of Object.values(byProject)) {
    total += item.total;
  }

  return { total, byQueue, byProject };
}

export function buildMetricsSnapshot(): {
  workerRestarts: { total: number; byProject: Record<string, number> };
  failures: {
    total: number;
    byCategory: Record<string, number>;
    byProject: Record<string, number>;
  };
  processingLatency: {
    overall: Record<string, number | null>;
    byOperation: Record<string, Record<string, number | null>>;
  };
} {
  const byOperation: Record<string, Record<string, number | null>> = {};
  for (const [operation, stats] of metricsState.processingLatency.byOperation.entries()) {
    byOperation[operation] = snapshotLatency(stats);
  }

  return {
    workerRestarts: {
      total: metricsState.workerRestarts.total,
      byProject: mapToRecord(metricsState.workerRestarts.byProject),
    },
    failures: {
      total: metricsState.failures.total,
      byCategory: mapToRecord(metricsState.failures.byCategory),
      byProject: mapToRecord(metricsState.failures.byProject),
    },
    processingLatency: {
      overall: snapshotLatency(metricsState.processingLatency.overall),
      byOperation,
    },
  };
}
