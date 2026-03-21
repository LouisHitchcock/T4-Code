import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  ThreadShareId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { OrchestrationThreadRestoreState } from "./orchestration";

export const ThreadShareSummary = Schema.Struct({
  shareId: ThreadShareId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadShareSummary = typeof ThreadShareSummary.Type;

export const ThreadShareSnapshot = Schema.Struct({
  version: Schema.Literal(2),
  exportedAt: IsoDateTime,
  sourceThreadId: ThreadId,
  sourceProjectId: ProjectId,
  sourceProjectName: Schema.NullOr(TrimmedNonEmptyString),
  state: OrchestrationThreadRestoreState,
});
export type ThreadShareSnapshot = typeof ThreadShareSnapshot.Type;

export const ThreadShareStatusInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadShareStatusInput = typeof ThreadShareStatusInput.Type;

export const ThreadShareStatusResult = Schema.Struct({
  share: Schema.NullOr(ThreadShareSummary),
});
export type ThreadShareStatusResult = typeof ThreadShareStatusResult.Type;

export const ThreadCreateShareInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadCreateShareInput = typeof ThreadCreateShareInput.Type;

export const ThreadCreateShareResult = Schema.Struct({
  share: ThreadShareSummary,
});
export type ThreadCreateShareResult = typeof ThreadCreateShareResult.Type;

export const ThreadGetShareInput = Schema.Struct({
  shareId: ThreadShareId,
});
export type ThreadGetShareInput = typeof ThreadGetShareInput.Type;

export const ThreadGetShareResult = Schema.Struct({
  share: ThreadShareSummary,
  snapshot: ThreadShareSnapshot,
});
export type ThreadGetShareResult = typeof ThreadGetShareResult.Type;

export const ThreadRevokeShareInput = Schema.Struct({
  shareId: ThreadShareId,
});
export type ThreadRevokeShareInput = typeof ThreadRevokeShareInput.Type;

export const ThreadRevokeShareResult = Schema.Struct({
  share: ThreadShareSummary,
});
export type ThreadRevokeShareResult = typeof ThreadRevokeShareResult.Type;

export const ThreadImportShareInput = Schema.Struct({
  shareId: ThreadShareId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadImportShareInput = typeof ThreadImportShareInput.Type;

export const ThreadImportShareResult = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadImportShareResult = typeof ThreadImportShareResult.Type;

export const ThreadCompactInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadCompactInput = typeof ThreadCompactInput.Type;

export const ThreadCompactResult = Schema.Struct({
  compactedAt: IsoDateTime,
  summary: TrimmedNonEmptyString,
});
export type ThreadCompactResult = typeof ThreadCompactResult.Type;

export const ThreadUndoInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadUndoInput = typeof ThreadUndoInput.Type;

export const ThreadUndoResult = Schema.Struct({
  revertedToTurnCount: NonNegativeInt,
  redoDepth: NonNegativeInt,
});
export type ThreadUndoResult = typeof ThreadUndoResult.Type;

export const ThreadRedoInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadRedoInput = typeof ThreadRedoInput.Type;

export const ThreadRedoResult = Schema.Struct({
  redoneAt: IsoDateTime,
  redoDepth: NonNegativeInt,
});
export type ThreadRedoResult = typeof ThreadRedoResult.Type;

export const ThreadRedoStatusInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadRedoStatusInput = typeof ThreadRedoStatusInput.Type;

export const ThreadRedoStatusResult = Schema.Struct({
  available: Schema.Boolean,
  depth: NonNegativeInt,
});
export type ThreadRedoStatusResult = typeof ThreadRedoStatusResult.Type;
