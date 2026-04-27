import { type ProviderUserInputAnswers } from "@draft/contracts";
import { Effect, Layer, ServiceMap } from "effect";

import { CopilotAcpManager } from "../../copilotAcpManager.ts";
import { createAcpEventStream, toAcpRequestError } from "../acpAdapterSupport.ts";
import { CopilotAdapter, type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";

const PROVIDER = "copilot" as const;

export interface CopilotAdapterLiveOptions {
  readonly manager?: CopilotAcpManager;
  readonly makeManager?: (services?: ServiceMap.ServiceMap<never>) => CopilotAcpManager;
}

export const makeCopilotAdapterLive = (options?: CopilotAdapterLiveOptions) =>
  Layer.effect(
    CopilotAdapter,
    Effect.gen(function* () {
      const manager = options?.manager ?? options?.makeManager?.() ?? new CopilotAcpManager();
      const toRequestError = (threadId: string, method: string, cause: unknown) =>
        toAcpRequestError({
          provider: PROVIDER,
          threadId,
          method,
          cause,
          unknownSessionNeedle: "unknown copilot session",
        });

      const streamEvents = yield* createAcpEventStream(manager);

      const startSession: CopilotAdapterShape["startSession"] = (input) =>
        Effect.tryPromise({
          try: () =>
            manager.startSession({
              threadId: input.threadId,
              provider: "copilot",
              ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
              ...(input.model !== undefined ? { model: input.model } : {}),
              ...(input.modelOptions?.copilot?.reasoningEffort !== undefined
                ? { reasoningEffort: input.modelOptions.copilot.reasoningEffort }
                : {}),
              ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
              ...(input.providerOptions !== undefined
                ? { providerOptions: input.providerOptions }
                : {}),
              runtimeMode: input.runtimeMode,
            }),
          catch: (cause) => toRequestError(input.threadId, "session/start", cause),
        });

      const sendTurn: CopilotAdapterShape["sendTurn"] = (input) =>
        Effect.tryPromise({
          try: () =>
            manager.sendTurn({
              threadId: input.threadId,
              ...(input.input !== undefined ? { input: input.input } : {}),
              ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
              ...(input.model !== undefined ? { model: input.model } : {}),
              ...(input.modelOptions?.copilot?.reasoningEffort !== undefined
                ? { reasoningEffort: input.modelOptions.copilot.reasoningEffort }
                : {}),
            }),
          catch: (cause) => toRequestError(input.threadId, "session/prompt", cause),
        });

      const interruptTurn: CopilotAdapterShape["interruptTurn"] = (threadId, turnId) =>
        Effect.tryPromise({
          try: () => manager.interruptTurn(threadId, turnId),
          catch: (cause) => toRequestError(threadId, "session/cancel", cause),
        });

      const respondToRequest: CopilotAdapterShape["respondToRequest"] = (
        threadId,
        requestId,
        decision,
      ) =>
        Effect.tryPromise({
          try: () => manager.respondToRequest(threadId, requestId, decision),
          catch: (cause) => toRequestError(threadId, "request/respond", cause),
        });

      const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
        threadId,
        _requestId,
        _answers: ProviderUserInputAnswers,
      ) =>
        Effect.tryPromise({
          try: () => manager.respondToUserInput(),
          catch: (cause) => toRequestError(threadId, "user-input/respond", cause),
        });

      const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
        Effect.tryPromise({
          try: () => manager.stopSession(threadId),
          catch: (cause) => toRequestError(threadId, "session/stop", cause),
        });

      const listSessions: CopilotAdapterShape["listSessions"] = () =>
        Effect.promise(() => manager.listSessions());

      const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
        Effect.promise(() => manager.hasSession(threadId));

      const readThread: CopilotAdapterShape["readThread"] = (threadId) =>
        Effect.tryPromise({
          try: () => manager.readThread(threadId),
          catch: (cause) => toRequestError(threadId, "thread/read", cause),
        });

      const rollbackThread: CopilotAdapterShape["rollbackThread"] = (threadId, numTurns) =>
        Effect.tryPromise({
          try: () => manager.rollbackThread(threadId, numTurns),
          catch: (cause) => toRequestError(threadId, "thread/rollback", cause),
        });

      const stopAll: CopilotAdapterShape["stopAll"] = () =>
        Effect.tryPromise({
          try: () => manager.stopAll(),
          catch: (cause) => toRequestError("_global", "provider/stopAll", cause),
        });

      return {
        provider: PROVIDER,
        capabilities: {
          sessionModelSwitch: "in-session",
        structuredUserInput: "unsupported",
        readThread: "unsupported",
        rollbackThread: "unsupported",
        },
        startSession,
        sendTurn,
        interruptTurn,
        respondToRequest,
        respondToUserInput,
        stopSession,
        listSessions,
        hasSession,
        readThread,
        rollbackThread,
        stopAll,
        streamEvents,
      } satisfies CopilotAdapterShape;
    }),
  );
