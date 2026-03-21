import path from "node:path";

import {
  IsoDateTime,
  type OrchestrationThreadRestoreState,
  OrchestrationThreadRestoreState as OrchestrationThreadRestoreStateSchema,
  ThreadId,
} from "@t3tools/contracts";
import { Schema } from "effect";

import { readStateJsonFile, writeStateJsonFile } from "./stateJsonFile.ts";

const THREAD_REDO_DIRECTORY = "thread-redo";
const MAX_REDO_STACK_DEPTH = 20;

const ThreadRedoEntry = Schema.Struct({
  createdAt: IsoDateTime,
  state: OrchestrationThreadRestoreStateSchema,
});

const ThreadRedoStack = Schema.Struct({
  entries: Schema.Array(ThreadRedoEntry),
});

function getThreadRedoPath(stateDir: string, threadId: ThreadId): string {
  return path.join(stateDir, THREAD_REDO_DIRECTORY, `${threadId}.json`);
}

function readRedoStack(stateDir: string, threadId: ThreadId): typeof ThreadRedoStack.Type {
  return readStateJsonFile({
    filePath: getThreadRedoPath(stateDir, threadId),
    schema: ThreadRedoStack,
    fallback: { entries: [] },
  });
}

function writeRedoStack(
  stateDir: string,
  threadId: ThreadId,
  stack: typeof ThreadRedoStack.Type,
): void {
  writeStateJsonFile(getThreadRedoPath(stateDir, threadId), stack);
}

export function clearThreadRedoSnapshots(input: {
  readonly stateDir: string;
  readonly threadId: ThreadId;
}): void {
  writeRedoStack(input.stateDir, input.threadId, { entries: [] });
}

export function getThreadRedoStatus(input: {
  readonly stateDir: string;
  readonly threadId: ThreadId;
}): { available: boolean; depth: number } {
  const stack = readRedoStack(input.stateDir, input.threadId);
  return {
    available: stack.entries.length > 0,
    depth: stack.entries.length,
  };
}

export function pushThreadRedoSnapshot(input: {
  readonly stateDir: string;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly state: OrchestrationThreadRestoreState;
}): { available: boolean; depth: number } {
  const stack = readRedoStack(input.stateDir, input.threadId);
  const nextEntries = [...stack.entries, { createdAt: input.createdAt, state: input.state }].slice(
    -MAX_REDO_STACK_DEPTH,
  );
  writeRedoStack(input.stateDir, input.threadId, { entries: nextEntries });
  return {
    available: nextEntries.length > 0,
    depth: nextEntries.length,
  };
}

export function popThreadRedoSnapshot(input: {
  readonly stateDir: string;
  readonly threadId: ThreadId;
}): {
  entry: { createdAt: string; state: OrchestrationThreadRestoreState } | null;
  depth: number;
} {
  const stack = readRedoStack(input.stateDir, input.threadId);
  const entry = stack.entries.at(-1) ?? null;
  if (!entry) {
    return { entry: null, depth: 0 };
  }
  const nextEntries = stack.entries.slice(0, -1);
  writeRedoStack(input.stateDir, input.threadId, { entries: nextEntries });
  return {
    entry,
    depth: nextEntries.length,
  };
}
