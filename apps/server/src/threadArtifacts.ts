import {
  type OrchestrationProject,
  type OrchestrationThread,
  ProjectId,
  type OrchestrationThreadRestoreState,
  OrchestrationThreadRestoreState as OrchestrationThreadRestoreStateSchema,
  type OrchestrationThreadActivity,
  ThreadId,
  type ThreadShareSnapshot,
} from "@t3tools/contracts";
import { Schema } from "effect";

export const THREAD_RESUME_CONTEXT_ACTIVITY_KIND = "thread.resume-context.updated";
export const THREAD_IMPORT_ACTIVITY_KIND = "thread.imported";
export const THREAD_SKILLS_ACTIVITY_KIND = "thread.skills.applied";

const MAX_SUMMARY_MESSAGE_CHARS = 900;
const MAX_SUMMARY_PLAN_CHARS = 1_200;
const MAX_SUMMARY_FILE_COUNT = 12;

function truncateText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars - 1).trimEnd()}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown): void {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized) || target.length >= MAX_SUMMARY_FILE_COUNT) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(
  value: unknown,
  target: string[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth > 4 || target.length >= MAX_SUMMARY_FILE_COUNT) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= MAX_SUMMARY_FILE_COUNT) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const key of ["data", "item", "input", "result", "files", "changes", "edits"]) {
    if (!(key in record)) {
      continue;
    }
    collectChangedFiles(record[key], target, seen, depth + 1);
    if (target.length >= MAX_SUMMARY_FILE_COUNT) {
      return;
    }
  }
}

function collectRecentChangedFiles(thread: OrchestrationThread): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const orderedActivities = [...thread.activities].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  for (const activity of orderedActivities.toReversed()) {
    collectChangedFiles(activity.payload, files, seen, 0);
    if (files.length >= MAX_SUMMARY_FILE_COUNT) {
      break;
    }
  }
  return files;
}

function collectOpenTasks(thread: OrchestrationThread): string[] {
  const orderedActivities = [...thread.activities].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  const taskStates = new Map<string, { title: string; status: string }>();
  for (const activity of orderedActivities) {
    if (!activity.kind.startsWith("task.")) {
      continue;
    }
    const payload = asRecord(activity.payload);
    const taskId = asTrimmedString(payload?.taskId) ?? activity.id;
    const title =
      asTrimmedString(payload?.title) ?? asTrimmedString(payload?.description) ?? activity.summary;
    const status =
      activity.kind === "task.completed"
        ? "completed"
        : activity.kind === "task.failed"
          ? "failed"
          : activity.kind === "task.stopped"
            ? "stopped"
            : "running";
    taskStates.set(taskId, { title, status });
  }

  return Array.from(taskStates.values())
    .filter((task) => task.status === "running")
    .map((task) => task.title)
    .slice(0, 6);
}

function collectPendingApprovals(thread: OrchestrationThread): string[] {
  const orderedActivities = [...thread.activities].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  const pending = new Map<string, string>();
  for (const activity of orderedActivities) {
    const payload = asRecord(activity.payload);
    const requestId = asTrimmedString(payload?.requestId);
    if (!requestId) {
      continue;
    }
    if (activity.kind === "approval.requested") {
      pending.set(requestId, asTrimmedString(payload?.detail) ?? activity.summary);
      continue;
    }
    if (activity.kind === "approval.resolved") {
      pending.delete(requestId);
    }
  }
  return Array.from(pending.values()).slice(0, 6);
}

export function buildThreadRestoreState(thread: OrchestrationThread) {
  return Schema.decodeUnknownSync(OrchestrationThreadRestoreStateSchema)({
    title: thread.title,
    model: thread.model,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    messages: thread.messages,
    proposedPlans: thread.proposedPlans,
    activities: thread.activities,
    checkpoints: thread.checkpoints,
    session: null,
    updatedAt: thread.updatedAt,
  });
}

