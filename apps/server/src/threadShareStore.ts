import path from "node:path";

import {
  ThreadShareId,
  ThreadShareSnapshot,
  ThreadShareSummary,
  type ThreadShareSnapshot as ThreadShareSnapshotType,
  type ThreadShareSummary as ThreadShareSummaryType,
  type ThreadId,
} from "@t3tools/contracts";
import { Schema } from "effect";

import { readStateJsonFile, writeStateJsonFile } from "./stateJsonFile.ts";

const THREAD_SHARES_DIRECTORY = "thread-shares";
const THREAD_SHARES_INDEX_FILE = "index.json";
const THREAD_SHARES_RECORDS_DIRECTORY = "records";

const ThreadShareRecord = Schema.Struct({
  share: ThreadShareSummary,
  snapshot: ThreadShareSnapshot,
});

const ThreadShareIndex = Schema.Struct({
  activeShareIdByThreadId: Schema.Record(Schema.String, Schema.String),
});

function getIndexPath(stateDir: string): string {
  return path.join(stateDir, THREAD_SHARES_DIRECTORY, THREAD_SHARES_INDEX_FILE);
}

function getRecordPath(stateDir: string, shareId: string): string {
  return path.join(
    stateDir,
    THREAD_SHARES_DIRECTORY,
    THREAD_SHARES_RECORDS_DIRECTORY,
    `${shareId}.json`,
  );
}

function readIndex(stateDir: string): typeof ThreadShareIndex.Type {
  return readStateJsonFile({
    filePath: getIndexPath(stateDir),
    schema: ThreadShareIndex,
    fallback: { activeShareIdByThreadId: {} },
  });
}

function writeIndex(stateDir: string, index: typeof ThreadShareIndex.Type): void {
  writeStateJsonFile(getIndexPath(stateDir), index);
}

function readRecord(stateDir: string, shareId: string): typeof ThreadShareRecord.Type | null {
  const record = readStateJsonFile({
    filePath: getRecordPath(stateDir, shareId),
    schema: ThreadShareRecord,
    fallback: null,
  });
  return record;
}

function writeRecord(stateDir: string, record: typeof ThreadShareRecord.Type): void {
  writeStateJsonFile(getRecordPath(stateDir, record.share.shareId), record);
}

function createShareId(): ThreadShareId {
  return ThreadShareId.makeUnsafe(crypto.randomUUID().replaceAll("-", "").slice(0, 16));
}

export function getActiveThreadShare(input: {
  readonly stateDir: string;
  readonly threadId: ThreadId;
}): ThreadShareSummaryType | null {
  const index = readIndex(input.stateDir);
  const shareId = index.activeShareIdByThreadId[input.threadId];
  if (!shareId) {
    return null;
  }
  const record = readRecord(input.stateDir, shareId);
  if (!record || record.share.revokedAt !== null) {
    return null;
  }
  return record.share;
}

export function getThreadShare(input: {
  readonly stateDir: string;
  readonly shareId: ThreadShareId;
  readonly includeRevoked?: boolean;
}): { share: ThreadShareSummaryType; snapshot: ThreadShareSnapshotType } | null {
  const record = readRecord(input.stateDir, input.shareId);
  if (!record) {
    return null;
  }
  if (!input.includeRevoked && record.share.revokedAt !== null) {
    return null;
  }
  return record;
}

export function createThreadShare(input: {
  readonly stateDir: string;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly snapshot: ThreadShareSnapshotType;
  readonly createdAt: string;
}): ThreadShareSummaryType {
  const index = readIndex(input.stateDir);
  const activeShareId = index.activeShareIdByThreadId[input.threadId];
  if (activeShareId) {
    const existingRecord = readRecord(input.stateDir, activeShareId);
    if (existingRecord && existingRecord.share.revokedAt === null) {
      const revokedRecord = {
        ...existingRecord,
        share: {
          ...existingRecord.share,
          revokedAt: input.createdAt,
          updatedAt: input.createdAt,
        },
      };
      writeRecord(input.stateDir, revokedRecord);
    }
  }

  const share = Schema.decodeUnknownSync(ThreadShareSummary)({
    shareId: createShareId(),
    threadId: input.threadId,
    title: input.title,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    revokedAt: null,
  });
  writeRecord(input.stateDir, { share, snapshot: input.snapshot });
  writeIndex(input.stateDir, {
    activeShareIdByThreadId: {
      ...index.activeShareIdByThreadId,
      [input.threadId]: share.shareId,
    },
  });
  return share;
}

export function revokeThreadShare(input: {
  readonly stateDir: string;
  readonly shareId: ThreadShareId;
  readonly revokedAt: string;
}): ThreadShareSummaryType | null {
  const record = readRecord(input.stateDir, input.shareId);
  if (!record) {
    return null;
  }
  const nextRecord = {
    ...record,
    share: {
      ...record.share,
      revokedAt: input.revokedAt,
      updatedAt: input.revokedAt,
    },
  };
  writeRecord(input.stateDir, nextRecord);

  const index = readIndex(input.stateDir);
  if (index.activeShareIdByThreadId[nextRecord.share.threadId] === input.shareId) {
    const nextIndex = {
      activeShareIdByThreadId: {
        ...index.activeShareIdByThreadId,
      },
    };
    delete nextIndex.activeShareIdByThreadId[nextRecord.share.threadId];
    writeIndex(input.stateDir, nextIndex);
  }

  return nextRecord.share;
}
