import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThread,
} from "@draft/contracts";
import { Effect } from "effect";
import { inferProviderFromModelSlug } from "@draft/shared/model";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { sanitizeProviderOptionsForPersistence } from "../provider/providerOptions.ts";
import {
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadAbsent,
} from "./commandInvariants.ts";

const nowIso = () => new Date().toISOString();
const DEFAULT_ASSISTANT_DELIVERY_MODE = "buffered" as const;
const FORK_EXCLUDED_ACTIVITY_KINDS = new Set([
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.resolved",
]);

const defaultMetadata: Omit<OrchestrationEvent, "sequence" | "type" | "payload"> = {
  eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
  aggregateKind: "thread",
  aggregateId: "" as OrchestrationEvent["aggregateId"],
  occurredAt: nowIso(),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return {
    ...defaultMetadata,
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    correlationId: input.commandId,
    metadata: input.metadata ?? {},
  };
}

function findLatestThreadActivityForRequest(
  readModel: OrchestrationReadModel,
  threadId: string,
  requestId: string,
) {
  const thread = readModel.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    return undefined;
  }
  return [...thread.activities]
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .toReversed()
    .find((activity) => {
      const payload = activity.payload;
      if (!payload || typeof payload !== "object") {
        return false;
      }
      return "requestId" in payload && payload.requestId === requestId;
    });
}

