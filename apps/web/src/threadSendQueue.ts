import {
  type ProviderInteractionMode,
  type ProviderKind,
  type ProviderModelOptions,
  type ProviderServiceTier,
  type ThreadId,
} from "@t3tools/contracts";
import type { ProjectSkillName, RuntimeMode } from "@t3tools/contracts";
import { create } from "zustand";
import type { ComposerImageAttachment } from "./composerDraftStore";

export type ThreadSendQueueStatus = "pending" | "sending" | "failed";
export type ThreadFollowUpMode = "queue" | "steer";

export interface QueuedThreadTurn {
  id: string;
  threadId: ThreadId;
  text: string;
  attachments: ComposerImageAttachment[];
  provider: ProviderKind;
  model: string;
  serviceTier: ProviderServiceTier | null;
  modelOptions?: ProviderModelOptions | undefined;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  skillNames: ProjectSkillName[];
  createdAt: string;
  mode: ThreadFollowUpMode;
  status: ThreadSendQueueStatus;
  error: string | null;
}

interface ThreadSendQueueStore {
  queueByThreadId: Record<ThreadId, QueuedThreadTurn[]>;
  enqueue: (turn: QueuedThreadTurn, options?: { front?: boolean }) => void;
  remove: (threadId: ThreadId, queueItemId: string) => void;
  move: (threadId: ThreadId, queueItemId: string, direction: -1 | 1) => void;
  markSending: (threadId: ThreadId, queueItemId: string) => void;
  markFailed: (threadId: ThreadId, queueItemId: string, error: string | null) => void;
  markPending: (threadId: ThreadId, queueItemId: string) => void;
  clearThreadQueue: (threadId: ThreadId) => void;
}

function updateThreadQueue(
  queueByThreadId: Record<ThreadId, QueuedThreadTurn[]>,
  threadId: ThreadId,
  updater: (existing: QueuedThreadTurn[]) => QueuedThreadTurn[],
): Record<ThreadId, QueuedThreadTurn[]> {
  const existing = queueByThreadId[threadId] ?? [];
  const next = updater(existing);
  if (next === existing) {
    return queueByThreadId;
  }
  if (next.length === 0) {
    const { [threadId]: _removed, ...rest } = queueByThreadId;
    return rest;
  }
  return {
    ...queueByThreadId,
    [threadId]: next,
  };
}

export const useThreadSendQueueStore = create<ThreadSendQueueStore>((set) => ({
  queueByThreadId: {},
  enqueue: (turn, options) => {
    set((state) => ({
      queueByThreadId: updateThreadQueue(state.queueByThreadId, turn.threadId, (existing) =>
        options?.front ? [turn, ...existing] : [...existing, turn],
      ),
    }));
  },
  remove: (threadId, queueItemId) => {
    set((state) => ({
      queueByThreadId: updateThreadQueue(state.queueByThreadId, threadId, (existing) => {
        const next = existing.filter((item) => item.id !== queueItemId);
        return next.length === existing.length ? existing : next;
      }),
    }));
  },
  move: (threadId, queueItemId, direction) => {
    set((state) => ({
      queueByThreadId: updateThreadQueue(state.queueByThreadId, threadId, (existing) => {
        const currentIndex = existing.findIndex((item) => item.id === queueItemId);
        if (currentIndex < 0) {
          return existing;
        }
        const nextIndex = currentIndex + direction;
        if (nextIndex < 0 || nextIndex >= existing.length) {
          return existing;
        }
        const next = [...existing];
        const [item] = next.splice(currentIndex, 1);
        if (!item) {
          return existing;
        }
        next.splice(nextIndex, 0, item);
        return next;
      }),
    }));
  },
  markSending: (threadId, queueItemId) => {
    set((state) => ({
      queueByThreadId: updateThreadQueue(state.queueByThreadId, threadId, (existing) => {
        let changed = false;
        const next = existing.map((item) => {
          if (item.id !== queueItemId || item.status === "sending") {
            return item;
          }
          changed = true;
          return { ...item, status: "sending" as const, error: null };
        });
        return changed ? next : existing;
      }),
    }));
  },
  markFailed: (threadId, queueItemId, error) => {
    set((state) => ({
      queueByThreadId: updateThreadQueue(state.queueByThreadId, threadId, (existing) => {
        let changed = false;
        const next = existing.map((item) => {
          if (item.id !== queueItemId) {
            return item;
          }
          changed = true;
          return { ...item, status: "failed" as const, error };
        });
        return changed ? next : existing;
      }),
    }));
  },
  markPending: (threadId, queueItemId) => {
    set((state) => ({
      queueByThreadId: updateThreadQueue(state.queueByThreadId, threadId, (existing) => {
        let changed = false;
        const next = existing.map((item) => {
          if (item.id !== queueItemId || item.status === "pending") {
            return item;
          }
          changed = true;
          return { ...item, status: "pending" as const, error: null };
        });
        return changed ? next : existing;
      }),
    }));
  },
  clearThreadQueue: (threadId) => {
    set((state) => ({
      queueByThreadId: updateThreadQueue(state.queueByThreadId, threadId, (existing) =>
        existing.length === 0 ? existing : [],
      ),
    }));
  },
}));
