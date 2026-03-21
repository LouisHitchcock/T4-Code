import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import type { ProjectId, ThreadId, ThreadShareId } from "@t3tools/contracts";

import { ensureNativeApi } from "../nativeApi";

export const threadQueryKeys = {
  all: ["threads"] as const,
  shareStatus: (threadId: ThreadId | null) => ["threads", "share-status", threadId] as const,
  shareSnapshot: (shareId: ThreadShareId | null) => ["threads", "share", shareId] as const,
  redoStatus: (threadId: ThreadId | null) => ["threads", "redo-status", threadId] as const,
};

export const threadMutationKeys = {
  createShare: (threadId: ThreadId | null) =>
    ["threads", "mutation", "create-share", threadId] as const,
  revokeShare: (shareId: ThreadShareId | null) =>
    ["threads", "mutation", "revoke-share", shareId] as const,
  importShare: (shareId: ThreadShareId | null, projectId: ProjectId | null) =>
    ["threads", "mutation", "import-share", shareId, projectId] as const,
  compact: (threadId: ThreadId | null) => ["threads", "mutation", "compact", threadId] as const,
  undo: (threadId: ThreadId | null) => ["threads", "mutation", "undo", threadId] as const,
  redo: (threadId: ThreadId | null) => ["threads", "mutation", "redo", threadId] as const,
};

export function invalidateThreadQueries(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: threadQueryKeys.all });
}

export function threadShareStatusQueryOptions(threadId: ThreadId | null) {
  return queryOptions({
    queryKey: threadQueryKeys.shareStatus(threadId),
    queryFn: async () => {
      if (!threadId) {
        throw new Error("Thread sharing is unavailable.");
      }
      const api = ensureNativeApi();
      return api.threads.getShareStatus({ threadId });
    },
    enabled: threadId !== null,
    staleTime: 10_000,
  });
}

export function threadShareQueryOptions(shareId: ThreadShareId | null) {
  return queryOptions({
    queryKey: threadQueryKeys.shareSnapshot(shareId),
    queryFn: async () => {
      if (!shareId) {
        throw new Error("Shared thread lookup is unavailable.");
      }
      const api = ensureNativeApi();
      return api.threads.getShare({ shareId });
    },
    enabled: shareId !== null,
    staleTime: 30_000,
    retry: false,
  });
}

export function threadRedoStatusQueryOptions(threadId: ThreadId | null) {
  return queryOptions({
    queryKey: threadQueryKeys.redoStatus(threadId),
    queryFn: async () => {
      if (!threadId) {
        throw new Error("Thread history is unavailable.");
      }
      const api = ensureNativeApi();
      return api.threads.getRedoStatus({ threadId });
    },
    enabled: threadId !== null,
    staleTime: 5_000,
  });
}

export function threadCreateShareMutationOptions(input: {
  threadId: ThreadId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: threadMutationKeys.createShare(input.threadId),
    mutationFn: async () => {
      if (!input.threadId) {
        throw new Error("Thread sharing is unavailable.");
      }
      const api = ensureNativeApi();
      return api.threads.createShare({ threadId: input.threadId });
    },
    onSettled: async () => {
      await invalidateThreadQueries(input.queryClient);
    },
  });
}

export function threadRevokeShareMutationOptions(input: {
  shareId: ThreadShareId | null;
  threadId: ThreadId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: threadMutationKeys.revokeShare(input.shareId),
    mutationFn: async () => {
      if (!input.shareId) {
        throw new Error("Shared thread revocation is unavailable.");
      }
      const api = ensureNativeApi();
      return api.threads.revokeShare({ shareId: input.shareId });
    },
    onSettled: async () => {
      await Promise.all([
        invalidateThreadQueries(input.queryClient),
        input.threadId
          ? input.queryClient.invalidateQueries({
              queryKey: threadQueryKeys.shareStatus(input.threadId),
            })
          : Promise.resolve(),
      ]);
    },
  });
}

export function threadImportShareMutationOptions(input: {
  shareId: ThreadShareId | null;
  projectId: ProjectId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: threadMutationKeys.importShare(input.shareId, input.projectId),
    mutationFn: async ({ title }: { title?: string | null }) => {
      if (!input.shareId || !input.projectId) {
        throw new Error("Shared thread import is unavailable.");
      }
      const api = ensureNativeApi();
      return api.threads.importShare({
        shareId: input.shareId,
        projectId: input.projectId,
        ...(title && title.trim().length > 0 ? { title: title.trim() } : {}),
      });
    },
    onSettled: async () => {
      await invalidateThreadQueries(input.queryClient);
    },
  });
}

export function threadCompactMutationOptions(input: {
  threadId: ThreadId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: threadMutationKeys.compact(input.threadId),
    mutationFn: async () => {
      if (!input.threadId) {
        throw new Error("Thread compaction is unavailable.");
      }
      const api = ensureNativeApi();
      return api.threads.compact({ threadId: input.threadId });
    },
    onSettled: async () => {
      await invalidateThreadQueries(input.queryClient);
    },
  });
}

export function threadUndoMutationOptions(input: {
  threadId: ThreadId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: threadMutationKeys.undo(input.threadId),
    mutationFn: async () => {
      if (!input.threadId) {
        throw new Error("Thread undo is unavailable.");
      }
      const api = ensureNativeApi();
      return api.threads.undo({ threadId: input.threadId });
    },
    onSettled: async () => {
      await invalidateThreadQueries(input.queryClient);
    },
  });
}

export function threadRedoMutationOptions(input: {
  threadId: ThreadId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: threadMutationKeys.redo(input.threadId),
    mutationFn: async () => {
      if (!input.threadId) {
        throw new Error("Thread redo is unavailable.");
      }
      const api = ensureNativeApi();
      return api.threads.redo({ threadId: input.threadId });
    },
    onSettled: async () => {
      await invalidateThreadQueries(input.queryClient);
    },
  });
}