function compareThreadMessages(
  left: OrchestrationThread["messages"][number],
  right: OrchestrationThread["messages"][number],
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compareThreadProposedPlans(
  left: OrchestrationThread["proposedPlans"][number],
  right: OrchestrationThread["proposedPlans"][number],
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compareThreadCheckpoints(
  left: OrchestrationThread["checkpoints"][number],
  right: OrchestrationThread["checkpoints"][number],
): number {
  if (left.checkpointTurnCount !== right.checkpointTurnCount) {
    return left.checkpointTurnCount - right.checkpointTurnCount;
  }
  return (
    left.completedAt.localeCompare(right.completedAt) || left.turnId.localeCompare(right.turnId)
  );
}

function retainForkMessagesAfterTurnCount(
  messages: ReadonlyArray<OrchestrationThread["messages"][number]>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationThread["messages"][number]> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(compareThreadMessages)
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(compareThreadMessages)
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function shouldCopyForkActivity(activity: OrchestrationThread["activities"][number]): boolean {
  return !FORK_EXCLUDED_ACTIVITY_KINDS.has(activity.kind);
}

function getEntryTimestamp(entry: { createdAt: string; updatedAt?: string }): string {
  return entry.updatedAt ?? entry.createdAt;
}

function shouldRetainMessageForkEntry(input: {
  readonly entryTurnId: string | null;
  readonly entryTimestamp: string;
  readonly retainedTurnIds: ReadonlySet<string>;
  readonly cutoffAt: string | null;
  readonly boundaryTurnId: string | null;
}): boolean {
  if (input.entryTurnId === null) {
    return input.cutoffAt !== null && input.entryTimestamp <= input.cutoffAt;
  }

  if (!input.retainedTurnIds.has(input.entryTurnId)) {
    return false;
  }

  if (
    input.cutoffAt !== null &&
    input.boundaryTurnId !== null &&
    input.entryTurnId === input.boundaryTurnId
  ) {
    return input.entryTimestamp <= input.cutoffAt;
  }

  return true;
}

function buildForkSnapshot(input: {
  readonly command: Extract<OrchestrationCommand, { type: "thread.fork" }>;
  readonly sourceThread: OrchestrationThread;
}): Effect.Effect<
  {
    readonly messages: ReadonlyArray<OrchestrationThread["messages"][number]>;
    readonly proposedPlans: ReadonlyArray<OrchestrationThread["proposedPlans"][number]>;
    readonly checkpoints: ReadonlyArray<OrchestrationThread["checkpoints"][number]>;
    readonly activities: ReadonlyArray<OrchestrationThread["activities"][number]>;
  },
  OrchestrationCommandInvariantError
> {
  const { command, sourceThread } = input;
  const orderedMessages = [...sourceThread.messages].toSorted(compareThreadMessages);
  const orderedProposedPlans = [...sourceThread.proposedPlans].toSorted(compareThreadProposedPlans);
  const orderedCheckpoints = [...sourceThread.checkpoints].toSorted(compareThreadCheckpoints);
  const orderedActivities = [...sourceThread.activities].toSorted(compareThreadActivities);
  const forkSource = command.source;

  const retainTimestampScopedEntries = <
    T extends { turnId: string | null; createdAt: string; updatedAt?: string },
  >(
    entries: ReadonlyArray<T>,
    cutoffAt: string | null,
  ): T[] =>
    entries.filter((entry) => {
      if (entry.turnId !== null) {
        return retainedTurnIds.has(entry.turnId);
      }
      return cutoffAt !== null && getEntryTimestamp(entry) <= cutoffAt;
    });

  let retainedTurnIds = new Set<string>();
  let cutoffAt: string | null = null;

  if (forkSource.kind === "latest") {
    retainedTurnIds = new Set(orderedCheckpoints.map((checkpoint) => checkpoint.turnId));
    cutoffAt = null;
  } else if (forkSource.kind === "message") {
    const messageIndex = orderedMessages.findIndex(
      (message) => message.id === forkSource.messageId,
    );
    if (messageIndex < 0) {
      return Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.sourceThreadId}' does not contain message '${forkSource.messageId}'.`,
        }),
      );
    }

    const retainedMessages = orderedMessages.slice(0, messageIndex + 1);
    const boundaryMessage = retainedMessages.at(-1) ?? null;
    const boundaryTurnId = boundaryMessage?.turnId ?? null;
    retainedTurnIds = new Set(
      retainedMessages.flatMap((message) => (message.turnId === null ? [] : [message.turnId])),
    );
    cutoffAt = boundaryMessage ? getEntryTimestamp(boundaryMessage) : null;

    return Effect.succeed({
      messages: retainedMessages,
      proposedPlans: orderedProposedPlans.filter((plan) =>
        shouldRetainMessageForkEntry({
          entryTurnId: plan.turnId,
          entryTimestamp: getEntryTimestamp(plan),
          retainedTurnIds,
          cutoffAt,
          boundaryTurnId,
        }),
      ),
      checkpoints: orderedCheckpoints.filter((checkpoint) =>
        shouldRetainMessageForkEntry({
          entryTurnId: checkpoint.turnId,
          entryTimestamp: checkpoint.completedAt,
          retainedTurnIds,
          cutoffAt,
          boundaryTurnId,
        }),
      ),
      activities: orderedActivities
        .filter((activity) =>
          shouldRetainMessageForkEntry({
            entryTurnId: activity.turnId,
            entryTimestamp: getEntryTimestamp(activity),
            retainedTurnIds,
            cutoffAt,
            boundaryTurnId,
          }),
        )
        .filter(shouldCopyForkActivity),
    });
  } else {
    const latestCheckpointTurnCount = orderedCheckpoints.at(-1)?.checkpointTurnCount ?? 0;
    if (forkSource.turnCount > latestCheckpointTurnCount) {
      return Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.sourceThreadId}' does not have checkpoint turn ${forkSource.turnCount}.`,
        }),
      );
    }
    if (
      forkSource.turnCount > 0 &&
      !orderedCheckpoints.some(
        (checkpoint) => checkpoint.checkpointTurnCount === forkSource.turnCount,
      )
    ) {
      return Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.sourceThreadId}' is missing checkpoint turn ${forkSource.turnCount}.`,
        }),
      );
    }

    const retainedCheckpoints = orderedCheckpoints.filter(
      (checkpoint) => checkpoint.checkpointTurnCount <= forkSource.turnCount,
    );
    retainedTurnIds = new Set(retainedCheckpoints.map((checkpoint) => checkpoint.turnId));
    cutoffAt = retainedCheckpoints.at(-1)?.completedAt ?? null;

    return Effect.succeed({
      messages: retainForkMessagesAfterTurnCount(
        orderedMessages,
        retainedTurnIds,
        forkSource.turnCount,
      ),
      proposedPlans: retainTimestampScopedEntries(orderedProposedPlans, cutoffAt),
      checkpoints: retainedCheckpoints,
      activities: retainTimestampScopedEntries(orderedActivities, cutoffAt).filter(
        shouldCopyForkActivity,
      ),
    });
  }

  return Effect.succeed({
    messages: orderedMessages,
    proposedPlans: orderedProposedPlans,
    checkpoints: orderedCheckpoints,
    activities: orderedActivities.filter(shouldCopyForkActivity),
  });
}

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });

      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModel: command.defaultModel ?? null,
          defaultProvider: command.defaultProvider ?? inferProviderFromModelSlug(command.defaultModel),
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      const resolvedDefaultProvider =
        command.defaultProvider !== undefined
          ? command.defaultProvider
          : command.defaultModel !== undefined
            ? inferProviderFromModelSlug(command.defaultModel)
            : undefined;
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModel !== undefined ? { defaultModel: command.defaultModel } : {}),
          ...(resolvedDefaultProvider !== undefined
            ? { defaultProvider: resolvedDefaultProvider }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.deleted",
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          model: command.model,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.fork": {
      const sourceThread = yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      const forkSnapshot = yield* buildForkSnapshot({ command, sourceThread });

      const events: Array<Omit<OrchestrationEvent, "sequence">> = [];
      const copiedMessageIds = new Map<string, OrchestrationThread["messages"][number]["id"]>();

      const appendForkEvent = <TType extends OrchestrationEvent["type"]>(
        type: TType,
        payload: Extract<OrchestrationEvent, { type: TType }>["payload"],
      ) => {
        const previousEvent = events.at(-1) ?? null;
        const nextEvent = {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          causationEventId: previousEvent?.eventId ?? null,
          type,
          payload,
        } as Omit<OrchestrationEvent, "sequence">;
        events.push(nextEvent);
        return nextEvent;
      };

      appendForkEvent("thread.created", {
        threadId: command.threadId,
        projectId: sourceThread.projectId,
        title: command.title,
        model: command.model,
        runtimeMode: command.runtimeMode,
        interactionMode: command.interactionMode,
        branch: command.branch,
        worktreePath: command.worktreePath,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      });

      for (const message of forkSnapshot.messages) {
        const nextMessageId = crypto.randomUUID() as OrchestrationThread["messages"][number]["id"];
        copiedMessageIds.set(message.id, nextMessageId);
        appendForkEvent("thread.message-sent", {
          threadId: command.threadId,
          messageId: nextMessageId,
          role: message.role,
          text: message.text,
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          turnId: message.turnId,
          streaming: message.streaming,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        });
      }

      for (const proposedPlan of forkSnapshot.proposedPlans) {
        appendForkEvent("thread.proposed-plan-upserted", {
          threadId: command.threadId,
          proposedPlan: {
            ...proposedPlan,
            id: crypto.randomUUID() as OrchestrationThread["proposedPlans"][number]["id"],
          },
        });
      }

      for (const checkpoint of forkSnapshot.checkpoints) {
        appendForkEvent("thread.turn-diff-completed", {
          threadId: command.threadId,
          turnId: checkpoint.turnId,
          checkpointTurnCount: checkpoint.checkpointTurnCount,
          checkpointRef: checkpoint.checkpointRef,
          status: checkpoint.status,
          files: checkpoint.files,
          assistantMessageId:
            checkpoint.assistantMessageId !== null
              ? (copiedMessageIds.get(checkpoint.assistantMessageId) ?? null)
              : null,
          completedAt: checkpoint.completedAt,
        });
      }

      for (const activity of forkSnapshot.activities) {
        appendForkEvent("thread.activity-appended", {
          threadId: command.threadId,
          activity: {
            ...activity,
            id: crypto.randomUUID() as OrchestrationThread["activities"][number]["id"],
          },
        });
      }

      return events;
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.model !== undefined ? { model: command.model } : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const persistedProviderOptions = sanitizeProviderOptionsForPersistence(
        command.providerOptions,
      );
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.provider !== undefined ? { provider: command.provider } : {}),
          ...(command.model !== undefined ? { model: command.model } : {}),
          ...(command.modelOptions !== undefined ? { modelOptions: command.modelOptions } : {}),
          ...(persistedProviderOptions !== undefined
            ? { providerOptions: persistedProviderOptions }
            : {}),
          ...(command.skills !== undefined ? { skills: command.skills } : {}),
          assistantDeliveryMode: command.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
          runtimeMode:
            readModel.threads.find((entry) => entry.id === command.threadId)?.runtimeMode ??
            command.runtimeMode,
          interactionMode:
            readModel.threads.find((entry) => entry.id === command.threadId)?.interactionMode ??
            command.interactionMode,
          createdAt: command.createdAt,
        },
      };
      return [userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const latestRequestActivity = findLatestThreadActivityForRequest(
        readModel,
        command.threadId,
        command.requestId,
      );
      return [
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
            metadata: {
              requestId: command.requestId,
            },
          }),
          type: "thread.approval-response-requested",
          payload: {
            threadId: command.threadId,
            requestId: command.requestId,
            decision: command.decision,
            createdAt: command.createdAt,
          },
        },
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
            metadata: {
              requestId: command.requestId,
            },
          }),
          type: "thread.activity-appended",
          payload: {
            threadId: command.threadId,
            activity: {
              id: crypto.randomUUID() as OrchestrationEvent["eventId"],
              tone: "approval",
              kind: "approval.resolved",
              summary: "Approval resolved",
              payload: {
                requestId: command.requestId,
                decision: command.decision,
              },
              turnId: latestRequestActivity?.turnId ?? null,
              createdAt: command.createdAt,
            },
          },
        },
      ];
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const latestRequestActivity = findLatestThreadActivityForRequest(
        readModel,
        command.threadId,
        command.requestId,
      );
      return [
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
            metadata: {
              requestId: command.requestId,
            },
          }),
          type: "thread.user-input-response-requested",
          payload: {
            threadId: command.threadId,
            requestId: command.requestId,
            answers: command.answers,
            createdAt: command.createdAt,
          },
        },
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
            metadata: {
              requestId: command.requestId,
            },
          }),
          type: "thread.activity-appended",
          payload: {
            threadId: command.threadId,
            activity: {
              id: crypto.randomUUID() as OrchestrationEvent["eventId"],
              tone: "info",
              kind: "user-input.resolved",
              summary: "User input submitted",
              payload: {
                requestId: command.requestId,
                answers: command.answers,
              },
              turnId: latestRequestActivity?.turnId ?? null,
              createdAt: command.createdAt,
            },
          },
        },
      ];
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
    }

    case "thread.restore": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.restored",
        payload: {
          threadId: command.threadId,
          state: command.state,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
