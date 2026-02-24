import { logEvent, recordFailure, recordProcessingLatency } from "../metrics";
import { nonEmptyText } from "../text";
import {
  buildMatrixContent,
  joinMatrixRoom,
  sendToRoom,
  syncMatrix,
  toUserQueueEnvelope,
  type MatrixClientConfig,
  type MatrixTimelineEvent,
} from "./matrix";
import { type QueueDirection, type QueueEnvelope, type Redis } from "./redis";

export type RunOutboundLoopOptions = {
  outboundRedis: Redis;
  queueToProject: Map<string, string>;
  resolveProjectRoomId: (projectKey: string) => string;
  parseEnvelope: (raw: string, fallbackProjectKey: string, fallbackRoomId: string) => QueueEnvelope;
  matrixClientConfig: () => MatrixClientConfig;
};

export type RunInboundLoopOptions = {
  inboundRedis: Redis;
  roomToProject: Map<string, string>;
  autoOpenCodeProjectKeys: Set<string>;
  adminUserIds: Set<string>;
  queueKey: (projectKey: string, direction: QueueDirection) => string;
  syncTokenKey: string;
  legacySyncTokenKey: string;
  managementCommandPrefix: string;
  renderHelp: () => string;
  isStopMessage: (body: string) => boolean;
  requestStopForProject: (projectKey: string, sender: string) => { stopped: boolean; jobId: string | null };
  splitCommandTokens: (input: string) => string[];
  parseManagementCommandArgs: (tokens: string[]) => unknown;
  executeManagementCommand: (parsed: unknown, sender: string) => Promise<string>;
  matrixClientConfig: () => MatrixClientConfig;
  botUserId?: string;
  managementRoomId?: string;
};

export async function runOutboundLoop(options: RunOutboundLoopOptions): Promise<never> {
  const queueNames = [...options.queueToProject.keys()];

  while (true) {
    try {
      const popped = await options.outboundRedis.blpop(...queueNames, 5);
      if (popped === null || popped.length < 2) {
        continue;
      }

      const poppedQueue = popped[0];
      const rawPayload = popped[1];

      const projectKey = options.queueToProject.get(poppedQueue);
      if (!projectKey) {
        recordFailure("outbound_unknown_queue");
        logEvent("error", "outbound.queue.unknown", {
          queue: poppedQueue,
          error: "unknown queue key from Redis",
        });
        continue;
      }

      const roomId = options.resolveProjectRoomId(projectKey);
      const envelope = options.parseEnvelope(rawPayload, projectKey, roomId);
      const startedAt = Date.now();

      try {
        const eventId = await sendToRoom(
          options.matrixClientConfig(),
          envelope.roomId,
          buildMatrixContent({
            body: envelope.body,
            format: envelope.format,
            agent: envelope.agent,
          }),
        );
        const durationMs = Date.now() - startedAt;
        recordProcessingLatency("outbound_send", durationMs);
        logEvent("info", "outbound.send.success", {
          projectKey,
          queue: poppedQueue,
          sender: envelope.sender ?? null,
          durationMs,
          roomId: envelope.roomId,
          queuedEventId: envelope.id,
          matrixEventId: eventId,
        });
      } catch (error: unknown) {
        const detail =
          error instanceof Error
            ? error.message
            : "failed to send Matrix message";
        recordFailure("outbound_send", projectKey);
        const durationMs = Date.now() - startedAt;
        recordProcessingLatency("outbound_send", durationMs);
        logEvent("error", "outbound.send.failed", {
          projectKey,
          queue: poppedQueue,
          sender: envelope.sender ?? null,
          durationMs,
          roomId: envelope.roomId,
          queuedEventId: envelope.id,
          error: detail,
          requeued: true,
        });

        await options.outboundRedis.lpush(poppedQueue, rawPayload);
        await Bun.sleep(1000);
      }
    } catch (error: unknown) {
      const detail =
        error instanceof Error ? error.message : "worker loop failed";
      recordFailure("outbound_loop");
      logEvent("error", "outbound.loop.error", {
        error: detail,
      });
      await Bun.sleep(1000);
    }
  }
}