export function buildThreadShareSnapshot(input: {
  readonly thread: OrchestrationThread;
  readonly project: OrchestrationProject | null;
  readonly exportedAt: string;
}): ThreadShareSnapshot {
  return {
    version: 2,
    exportedAt: input.exportedAt,
    sourceThreadId: input.thread.id,
    sourceProjectId: input.thread.projectId,
    sourceProjectName: input.project?.title ?? null,
    state: buildThreadRestoreState(input.thread),
  };
}

export function buildThreadContinuationSummary(thread: OrchestrationThread): string {
  const latestUserMessage = thread.messages
    .toReversed()
    .find((message) => message.role === "user" && message.text.trim().length > 0);
  const latestAssistantMessage = thread.messages
    .toReversed()
    .find((message) => message.role === "assistant" && message.text.trim().length > 0);
  const latestPlan = thread.proposedPlans.toReversed()[0] ?? null;
  const openTasks = collectOpenTasks(thread);
  const pendingApprovals = collectPendingApprovals(thread);
  const recentFiles = collectRecentChangedFiles(thread);

  const sections: string[] = [
    "# Conversation Continuation Summary",
    "",
    `- Thread title: ${thread.title}`,
    `- Last updated: ${thread.updatedAt}`,
    `- Model: ${thread.model}`,
    `- Runtime mode: ${thread.runtimeMode}`,
    `- Interaction mode: ${thread.interactionMode}`,
  ];

  if (thread.branch) {
    sections.push(`- Branch: ${thread.branch}`);
  }
  if (thread.worktreePath) {
    sections.push(`- Worktree: ${thread.worktreePath}`);
  }

  sections.push("", "## Latest user request", "");
  sections.push(
    latestUserMessage
      ? truncateText(latestUserMessage.text, MAX_SUMMARY_MESSAGE_CHARS)
      : "No user request recorded.",
  );

  sections.push("", "## Latest assistant state", "");
  sections.push(
    latestAssistantMessage
      ? truncateText(latestAssistantMessage.text, MAX_SUMMARY_MESSAGE_CHARS)
      : "No assistant response recorded.",
  );

  if (latestPlan) {
    sections.push(
      "",
      "## Current plan",
      "",
      truncateText(latestPlan.planMarkdown, MAX_SUMMARY_PLAN_CHARS),
    );
  }

  if (openTasks.length > 0) {
    sections.push("", "## Open tasks", "", ...openTasks.map((task) => `- ${task}`));
  }

  if (pendingApprovals.length > 0) {
    sections.push(
      "",
      "## Pending approvals",
      "",
      ...pendingApprovals.map((detail) => `- ${truncateText(detail, 180)}`),
    );
  }

  if (recentFiles.length > 0) {
    sections.push(
      "",
      "## Recent changed files",
      "",
      ...recentFiles.map((filePath) => `- ${filePath}`),
    );
  }

  return sections.join("\n").trim();
}

export function buildThreadContinuationSummaryFromState(
  state: OrchestrationThreadRestoreState,
): string {
  return buildThreadContinuationSummary({
    id: ThreadId.makeUnsafe("restored-thread"),
    projectId: ProjectId.makeUnsafe("restored-project"),
    title: state.title,
    model: state.model,
    runtimeMode: state.runtimeMode,
    interactionMode: state.interactionMode,
    branch: state.branch,
    worktreePath: state.worktreePath,
    latestTurn: state.latestTurn,
    createdAt: state.updatedAt,
    updatedAt: state.updatedAt,
    deletedAt: null,
    messages: state.messages,
    proposedPlans: state.proposedPlans,
    activities: state.activities,
    checkpoints: state.checkpoints,
    session: state.session,
  });
}

export function parseLatestResumeContext(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): { summary: string; compactedAt: string } | null {
  const orderedActivities = [...activities].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  for (const activity of orderedActivities.toReversed()) {
    if (activity.kind !== THREAD_RESUME_CONTEXT_ACTIVITY_KIND) {
      continue;
    }
    const payload = asRecord(activity.payload);
    const summary = asTrimmedString(payload?.summary);
    if (!summary) {
      continue;
    }
    return {
      summary,
      compactedAt: asTrimmedString(payload?.compactedAt) ?? activity.createdAt,
    };
  }
  return null;
}