export async function runInboundLoop(options: RunInboundLoopOptions): Promise<never> {
  let since = nonEmptyText(await options.inboundRedis.get(options.syncTokenKey)) ?? undefined;

  if (!since) {
    const legacySince =
      nonEmptyText(await options.inboundRedis.get(options.legacySyncTokenKey)) ?? undefined;
    if (legacySince) {
      since = legacySince;
      await options.inboundRedis.set(options.syncTokenKey, legacySince);
      await options.inboundRedis.del(options.legacySyncTokenKey);
      logEvent("info", "inbound.sync.token_key.migrated", {
        from: options.legacySyncTokenKey,
        to: options.syncTokenKey,
      });
    }
  }

  if (!since) {
    try {
      const syncStartedAt = Date.now();
      const bootstrap = await syncMatrix(options.matrixClientConfig(), undefined, 0);
      const next = nonEmptyText(bootstrap.next_batch);
      if (next) {
        since = next;
        await options.inboundRedis.set(options.syncTokenKey, next);
      }
      const durationMs = Date.now() - syncStartedAt;
      recordProcessingLatency("inbound_sync", durationMs);
      logEvent("info", "inbound.sync.bootstrap.initialized", {
        durationMs,
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      recordFailure("inbound_sync_bootstrap");
      logEvent("error", "inbound.sync.bootstrap.failed", {
        error: detail,
      });
      await Bun.sleep(1000);
    }
  }

  while (true) {
    try {
      const syncStartedAt = Date.now();
      const syncResponse = await syncMatrix(options.matrixClientConfig(), since, 30000);
      recordProcessingLatency("inbound_sync", Date.now() - syncStartedAt);
      const next = nonEmptyText(syncResponse.next_batch);
      if (next) {
        since = next;
        await options.inboundRedis.set(options.syncTokenKey, next);
      }

      const invitedRooms = syncResponse.rooms?.invite ?? {};
      for (const roomId of Object.keys(invitedRooms)) {
        const projectKey = options.roomToProject.get(roomId);
        const isManagementRoom = options.managementRoomId && roomId === options.managementRoomId;

        try {
          const joinedRoomId = await joinMatrixRoom(options.matrixClientConfig(), roomId);
          if (projectKey) {
            logEvent("info", "inbound.room.auto_joined", {
              projectKey,
              roomId: joinedRoomId ?? roomId,
            });
          } else if (isManagementRoom) {
            logEvent("info", "inbound.room.management_joined", {
              roomId: joinedRoomId ?? roomId,
            });
          } else {
            logEvent("info", "inbound.room.unconfigured_joined", {
              roomId: joinedRoomId ?? roomId,
            });
          }
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error);
          if (projectKey) {
            recordFailure("inbound_auto_join", projectKey);
            logEvent("error", "inbound.room.auto_join_failed", {
              projectKey,
              error: detail,
              roomId,
            });
          } else {
            logEvent("error", "inbound.room.unconfigured_join_failed", {
              error: detail,
              roomId,
            });
          }
        }
      }

      const joinedRooms = syncResponse.rooms?.join ?? {};
      for (const [roomId, roomState] of Object.entries(joinedRooms)) {
        const projectKey = options.roomToProject.get(roomId);

        const isManagementRoom = options.managementRoomId && roomId === options.managementRoomId;

        const events = roomState.timeline?.events;
        if (!Array.isArray(events)) {
          continue;
        }

        for (const rawEvent of events) {
          const event = rawEvent as MatrixTimelineEvent;

          if (isManagementRoom) {
            const sender = nonEmptyText(event.sender);
            if (!sender) continue;
            if (options.botUserId && sender === options.botUserId) continue;
            if (options.adminUserIds.size > 0 && !options.adminUserIds.has(sender)) continue;

            if (typeof event.content !== "object" || event.content === null) continue;
            const content = event.content as Record<string, unknown>;
            const body = nonEmptyText(content.body);
            if (!body) continue;
            if (content["m.relates_to"] !== undefined) continue;

            const trimmed = body.trim();
            if (trimmed.startsWith("!help")) {
              let response: string;
              try {
                response = options.renderHelp();
              } catch (error: unknown) {
                const detail = error instanceof Error ? error.message : String(error);
                response = `Error: ${detail}`;
              }

              try {
                await sendToRoom(
                  options.matrixClientConfig(),
                  roomId,
                  buildMatrixContent({ body: response, format: "markdown" }),
                );
                logEvent("info", "help.command.executed", {
                  roomId,
                  sender,
                });
              } catch (error: unknown) {
                const detail = error instanceof Error ? error.message : String(error);
                logEvent("error", "help.command.response_failed", {
                  roomId,
                  sender,
                  error: detail,
                });
              }
              continue;
            }

            if (!trimmed.startsWith(options.managementCommandPrefix)) continue;
            const nextChar = trimmed.charAt(options.managementCommandPrefix.length);
            if (nextChar && !/\s/.test(nextChar)) continue;

            const tokens = options.splitCommandTokens(
              trimmed.slice(options.managementCommandPrefix.length).trim(),
            );
            let response: string;
            try {
              const parsed = options.parseManagementCommandArgs(tokens);
              response = await options.executeManagementCommand(parsed, sender);
            } catch (error: unknown) {
              const detail = error instanceof Error ? error.message : String(error);
              response = `Error: ${detail}`;
            }

            try {
              await sendToRoom(
                options.matrixClientConfig(),
                roomId,
                buildMatrixContent({ body: response, format: "markdown" }),
              );
              logEvent("info", "management.command.executed", {
                roomId,
                sender,
                command: tokens[0] ?? "unknown",
              });
            } catch (error: unknown) {
              const detail = error instanceof Error ? error.message : String(error);
              logEvent("error", "management.command.response_failed", {
                roomId,
                sender,
                error: detail,
              });
            }
            continue;
          }

          const content = event.content as Record<string, unknown>;
          const body = nonEmptyText(content.body);
          if (!body) continue;
          if (content["m.relates_to"] !== undefined) continue;

          const trimmed = body.trim();
          const sender = nonEmptyText(event.sender);

          if (
            projectKey &&
            sender &&
            options.autoOpenCodeProjectKeys.has(projectKey) &&
            options.isStopMessage(trimmed)
          ) {
            const stopStartedAt = Date.now();
            const stopResult = options.requestStopForProject(projectKey, sender);
            const stopBody = stopResult.stopped
              ? `Stopping current job${stopResult.jobId ? ` (${stopResult.jobId})` : ""}. Waiting for your next instruction.`
              : "No active job to stop right now. Waiting for your next instruction.";

            try {
              await sendToRoom(
                options.matrixClientConfig(),
                roomId,
                buildMatrixContent({ body: stopBody, format: "plain" }),
              );
              const durationMs = Date.now() - stopStartedAt;
              logEvent("info", "inbound.stop.processed", {
                roomId,
                projectKey,
                sender,
                durationMs,
                stopped: stopResult.stopped,
                jobId: stopResult.jobId,
              });
            } catch (error: unknown) {
              const detail = error instanceof Error ? error.message : String(error);
              logEvent("error", "inbound.stop.response_failed", {
                roomId,
                projectKey,
                sender,
                error: detail,
              });
            }

            continue;
          }

          if (trimmed.startsWith("!help")) {
            let response: string;
            try {
              response = options.renderHelp();
            } catch (error: unknown) {
              const detail = error instanceof Error ? error.message : String(error);
              response = `Error: ${detail}`;
            }

            try {
              await sendToRoom(
                options.matrixClientConfig(),
                roomId,
                buildMatrixContent({ body: response, format: "markdown" }),
              );
              logEvent("info", "help.command.executed", {
                roomId,
                projectKey: projectKey ?? null,
              });
            } catch (error: unknown) {
              const detail = error instanceof Error ? error.message : String(error);
              logEvent("error", "help.command.response_failed", {
                roomId,
                projectKey: projectKey ?? null,
                error: detail,
              });
            }
            continue;
          }

          if (!projectKey) {
            const unconfiguredSender = nonEmptyText(event.sender);
            if (!unconfiguredSender) continue;
            if (options.botUserId && unconfiguredSender === options.botUserId) continue;

            const unconfiguredContent = event.content as Record<string, unknown>;
            const unconfiguredBody = nonEmptyText(unconfiguredContent.body);
            if (!unconfiguredBody) continue;
            if (unconfiguredContent["m.relates_to"] !== undefined) continue;

            try {
              await sendToRoom(
                options.matrixClientConfig(),
                roomId,
                buildMatrixContent({
                  body: "There is no project configured for this channel. Please configure a project using the management room.",
                  format: "plain",
                }),
              );
              logEvent("info", "inbound.room.unconfigured_message_response", {
                roomId,
                sender: unconfiguredSender,
              });
            } catch (error: unknown) {
              const detail = error instanceof Error ? error.message : String(error);
              logEvent("error", "inbound.room.unconfigured_message_failed", {
                roomId,
                sender: unconfiguredSender,
                error: detail,
              });
            }
            continue;
          }

          const envelope = toUserQueueEnvelope(
            event,
            projectKey,
            roomId,
            options.adminUserIds,
            options.botUserId,
          );

          if (!envelope) {
            continue;
          }

          const key = options.queueKey(projectKey, "user");
          const enqueueStartedAt = Date.now();
          const queueLength = await options.inboundRedis.rpush(key, JSON.stringify(envelope));
          const durationMs = Date.now() - enqueueStartedAt;
          recordProcessingLatency("inbound_enqueue", durationMs);
          logEvent("info", "inbound.message.enqueued", {
            projectKey,
            queue: key,
            sender: envelope.sender ?? null,
            durationMs,
            roomId,
            eventId: envelope.id,
            queueLength,
          });
        }
      }
    } catch (error: unknown) {
      const detail =
        error instanceof Error ? error.message : "matrix sync failed";
      recordFailure("inbound_sync");
      logEvent("error", "inbound.loop.error", {
        error: detail,
      });
      await Bun.sleep(1000);
    }
  }
}
